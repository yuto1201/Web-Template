import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pushGitHubWorkflowBranch } from "./github-workflow-git.mjs";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const numberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nodeSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_=-]+$/u);
const branchSchema = z.string().max(200).regex(/^(?:codex|claude)\/[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const repositorySchema = z.string().max(201).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/u);
const claimSchema = z.string().regex(/^refs\/notes\/github-workflow\/[0-9a-f]{64}$/u);
const textInputSchema = z.object({ title: z.string(), body: z.string() }).strict();
const issueSchema = z.object({
  number: numberSchema, title: z.string(), body: z.string().nullable(),
  state: z.enum(["open", "closed"]), updated_at: z.iso.datetime(), html_url: z.string(),
}).passthrough();
const pullSchema = z.object({
  number: numberSchema, node_id: nodeSchema, state: z.enum(["open", "closed"]), draft: z.boolean(),
  base: z.object({ ref: z.string().min(1).max(255), repo: z.object({ full_name: repositorySchema }) }),
  head: z.object({ ref: z.string().min(1).max(255), sha: shaSchema, repo: z.object({ id: numberSchema }) }),
  title: z.string(), body: z.string().nullable(), html_url: z.string(),
});
const refSchema = z.object({ ref: z.string(), object: z.object({ type: z.literal("commit"), sha: shaSchema }) });

/** @param {unknown} detail */
function digest(detail) {
  return `sha256:${createHash("sha256").update(String(detail)).digest("hex")}`;
}

class GitHubWorkflowError extends Error {
  /** @param {unknown} detail @param {number|null} [httpStatus] */
  constructor(detail, httpStatus = null) {
    super(`GitHub workflow request failed (${digest(detail)})${httpStatus === null ? "" : `; HTTP ${httpStatus}`}.`);
    this.httpStatus = httpStatus;
  }
}

/** @template T @param {z.ZodType<T>} schema @param {unknown} value @returns {T} */
function parse(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GitHubWorkflowError(parsed.error.message);
  return parsed.data;
}

/** @param {string} text @param {boolean} singleLine */
function sanitizeText(text, singleLine) {
  let value = text.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "");
  if (singleLine) value = value.replace(/\s+/gu, " ").trim();
  if ((singleLine && !value) || value.length > (singleLine ? 256 : 65_536)) throw new GitHubWorkflowError("Text outside bounds");
  return value;
}

/**
 * Approval and postflight digests bind these exact strings: never normalize them.
 * TAB/LF/CR are supported in bodies; titles cannot contain CR/LF or be whitespace-only.
 * @param {string} text @param {boolean} title
 */
function exactContent(text, title) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text) ||
    text.length > (title ? 256 : 65_536) || (title && (!text.trim() || /[\r\n]/u.test(text)))) {
    throw new GitHubWorkflowError("Unsupported exact content");
  }
  return text;
}

/** @param {string} repository */
function repositoryPath(repository) {
  parse(repositorySchema, repository);
  if (repository.endsWith(".git") || repository.includes("..")) throw new GitHubWorkflowError("Invalid repository");
  return `repos/${repository}`;
}

/** @param {string} url @param {string} repository @param {string} kind @param {number} number */
function checkedUrl(url, repository, kind, number) {
  if (url !== `https://github.com/${repository}/${kind}/${number}`) throw new GitHubWorkflowError("Unexpected resource URL");
  return url;
}

/** @param {unknown} data @param {string} repository @param {number} [number] */
function normalizedIssue(data, repository, number) {
  const issue = parse(issueSchema, data);
  if (Object.hasOwn(issue, "pull_request") || (number !== undefined && issue.number !== number)) throw new GitHubWorkflowError("Unexpected Issue resource");
  return {
    number: issue.number, title: exactContent(issue.title, true), body: exactContent(issue.body ?? "", false),
    state: issue.state.toUpperCase(), updatedAt: issue.updated_at,
    url: checkedUrl(issue.html_url, repository, "issues", issue.number),
  };
}

/** @param {unknown} data @param {string} repository @param {number} [number] */
function normalizedPull(data, repository, number) {
  const pull = parse(pullSchema, data);
  if (pull.base.repo.full_name !== repository || (number !== undefined && pull.number !== number)) throw new GitHubWorkflowError("Unexpected PR resource");
  return {
    number: pull.number, nodeId: pull.node_id, state: pull.state.toUpperCase(), draft: pull.draft,
    baseBranch: pull.base.ref, branch: pull.head.ref, headSha: pull.head.sha, headRepositoryId: pull.head.repo.id,
    title: exactContent(pull.title, true), body: exactContent(pull.body ?? "", false),
    url: checkedUrl(pull.html_url, repository, "pull", pull.number),
  };
}

/** @param {unknown} input */
function textPayload(input) {
  const { title, body } = parse(textInputSchema, input);
  return { title: exactContent(title, true), body: exactContent(body, false) };
}

/** Start with an allowlist: no debug, proxy, alternate token, prompt, or tool overrides. */
function cliEnvironment() {
  /** @type {Record<string, string | undefined>} */
  const env = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "XDG_CONFIG_HOME", "GH_CONFIG_DIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, NODE_ENV: /** @type {const} */ ("production"), GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1", LC_ALL: "C" };
}

/**
 * Fixed production client: no injected observations, endpoints, credentials, or commands.
 * Authentication is captured once and shared by REST, GraphQL and the isolated Git push.
 */
export function createGitHubWorkflowClient() {
  const environment = cliEnvironment();
  /** @type {string} */
  let token;
  try {
    const result = spawnSync("gh", ["auth", "token", "--hostname", "github.com"], {
      env: environment, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 16_384,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.status !== 0 || result.error || result.signal) throw new GitHubWorkflowError(`${result.error?.message}:${result.stdout}:${result.stderr}`);
    token = parse(z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/u), result.stdout.trim());
  } catch (error) {
    throw new GitHubWorkflowError(error instanceof Error ? error.message : error);
  }

  /** @param {string} endpoint @param {"GET"|"POST"|"PATCH"} [method] @param {Record<string, unknown>} [payload] */
  function api(endpoint, method = "GET", payload) {
    try {
      const args = ["api", "--hostname", "github.com", "--include", "--method", method, endpoint,
        "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2022-11-28"];
      if (payload !== undefined) args.push("--input", "-");
      const result = spawnSync("gh", args, {
        env: { ...environment, GH_TOKEN: token }, encoding: "utf8", windowsHide: true,
        input: payload === undefined ? undefined : JSON.stringify(payload),
        timeout: 60_000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
      });
      const match = /^HTTP\/\d(?:\.\d)? (\d{3})[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/u.exec(result.stdout ?? "");
      const status = match ? Number(match[1]) : null;
      if (result.error || result.signal || result.status === null || result.status !== 0 || status === null || status < 200 || status >= 300) {
        // A killed/timed-out request has no trustworthy absence status.
        throw new GitHubWorkflowError(`${result.error?.message}:${result.status}:${result.stdout}:${result.stderr}`, result.error || result.signal || result.status === null ? null : status);
      }
      if (!match) throw new GitHubWorkflowError("Missing HTTP response");
      const data = /** @type {unknown} */ (JSON.parse(match[3]));
      const encoded = JSON.stringify(data);
      if (encoded.includes(token) || encoded.includes(Buffer.from(`x-access-token:${token}`).toString("base64"))) {
        throw new GitHubWorkflowError("Provider reflected authentication material");
      }
      return { data, status, hasNext: /^link:.*rel="?next"?/imu.test(match[2]) };
    } catch (error) {
      if (error instanceof GitHubWorkflowError) throw error;
      throw new GitHubWorkflowError(error instanceof Error ? error.message : error);
    }
  }

  return {
    /** @param {string} repository */
    async observe(repository) {
      const endpoint = repositoryPath(repository);
      const user = parse(z.object({ login: z.string().min(1).max(39).regex(/^[A-Za-z0-9-]+$/u), id: numberSchema, node_id: nodeSchema }), api("user").data);
      const repo = parse(z.object({ owner: z.object({ login: z.string() }), name: z.string(), id: numberSchema, node_id: nodeSchema }), api(endpoint).data);
      if (`${repo.owner.login}/${repo.name}` !== repository) throw new GitHubWorkflowError("Repository identity changed");
      const main = parse(refSchema, api(`${endpoint}/git/ref/heads/main`).data);
      if (main.ref !== "refs/heads/main") throw new GitHubWorkflowError("Unexpected default ref");
      return { account: { login: user.login, userId: user.id, nodeId: user.node_id }, target: { owner: repo.owner.login, repository: repo.name, repositoryId: repo.id, repositoryNodeId: repo.node_id }, mainSha: main.object.sha };
    },
    /** @param {string} repository @param {number} number */
    async issue(repository, number) {
      const endpoint = repositoryPath(repository);
      parse(numberSchema, number);
      return normalizedIssue(api(`${endpoint}/issues/${number}`).data, repository, number);
    },
    /** @param {string} repository */
    async listIssues(repository) {
      const result = api(`${repositoryPath(repository)}/issues?state=open&per_page=100`);
      const values = parse(z.array(z.record(z.string(), z.unknown())).max(100), result.data);
      // GitHub's Issues endpoint includes PRs; discard them without presenting them as Issues.
      const items = values.filter((value) => !Object.hasOwn(value, "pull_request")).map((value) => normalizedIssue(value, repository));
      return { items, complete: values.length < 100 && !result.hasNext };
    },
    /** @param {string} repository @param {string} branch */
    async branch(repository, branch) {
      const endpoint = repositoryPath(repository);
      parse(branchSchema, branch);
      try {
        const result = parse(refSchema, api(`${endpoint}/git/ref/heads/${branch}`).data);
        if (result.ref !== `refs/heads/${branch}`) throw new GitHubWorkflowError("Unexpected branch ref");
        return result.object.sha;
      } catch (error) {
        if (error instanceof GitHubWorkflowError && error.httpStatus === 404) return null;
        throw error;
      }
    },
    /** @param {string} repository @param {number} number */
    async pull(repository, number) {
      const endpoint = repositoryPath(repository);
      parse(numberSchema, number);
      return normalizedPull(api(`${endpoint}/pulls/${number}`).data, repository, number);
    },
    /** @param {string} repository @param {string} branch */
    async findPull(repository, branch) {
      const endpoint = repositoryPath(repository);
      parse(branchSchema, branch);
      const head = encodeURIComponent(`${repository.split("/")[0]}:${branch}`);
      const result = api(`${endpoint}/pulls?state=open&base=main&head=${head}&per_page=100`);
      const items = parse(z.array(z.unknown()).max(100), result.data).map((value) => normalizedPull(value, repository));
      if (items.some((item) => item.state !== "OPEN" || item.baseBranch !== "main" || item.branch !== branch)) throw new GitHubWorkflowError("Unexpected PR search result");
      return { items, complete: items.length < 100 && !result.hasNext };
    },
    /** @param {string} repository @param {string} headSha */
    async checks(repository, headSha) {
      const endpoint = repositoryPath(repository);
      parse(shaSchema, headSha);
      const runsResult = api(`${endpoint}/commits/${headSha}/check-runs?per_page=100&filter=latest`);
      const runs = parse(z.object({ total_count: z.number().int().nonnegative(), check_runs: z.array(z.object({
        name: z.string().min(1).max(256), status: z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]),
        conclusion: z.enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"]).nullable(), head_sha: shaSchema,
      })).max(100) }), runsResult.data);
      if (runs.total_count < runs.check_runs.length || runs.check_runs.some((run) => run.head_sha !== headSha || (run.status === "completed") !== (run.conclusion !== null))) throw new GitHubWorkflowError("Invalid check-run evidence");
      const statusesResult = api(`${endpoint}/commits/${headSha}/status?per_page=100`);
      const statuses = parse(z.object({ sha: shaSchema, total_count: z.number().int().nonnegative(), statuses: z.array(z.object({ context: z.string().min(1).max(256), state: z.enum(["error", "failure", "pending", "success"]) })).max(100) }), statusesResult.data);
      if (statuses.sha !== headSha || statuses.total_count < statuses.statuses.length) throw new GitHubWorkflowError("Invalid status evidence");
      return {
        headSha,
        checkRuns: runs.check_runs.map((run) => ({ name: sanitizeText(run.name, true), status: run.status, conclusion: run.conclusion })),
        statuses: statuses.statuses.map((status) => ({ context: sanitizeText(status.context, true), state: status.state })),
        complete: runs.total_count === runs.check_runs.length && statuses.total_count === statuses.statuses.length && runs.check_runs.length < 100 && statuses.statuses.length < 100 && !runsResult.hasNext && !statusesResult.hasNext,
      };
    },
    /** @param {string} repository @param {string} ref @param {string} mainSha */
    async claim(repository, ref, mainSha) {
      const endpoint = repositoryPath(repository);
      parse(claimSchema, ref);
      parse(shaSchema, mainSha);
      const response = api(`${endpoint}/git/refs`, "POST", { ref, sha: mainSha });
      if (response.status !== 201) throw new GitHubWorkflowError("Claim creation is not confirmed");
      const result = parse(refSchema, response.data);
      if (result.ref !== ref || result.object.sha !== mainSha) throw new GitHubWorkflowError("Claim response is not owned");
      return { ref, sha: mainSha };
    },
    /** @param {string} repository @param {{title:string,body:string}} input */
    async createIssue(repository, input) {
      return normalizedIssue(api(`${repositoryPath(repository)}/issues`, "POST", textPayload(input)).data, repository);
    },
    /** @param {string} repository @param {{branch:string,title:string,body:string}} input */
    async createPull(repository, input) {
      const endpoint = repositoryPath(repository);
      const value = parse(textInputSchema.extend({ branch: branchSchema }), input);
      const payload = { head: value.branch, base: "main", draft: true, maintainer_can_modify: false, ...textPayload({ title: value.title, body: value.body }) };
      const pull = normalizedPull(api(`${endpoint}/pulls`, "POST", payload).data, repository);
      if (pull.state !== "OPEN" || !pull.draft || pull.baseBranch !== "main" || pull.branch !== value.branch) throw new GitHubWorkflowError("Unexpected created PR");
      return pull;
    },
    /** @param {string} repository @param {number} number @param {{title:string,body:string}} input */
    async updatePull(repository, number, input) {
      const endpoint = repositoryPath(repository);
      parse(numberSchema, number);
      return normalizedPull(api(`${endpoint}/pulls/${number}`, "PATCH", textPayload(input)).data, repository, number);
    },
    /** @param {string} repository @param {string} nodeId */
    async readyPull(repository, nodeId) {
      repositoryPath(repository);
      parse(nodeSchema, nodeId);
      const query = "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id isDraft } } }";
      const response = parse(z.object({ data: z.object({ markPullRequestReadyForReview: z.object({ pullRequest: z.object({ id: nodeSchema, isDraft: z.literal(false) }) }) }) }).strict(), api("graphql", "POST", { query, variables: { id: nodeId } }).data);
      if (response.data.markPullRequestReadyForReview.pullRequest.id !== nodeId) throw new GitHubWorkflowError("Unexpected ready PR");
      return { nodeId, draft: /** @type {const} */ (false) };
    },
    /** @param {{root:string,repository:string,branch:string,expectedHeadSha:string|null,headSha:string}} input */
    async push(input) {
      const value = parse(z.object({ root: z.string().min(1), repository: repositorySchema, branch: branchSchema, expectedHeadSha: shaSchema.nullable(), headSha: shaSchema }).strict(), input);
      repositoryPath(value.repository);
      return pushGitHubWorkflowBranch({ ...value, token });
    },
  };
}
