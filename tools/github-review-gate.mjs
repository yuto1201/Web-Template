import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const shaPattern = /^[0-9a-f]{40}$/u;

/** @param {unknown} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {string} body @param {string} label */
function uniqueBodyField(body, label) {
  const prefix = `- ${label}:`;
  const matches = body.split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  assert(matches.length === 1, `PR body must contain ${label} exactly once.`);
  return matches[0].slice(prefix.length).trim();
}

/** @param {string} body */
function parseReviewBody(body) {
  const headings = [...body.matchAll(/^## Opposite-model review\s*$/gimu)];
  assert(headings.length === 1, "PR body must contain the Opposite-model review section exactly once.");
  const start = (headings[0].index ?? 0) + headings[0][0].length;
  const tail = body.slice(start);
  const end = tail.search(/^##\s+/mu);
  const section = end === -1 ? tail : tail.slice(0, end);
  assert(!section.includes("```"), "Review evidence must not be inside a fenced code block.");
  assert(!section.includes("<!--") && !section.includes("-->"), "Review evidence must not be inside an HTML comment.");
  for (const label of ["Primary", "Reviewer", "Reviewed SHA", "Verdict", "Contracts"]) {
    assert(section.split(/\r?\n/u).filter((line) => line.startsWith(`- ${label}:`)).length === 1, `${label} must appear inside the review section.`);
  }
  const primary = uniqueBodyField(body, "Primary");
  const reviewer = uniqueBodyField(body, "Reviewer");
  const reviewedShaValue = uniqueBodyField(body, "Reviewed SHA");
  const verdict = uniqueBodyField(body, "Verdict");
  const contractsValue = uniqueBodyField(body, "Contracts");
  const reviewedSha = /^`([0-9a-f]{40})`$/u.exec(reviewedShaValue)?.[1];
  assert(reviewedSha, "Reviewed SHA must be one backtick-wrapped 40-character lowercase SHA.");
  assert(["codex", "claude"].includes(primary), "Primary model must be codex or claude.");
  assert(["codex", "claude"].includes(reviewer), "Reviewer model must be codex or claude.");
  assert(verdict === "approved", "Opposite-model review verdict must be approved.");
  const contracts = contractsValue.split(",").map((value) => value.trim()).filter(Boolean);
  assert(contracts.length > 0 && new Set(contracts).size === contracts.length, "Review contracts must be a unique non-empty list.");
  return { primary, reviewer, reviewedSha, verdict, contracts };
}

/** @param {string[]} changedPaths @param {any} workflow */
function requiredContracts(changedPaths, workflow) {
  const required = new Set(["change-evaluator"]);
  for (const candidate of changedPaths) {
    assert(candidate && !candidate.includes("\\") && !candidate.startsWith("/") && !candidate.split("/").includes(".."), "Changed paths must be canonical repository-relative paths.");
    const normalized = candidate.toLowerCase();
    for (const rule of workflow.privilegedPathRules ?? []) {
      const rulePath = String(rule.path).toLowerCase();
      const matches = rule.type === "exact" ? normalized === rulePath : normalized.startsWith(rulePath);
      if (matches) for (const contract of rule.contracts ?? []) required.add(contract);
    }
  }
  return [...required].sort();
}

/** @param {string} diff @param {any} policy */
function validateDependabotDiff(diff, policy) {
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const added = [];
  for (const line of diff.split(/\r?\n/u)) {
    if (!line || line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("@@ ") || line.startsWith(" ")) continue;
    if (line.startsWith("--- a/") || line.startsWith("+++ b/") || line === "--- /dev/null" || line === "+++ /dev/null") continue;
    if (!line.startsWith("+") && !line.startsWith("-")) throw new Error("Dependabot diff contains an unsupported metadata line.");
    const match = /^\s*uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s#]+)\s*(?:#.*)?$/u.exec(line.slice(1));
    if (!match) throw new Error("Dependabot exception permits version-only uses: changes.");
    const [, action, version] = match;
    assert(policy.allowedActions.includes(action), `Dependabot action ${action} is not allowlisted.`);
    assert(/^(?:v?\d+(?:\.\d+){0,2}|[0-9a-f]{40})$/u.test(version), "Dependabot action ref must be a version or full commit SHA.");
    (line.startsWith("+") ? added : removed).push(action);
  }
  assert(added.length > 0 && added.length === removed.length, "Dependabot diff must replace at least one action version.");
  assert(added.toSorted().join("\n") === removed.toSorted().join("\n"), "Dependabot diff must preserve action identities.");
}

/**
 * @param {{event: any, changedPaths: string[], diff: string, workflow: any}} input
 */
export function evaluateGitHubReviewGate({ event, changedPaths, diff, workflow }) {
  const pullRequest = event?.pull_request;
  assert(pullRequest && typeof pullRequest === "object", "GitHub event must contain a pull_request object.");
  const headSha = pullRequest.head?.sha;
  assert(typeof headSha === "string" && shaPattern.test(headSha), "Pull request Head SHA is invalid.");
  assert(Array.isArray(changedPaths) && changedPaths.length > 0, "Pull request must contain at least one changed path.");

  const policy = workflow.githubReviewGate?.dependabot;
  if (pullRequest.user?.login === policy?.login) {
    assert(pullRequest.user.id === policy.userId && pullRequest.user.type === policy.userType, "Dependabot identity does not match the pinned GitHub bot.");
    assert(pullRequest.head?.repo?.full_name === pullRequest.base?.repo?.full_name, "Dependabot exception requires a same repository branch.");
    assert(String(pullRequest.head?.ref ?? "").startsWith(policy.headPrefix), "Dependabot exception requires a GitHub Actions branch.");
    assert(changedPaths.every((candidate) => policy.allowedPathPrefixes.some(/** @param {string} prefix */ (prefix) => candidate.startsWith(prefix)) && /\.ya?ml$/u.test(candidate)), "Dependabot exception permits only allowed workflow paths.");
    validateDependabotDiff(diff, policy);
    return { ok: true, mode: "dependabot-github-actions", headSha };
  }

  const evidence = parseReviewBody(String(pullRequest.body ?? ""));
  assert(evidence.reviewedSha === headSha, "Reviewed SHA must match the current Head SHA.");
  assert(workflow.reviewerMap?.[evidence.primary] === evidence.reviewer, "Reviewer must be the configured opposite model.");
  const required = requiredContracts(changedPaths, workflow);
  for (const contract of required) assert(evidence.contracts.includes(contract), `Review evidence is missing required contract ${contract}.`);
  return { ok: true, mode: "independent-review", headSha, reviewer: evidence.reviewer, contracts: required };
}

/** @param {string[]} argv */
export async function runCli(argv = process.argv.slice(2)) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value.startsWith("--") && next && !next.startsWith("--")) options[value.slice(2)] = next;
  }
  const eventPath = options.event ?? process.env.GITHUB_EVENT_PATH;
  assert(eventPath, "Missing GitHub event path.");
  const repository = path.resolve(options.repository ?? ".");
  const workflowPath = path.resolve(options.workflow ?? path.join(repository, "config", "workflow.json"));
  const baseSha = options.base;
  const headSha = options.head;
  assert(baseSha && shaPattern.test(baseSha), "Missing or invalid --base SHA.");
  assert(headSha && shaPattern.test(headSha), "Missing or invalid --head SHA.");
  /** @param {string[]} args */
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0 || result.error) throw new Error(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`.trim());
    return result.stdout;
  };
  /** @param {string[]} args */
  const gitBuffer = (...args) => {
    const result = spawnSync("git", args, { cwd: repository, encoding: null, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0 || result.error || !Buffer.isBuffer(result.stdout)) throw new Error(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr?.toString("utf8") ?? "unknown error"}`.trim());
    return result.stdout;
  };
  const workflow = JSON.parse(await readFile(workflowPath, "utf8"));
  const event = JSON.parse(await readFile(path.resolve(eventPath), "utf8"));
  assert(event.pull_request?.base?.sha === baseSha, "CLI base SHA must match the GitHub event.");
  assert(event.pull_request?.head?.sha === headSha, "CLI Head SHA must match the GitHub event.");
  const changedPaths = gitBuffer("-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", baseSha, headSha, "--").toString("utf8").split("\0").filter(Boolean);
  const diff = git("diff", "--unified=0", "--no-ext-diff", "--no-textconv", "--no-renames", baseSha, headSha, "--");
  process.stdout.write(`${JSON.stringify(evaluateGitHubReviewGate({ event, changedPaths, diff, workflow }), null, 2)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === modulePath) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
