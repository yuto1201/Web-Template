import { spawnSync } from "node:child_process";

/** @param {string[]} args */
function invokeGitHubCli(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0 || result.error) {
    throw new Error(`GitHub CLI request failed without changing authentication: ${result.error?.message ?? String(result.stderr).trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("GitHub CLI returned non-JSON provider evidence.");
  }
}

/** @param {{invoke?: (args:string[])=>Record<string, any>, now?:()=>Date}} [configuration] */
export function createGitHubCliProviderClient(configuration = {}) {
  const invoke = configuration.invoke ?? invokeGitHubCli;
  const now = configuration.now ?? (() => new Date());
  /** @param {string} repository */
  const repositoryPath = (repository) => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("GitHub repository input is invalid.");
    return `repos/${repository}`;
  };
  return {
    service: "github",
    surface: "github-cli",
    /** @param {string} operation */
    idempotencyMode(operation) {
      if (operation === "github.merge_pr") return "provider-enforced";
      if (operation === "github.read_issue") return "not-applicable";
      return "unsupported";
    },
    /** @param {{request:Record<string, any>}} input */
    async collectObservation({ request }) {
      if (!["github.read_issue", "github.merge_pr"].includes(request.operation)) {
        throw new Error(`GitHub CLI guarded client does not implement ${request.operation}.`);
      }
      const repository = request.inputs.repository;
      const user = invoke(["api", "user"]);
      const repo = invoke(["api", repositoryPath(repository)]);
      const account = {
        login: user.login,
        userId: user.id,
        nodeId: user.node_id,
        displayName: user.name || user.login,
        createdAt: user.created_at,
        publicRepositories: user.public_repos,
        observedAt: now().toISOString(),
      };
      const target = {
        owner: repo.owner?.login,
        repository: repo.name,
        repositoryId: repo.id,
        repositoryNodeId: repo.node_id,
      };
      if (request.operation === "github.read_issue") {
        invoke(["api", `${repositoryPath(repository)}/issues/${request.inputs.issue}`]);
        return { account, target, operation: { repository, issue: request.inputs.issue } };
      }
      const pullRequest = invoke(["api", `${repositoryPath(repository)}/pulls/${request.inputs.prNumber}`]);
      return {
        account,
        target,
        operation: {
          repository,
          prNumber: pullRequest.number,
          headSha: pullRequest.head?.sha,
          method: request.inputs.method,
        },
      };
    },
    /** @param {{request:Record<string, any>,operation:string}} input */
    async execute({ request, operation }) {
      const repository = request.inputs.repository;
      if (operation === "github.read_issue") {
        const issue = invoke(["api", `${repositoryPath(repository)}/issues/${request.inputs.issue}`]);
        return {
          status: "succeeded",
          evidence: { repository, issue: request.inputs.issue, state: String(issue.state).toUpperCase(), updatedAt: issue.updated_at },
        };
      }
      if (operation !== "github.merge_pr") throw new Error(`GitHub CLI guarded client does not implement ${operation}.`);
      const merged = invoke([
        "api", "--method", "PUT", `${repositoryPath(repository)}/pulls/${request.inputs.prNumber}/merge`,
        "-f", `merge_method=${request.inputs.method}`,
        "-f", `sha=${request.inputs.headSha}`,
      ]);
      if (merged.merged !== true || !/^[0-9a-f]{40}$/u.test(String(merged.sha ?? ""))) {
        throw new Error("GitHub refused the exact-Head merge; inspect provider state before any retry.");
      }
      const issue = invoke(["api", `${repositoryPath(repository)}/issues/${request.inputs.issue}`]);
      return {
        status: "succeeded",
        evidence: {
          issue: request.inputs.issue,
          repository,
          prNumber: request.inputs.prNumber,
          headSha: request.inputs.headSha,
          method: request.inputs.method,
          mergeCommitSha: merged.sha,
          issueClosed: String(issue.state).toUpperCase() === "CLOSED",
        },
      };
    },
  };
}
