import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const receiptIdPattern = /^receipt-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const externalEvidencePathPattern = /^evidence\/external-operations\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.json$/u;
const operationServices = {
  "github.read_issue": "github",
  "github.push_branch": "github",
  "github.create_pr": "github",
  "github.merge_pr": "github",
  "github.delete_branch": "github",
  "supabase.inspect_project": "supabase",
  "supabase.apply_migrations": "supabase",
  "vercel.inspect_project": "vercel",
  "vercel.deploy_preview": "vercel",
  "vercel.deploy_production": "vercel",
  "cloudflare.inspect_zone": "cloudflare",
  "cloudflare.upsert_dns": "cloudflare",
};

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

/** @param {unknown} value @returns {unknown} */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

/** @param {unknown} value */
function digestValue(value) {
  const copy = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : value;
  if (copy && typeof copy === "object" && !Array.isArray(copy)) delete copy.digest;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(copy)), "utf8").digest("hex")}`;
}

/** @param {Record<string, unknown>} value @param {string[]} keys @param {string} label */
function exactKeys(value, keys, label) {
  assert(Object.keys(value).toSorted().join("\n") === keys.toSorted().join("\n"), `${label} must contain the exact structured lifecycle fields.`);
}

/** @param {unknown} value @param {string} label */
function record(value, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be a structured object.`);
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} value */
function containsRawEmail(value) {
  if (typeof value === "string") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  if (Array.isArray(value)) return value.some(containsRawEmail);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, child]) => /^(?:email|loginEmail|userEmail)$/iu.test(key) || containsRawEmail(child));
  }
  return false;
}

/** @param {Record<string, any>} binding @param {string} label @param {string[]} additional */
function validateLifecycleBinding(binding, label, additional = []) {
  exactKeys(binding, ["reference", "digest", ...additional], label);
  assert(externalEvidencePathPattern.test(binding.reference), `${label} reference must name committed external-operation JSON evidence.`);
  assert(digestPattern.test(binding.digest), `${label} digest is invalid.`);
}

/** @param {string} body */
function parseExternalChanges(body) {
  const headings = [...body.matchAll(/^## External changes\s*$/gimu)];
  assert(headings.length === 1, "PR body must contain the External changes section exactly once.");
  const start = (headings[0].index ?? 0) + headings[0][0].length;
  const tail = body.slice(start);
  const end = tail.search(/^##\s+/mu);
  const section = end === -1 ? tail : tail.slice(0, end);
  assertReviewSectionVisible(body, headings[0].index ?? 0, section);
  const lines = section.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1 && lines[0] === "- None.") return [];
  assert(!lines.includes("- None."), "External changes cannot combine None with operation evidence.");
  return lines.map((line) => {
    const prefix = "- Operation evidence: ";
    assert(line.startsWith(prefix), "External changes require structured Operation evidence lifecycle JSON.");
    let change;
    try {
      change = record(JSON.parse(line.slice(prefix.length)), "Operation evidence");
    } catch {
      throw new Error("Operation evidence must be valid single-line JSON.");
    }
    exactKeys(change, [
      "schemaVersion", "service", "operation", "operatorLabel", "executionRole", "modelFamily",
      "accountRef", "targetRef", "serviceMode", "exactHeadSha", "request", "preflight", "claim",
      "mutation", "result", "finalized", "outcome",
    ], "Operation evidence");
    assert(change.schemaVersion === 1, "Operation evidence schemaVersion must be 1.");
    assert(operationServices[change.operation] === change.service, "Operation evidence service does not match its registered operation.");
    assert(["codex", "claude"].includes(change.operatorLabel), "Operation evidence operator label is invalid.");
    assert(["implementer", "external-operator"].includes(change.executionRole), "Operation evidence execution role is invalid.");
    assert(["gpt", "claude"].includes(change.modelFamily), "Operation evidence model family is invalid.");
    assert(change.accountRef === `accounts.${change.service}` && change.targetRef === `resourceTargets.${change.service}`, "Operation evidence account/target refs are invalid.");
    assert(change.serviceMode === "repository-active", "Operation evidence service mode is invalid.");
    assert(shaPattern.test(change.exactHeadSha), "Operation evidence exact Head SHA is invalid.");
    assert(["succeeded", "failed", "ambiguous"].includes(change.outcome), "Operation evidence outcome is invalid.");
    for (const phase of ["request", "preflight", "claim", "mutation", "result", "finalized"]) change[phase] = record(change[phase], `${phase} lifecycle`);
    validateLifecycleBinding(change.request, "request lifecycle");
    validateLifecycleBinding(change.preflight, "preflight lifecycle", ["receiptId"]);
    validateLifecycleBinding(change.claim, "claim lifecycle", ["observationDigest"]);
    validateLifecycleBinding(change.mutation, "mutation lifecycle", ["idempotencyKeyDigest"]);
    validateLifecycleBinding(change.result, "result lifecycle", ["receiptId"]);
    validateLifecycleBinding(change.finalized, "finalized lifecycle");
    assert(receiptIdPattern.test(change.preflight.receiptId) && change.preflight.receiptId === change.result.receiptId, "Operation evidence receipt lifecycle is inconsistent.");
    assert(digestPattern.test(change.claim.observationDigest), "Operation evidence claim observation digest is invalid.");
    assert(digestPattern.test(change.mutation.idempotencyKeyDigest), "Operation evidence mutation idempotency digest is invalid.");
    const references = [change.request, change.preflight, change.claim, change.mutation, change.result, change.finalized].map(({ reference }) => reference);
    assert(new Set(references).size === references.length, "Operation evidence lifecycle references must be unique.");
    assert(!containsRawEmail(change), "Operation evidence must not contain raw email values.");
    return change;
  });
}

/** @param {string} body @param {number} headingIndex @param {string} section */
function assertReviewSectionVisible(body, headingIndex, section) {
  const prefix = body.slice(0, headingIndex);
  let fence = null;
  for (const line of prefix.split(/\r?\n/u)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (!marker) continue;
    if (!fence) fence = marker;
    else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
  }
  assert(!fence, "Review evidence must not be inside a fenced code block.");
  assert(prefix.lastIndexOf("<!--") <= prefix.lastIndexOf("-->"), "Review evidence must not be inside an HTML comment.");
  assert(!/(?:^|\n)\s{0,3}(?:`{3,}|~{3,})/u.test(section), "Review evidence must not be inside a fenced code block.");
  assert(!section.includes("<!--") && !section.includes("-->"), "Review evidence must not be inside an HTML comment.");
}

/** @param {string} body */
function parseReviewBody(body) {
  const headings = [...body.matchAll(/^## Opposite-model review\s*$/gimu)];
  assert(headings.length === 1, "PR body must contain the Opposite-model review section exactly once.");
  const start = (headings[0].index ?? 0) + headings[0][0].length;
  const tail = body.slice(start);
  const end = tail.search(/^##\s+/mu);
  const section = end === -1 ? tail : tail.slice(0, end);
  assertReviewSectionVisible(body, headings[0].index ?? 0, section);
  for (const label of ["Primary operator", "Reviewer operator", "Primary model family", "Reviewer model family", "Reviewed SHA", "Verdict", "Contracts"]) {
    assert(section.split(/\r?\n/u).filter((line) => line.startsWith(`- ${label}:`)).length === 1, `${label} must appear inside the review section.`);
  }
  const primaryOperatorLabel = uniqueBodyField(body, "Primary operator");
  const reviewerOperatorLabel = uniqueBodyField(body, "Reviewer operator");
  const primaryModelFamily = uniqueBodyField(body, "Primary model family");
  const reviewerModelFamily = uniqueBodyField(body, "Reviewer model family");
  const reviewedShaValue = uniqueBodyField(body, "Reviewed SHA");
  const verdict = uniqueBodyField(body, "Verdict");
  const contractsValue = uniqueBodyField(body, "Contracts");
  const reviewedSha = /^`([0-9a-f]{40})`$/u.exec(reviewedShaValue)?.[1];
  assert(reviewedSha, "Reviewed SHA must be one backtick-wrapped 40-character lowercase SHA.");
  assert(["codex", "claude"].includes(primaryOperatorLabel), "Primary operator label must be codex or claude.");
  assert(["codex", "claude"].includes(reviewerOperatorLabel), "Reviewer operator label must be codex or claude.");
  assert(["gpt", "claude"].includes(primaryModelFamily), "Primary model family must be gpt or claude.");
  assert(["gpt", "claude"].includes(reviewerModelFamily), "Reviewer model family must be gpt or claude.");
  assert(verdict === "approved", "Opposite-model review verdict must be approved.");
  const contracts = contractsValue.split(",").map((value) => value.trim()).filter(Boolean);
  assert(contracts.length > 0 && new Set(contracts).size === contracts.length, "Review contracts must be a unique non-empty list.");
  return { primaryOperatorLabel, reviewerOperatorLabel, primaryModelFamily, reviewerModelFamily, reviewedSha, verdict, contracts };
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
 * @param {{event: any, changedPaths: string[], diff: string, workflow: any, artifactLoader?: (reference: string) => unknown}} input
 */
export function evaluateGitHubReviewGate({ event, changedPaths, diff, workflow, artifactLoader }) {
  const pullRequest = event?.pull_request;
  assert(pullRequest && typeof pullRequest === "object", "GitHub event must contain a pull_request object.");
  const headSha = pullRequest.head?.sha;
  assert(typeof headSha === "string" && shaPattern.test(headSha), "Pull request Head SHA is invalid.");
  assert(Array.isArray(changedPaths) && changedPaths.length > 0, "Pull request must contain at least one changed path.");
  requiredContracts(changedPaths, workflow);

  const policy = workflow.githubReviewGate?.dependabot;
  if (policy && pullRequest.user?.login === policy.login) {
    assert(pullRequest.user.id === policy.userId && pullRequest.user.type === policy.userType, "Dependabot identity does not match the pinned GitHub bot.");
    assert(pullRequest.head?.repo?.full_name === pullRequest.base?.repo?.full_name, "Dependabot exception requires a same repository branch.");
    assert(String(pullRequest.head?.ref ?? "").startsWith(policy.headPrefix), "Dependabot exception requires a GitHub Actions branch.");
    assert(changedPaths.every((candidate) => policy.allowedPathPrefixes.some(/** @param {string} prefix */ (prefix) => candidate.startsWith(prefix)) && /\.ya?ml$/u.test(candidate)), "Dependabot exception permits only allowed workflow paths.");
    validateDependabotDiff(diff, policy);
    return { ok: true, mode: "dependabot-github-actions", headSha };
  }

  const evidence = parseReviewBody(String(pullRequest.body ?? ""));
  const externalChanges = parseExternalChanges(String(pullRequest.body ?? ""));
  assert(evidence.reviewedSha === headSha, "Reviewed SHA must match the current Head SHA.");
  assert(
    workflow.reviewerModelFamilyMap?.[evidence.primaryModelFamily] === evidence.reviewerModelFamily,
    "Reviewer must use the configured opposite model family.",
  );
  const required = requiredContracts(changedPaths, workflow);
  for (const contract of required) assert(evidence.contracts.includes(contract), `Review evidence is missing required contract ${contract}.`);
  const committedExternalPaths = changedPaths.filter((candidate) => candidate.startsWith("evidence/external-operations/"));
  if (externalChanges.length === 0) {
    assert(committedExternalPaths.length === 0, "Committed external-operation artifacts are missing structured external lifecycle evidence.");
  } else {
    assert(typeof artifactLoader === "function", "Structured external changes require a committed artifact loader.");
    const referencedPaths = new Set();
    for (const change of externalChanges) {
      assert(change.exactHeadSha === headSha, "External change exact Head SHA must match the current Head SHA.");
      assert(change.operatorLabel === evidence.primaryOperatorLabel && change.modelFamily === evidence.primaryModelFamily, "External change operator/model must match the reviewed primary implementation.");
      const artifacts = {};
      for (const phase of ["request", "preflight", "claim", "mutation", "result", "finalized"]) {
        const binding = change[phase];
        assert(changedPaths.includes(binding.reference), `External change ${phase} reference must be a committed changed path.`);
        referencedPaths.add(binding.reference);
        const artifact = record(artifactLoader(binding.reference), `${phase} committed artifact`);
        assert(!containsRawEmail(artifact), `External change ${phase} artifact contains raw email evidence.`);
        assert(digestValue(artifact) === binding.digest, `External change ${phase} artifact digest mismatch.`);
        artifacts[phase] = artifact;
      }
      assert(artifacts.request.operation === change.operation && artifacts.request.operatorLabel === change.operatorLabel && artifacts.request.executionRole === change.executionRole, "External change request artifact metadata mismatch.");
      assert(artifacts.preflight.receiptId === change.preflight.receiptId, "External change preflight receipt mismatch.");
      assert(artifacts.claim.observationDigest === change.claim.observationDigest, "External change claim observation mismatch.");
      assert(artifacts.mutation.idempotencyKeyDigest === change.mutation.idempotencyKeyDigest, "External change mutation idempotency mismatch.");
      assert(artifacts.result.receiptId === change.result.receiptId, "External change result receipt mismatch.");
      assert(artifacts.finalized.outcome === change.outcome, "External change finalized outcome mismatch.");
    }
    assert(committedExternalPaths.every((candidate) => referencedPaths.has(candidate)), "Committed external-operation artifact is missing from lifecycle evidence.");
  }
  return {
    ok: true,
    mode: "independent-review",
    headSha,
    reviewerOperatorLabel: evidence.reviewerOperatorLabel,
    reviewerModelFamily: evidence.reviewerModelFamily,
    externalChanges: externalChanges.length,
    contracts: required,
  };
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
  const diffBaseSha = git("merge-base", baseSha, headSha).trim();
  assert(shaPattern.test(diffBaseSha), "Git merge-base is invalid.");
  const changedPaths = gitBuffer("-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", diffBaseSha, headSha, "--").toString("utf8").split("\0").filter(Boolean);
  const diff = git("diff", "--unified=0", "--no-ext-diff", "--no-textconv", "--no-renames", diffBaseSha, headSha, "--");
  process.stdout.write(`${JSON.stringify(evaluateGitHubReviewGate({
    event,
    changedPaths,
    diff,
    workflow,
    artifactLoader: (reference) => JSON.parse(git("show", `${headSha}:${reference}`)),
  }), null, 2)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === modulePath) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
