import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyRisk,
  normalizeModelIdentity,
  parseProtectedExecutionPolicy,
  requiredReviewerFamilies,
  validateBranchForSurface,
  validateReviewerFamilies,
} from "./execution-policy.mjs";
import { parseExternalChanges, validateExternalChangesAgainstCommittedState } from "./external-change-review-gate.mjs";

const modulePath = fileURLToPath(import.meta.url);
const shaPattern = /^[0-9a-f]{40}$/u;

/** @typedef {"openai" | "anthropic" | "cursor" | "xai"} ModelFamily */
/** @typedef {"low" | "normal" | "high"} RiskLevel */
/** @typedef {Awaited<ReturnType<typeof import("./execution-policy.mjs").loadExecutionPolicy>>} ExecutionPolicy */
/** @typedef {{ type: string, path: string, contracts: string[] }} PrivilegedPathRule */
/**
 * @typedef DependabotPolicy
 * @property {number} userId
 * @property {string} login
 * @property {string} userType
 * @property {string} headPrefix
 * @property {string[]} allowedActions
 * @property {string[]} allowedPathPrefixes
 */
/**
 * @typedef WorkflowPolicy
 * @property {PrivilegedPathRule[]} [privilegedPathRules]
 * @property {{ dependabot?: DependabotPolicy }} [githubReviewGate]
 */
/**
 * @typedef GitHubPullRequest
 * @property {unknown} [body]
 * @property {{ sha?: unknown, ref?: unknown, repo?: { full_name?: unknown } }} [head]
 * @property {{ sha?: unknown, repo?: { full_name?: unknown } }} [base]
 * @property {{ login?: unknown, id?: unknown, type?: unknown }} [user]
 */

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {string} value @returns {value is "codex-local" | "claude-local" | "cursor-cloud"} */
function isExecutionSurface(value) {
  return value === "codex-local" || value === "claude-local" || value === "cursor-cloud";
}

/** @param {string} value @returns {value is ModelFamily} */
function isModelFamily(value) {
  return value === "openai" || value === "anthropic" || value === "cursor" || value === "xai";
}

/** @param {string} value @returns {value is RiskLevel} */
function isRiskLevel(value) {
  return value === "low" || value === "normal" || value === "high";
}

/** @param {unknown} value @returns {value is GitHubPullRequest} */
function isGitHubPullRequest(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {string} body @param {string} section @param {string} label */
function uniqueBodyField(body, section, label) {
  const prefix = `- ${label}:`;
  const matches = body.split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  assert(matches.length === 1, `PR body must contain ${label} exactly once.`);
  assert(section.split(/\r?\n/u).includes(matches[0]), `${label} must appear inside the review section.`);
  const value = matches[0].slice(prefix.length).trim();
  assert(value && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value), `${label} must be a single non-empty line.`);
  return value;
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
  const htmlContainerPattern = /<\/?(?:details|div)\b[^>]*>/giu;
  const openContainers = [];
  const prefixWithoutComments = prefix.replace(/<!--[\s\S]*?-->/gu, "");
  for (const match of prefixWithoutComments.matchAll(htmlContainerPattern)) {
    const tag = /^<\/(details|div)\b/iu.exec(match[0])?.[1]?.toLowerCase();
    if (tag) {
      assert(openContainers.at(-1) === tag, "Review evidence must not be inside a raw HTML container.");
      openContainers.pop();
    } else {
      const opening = /^<(details|div)\b/iu.exec(match[0])?.[1]?.toLowerCase();
      if (opening) openContainers.push(opening);
    }
  }
  assert(openContainers.length === 0, "Review evidence must not be inside a raw HTML container.");
  assert(!htmlContainerPattern.test(section), "Review evidence must not contain raw HTML containers.");
}

/** @param {string} value @param {string} label @param {RegExp} itemPattern */
function parseCanonicalList(value, label, itemPattern) {
  const items = value.split(", ");
  assert(items.length > 0 && items.every((item) => itemPattern.test(item)), `${label} must be a canonical comma-separated list.`);
  assert(value === items.join(", ") && new Set(items).size === items.length, `${label} must be a unique canonical comma-separated list.`);
  return items;
}

/** @param {string[]} values */
function sorted(values) {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

/** @param {string} body */
export function parseReviewBody(body) {
  assert(typeof body === "string", "PR body must be text.");
  const headings = [...body.matchAll(/^## Cross-model review[ \t]*$/gmu)];
  assert(headings.length === 1, "PR body must contain the Cross-model review section exactly once.");
  const start = (headings[0].index ?? 0) + headings[0][0].length;
  const tail = body.slice(start);
  const end = tail.search(/^##\s+/mu);
  const section = end === -1 ? tail : tail.slice(0, end);
  assertReviewSectionVisible(body, headings[0].index ?? 0, section);
  const issueClaims = [...body.matchAll(/^Closes #([1-9][0-9]*)[ \t]*$/gmu)];
  assert(issueClaims.length === 1, "PR body must contain exactly one canonical Closes Issue claim.");
  assertReviewSectionVisible(body, issueClaims[0].index ?? 0, "");
  const issue = Number(issueClaims[0][1]);

  const labels = [
    "Execution surface",
    "Primary operator label",
    "Primary configured model",
    "Primary observed model",
    "Primary family",
    "Primary fallback",
    "Risk",
    "Risk reasons",
    "Reviewed SHA",
  ];
  const knownPrefixes = labels.map((label) => `- ${label}:`);
  for (const line of section.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (knownPrefixes.some((prefix) => line.startsWith(prefix)) || /^- Reviewer [a-z][a-z0-9-]*:/u.test(line)) continue;
    throw new Error("Cross-model review contains an unknown review field or newline injection.");
  }

  const executionSurface = uniqueBodyField(body, section, "Execution surface");
  const primaryOperatorLabel = uniqueBodyField(body, section, "Primary operator label");
  const primaryConfigured = uniqueBodyField(body, section, "Primary configured model");
  const primaryObserved = uniqueBodyField(body, section, "Primary observed model");
  const primaryFamily = uniqueBodyField(body, section, "Primary family");
  const primaryFallbackValue = uniqueBodyField(body, section, "Primary fallback");
  const riskLevel = uniqueBodyField(body, section, "Risk");
  const riskReasonsValue = uniqueBodyField(body, section, "Risk reasons");
  const reviewedShaValue = uniqueBodyField(body, section, "Reviewed SHA");

  assert(isExecutionSurface(executionSurface), "Execution surface is unknown.");
  assert(primaryOperatorLabel === "codex" || primaryOperatorLabel === "claude", "Primary operator label must be codex or claude.");
  const modelPattern = /^[a-z0-9][a-z0-9._-]*(?:\[[a-z0-9._=-]+\])?$/u;
  assert(modelPattern.test(primaryConfigured), "Primary configured model must be one canonical model identifier.");
  assert(modelPattern.test(primaryObserved), "Primary observed model must be one canonical model identifier.");
  assert(isModelFamily(primaryFamily), "Primary model family is unknown.");
  assert(["true", "false"].includes(primaryFallbackValue), "Primary fallback must be true or false.");
  assert(isRiskLevel(riskLevel), "Risk must be low, normal, or high.");
  const riskReasons = riskReasonsValue === "none"
    ? []
    : parseCanonicalList(riskReasonsValue, "Risk reasons", /^(?:path:[A-Za-z0-9._/-]+|operation:[a-z0-9._-]+)$/u);
  const reviewedSha = /^`([0-9a-f]{40})`$/u.exec(reviewedShaValue)?.[1];
  assert(reviewedSha, "Reviewed SHA must be one backtick-wrapped 40-character lowercase SHA.");

  const bodyReviewLines = body.split(/\r?\n/u).filter((line) => /^- Reviewer [a-z][a-z0-9-]*:/u.test(line));
  const reviewLines = section.split(/\r?\n/u).filter((line) => /^- Reviewer [a-z][a-z0-9-]*:/u.test(line));
  assert(bodyReviewLines.length === reviewLines.length, "Reviewer claims must appear only inside the review section.");
  const reviews = reviewLines.map((line) => {
    const match = /^- Reviewer ([a-z][a-z0-9-]*): ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| (.+)$/u.exec(line);
    assert(match, "Reviewer evidence must use the canonical configured | observed | family | fallback | verdict | contracts format without ambiguity or newline injection.");
    const [, family, configuredValue, observedValue, claimedFamilyValue, fallbackValue, verdictValue, contractsValue] = match;
    const configured = configuredValue.trim();
    const observed = observedValue.trim();
    const claimedFamily = claimedFamilyValue.trim();
    const fallback = fallbackValue.trim();
    const verdict = verdictValue.trim();
    assert(isModelFamily(family), `unknown reviewer model family ${family}.`);
    assert(claimedFamily === family, `mismatched reviewer model family ${family}.`);
    assert(modelPattern.test(configured), "Reviewer configured model must be one canonical model identifier.");
    assert(modelPattern.test(observed), "Reviewer observed model must be one canonical model identifier.");
    assert(["true", "false"].includes(fallback), "Reviewer fallback must be true or false.");
    assert(verdict === "approved", "Cross-model review verdict must be approved.");
    const contracts = parseCanonicalList(contractsValue, "Review contracts", /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    return { family, configured, observed, fallback: fallback === "true", verdict, contracts };
  });
  assert(new Set(reviews.map(({ family }) => family)).size === reviews.length, "Reviewer families must be unique.");
  const contracts = reviews.length === 0
    ? []
    : sorted(reviews[0].contracts.filter((contract) => reviews.every((review) => review.contracts.includes(contract))));
  return {
    issue,
    executionSurface,
    primaryOperatorLabel,
    primaryModel: {
      configured: primaryConfigured,
      observed: primaryObserved,
      family: primaryFamily,
      fallback: primaryFallbackValue === "true",
    },
    risk: { level: riskLevel, reasons: riskReasons },
    reviews,
    reviewedSha,
    contracts,
  };
}

/** @param {string[]} changedPaths @param {WorkflowPolicy} workflow */
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

/** @param {string} diff @param {DependabotPolicy} policy */
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

/** @param {string} body @param {string[]} changedPaths @param {ExecutionPolicy} executionPolicy */
export function deriveReviewRisk(body, changedPaths, executionPolicy) {
  const externalOperations = parseExternalChanges(body).map(({ operation }) => operation);
  return classifyRisk({ changedPaths, externalOperations }, executionPolicy);
}

/**
 * @param {{event: unknown, changedPaths: string[], diff: string, workflow: WorkflowPolicy, executionPolicy?: ExecutionPolicy, artifactLoader?: (reference: string) => unknown, authorityLoader?: (commitSha: string) => unknown, evidenceCommit?: {headSha:string,parentSha:string,changedPaths:string[]}, isAuthorityProtected?: (authorityCommitSha:string)=>boolean}} input
 */
export function evaluateGitHubReviewGate({ event, changedPaths, diff, workflow, executionPolicy, artifactLoader, authorityLoader, evidenceCommit, isAuthorityProtected }) {
  const pullRequest = event && typeof event === "object" && "pull_request" in event
    ? event.pull_request
    : null;
  assert(isGitHubPullRequest(pullRequest), "GitHub event must contain a pull_request object.");
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
  const externalChanges = validateExternalChangesAgainstCommittedState({
    body: String(pullRequest.body ?? ""),
    changedPaths,
    headSha,
    primaryOperatorLabel: evidence.primaryOperatorLabel,
    primaryModelFamily: evidence.primaryModel.family,
    artifactLoader,
    authorityLoader,
    evidenceCommit,
    isAuthorityProtected,
  });
  assert(pullRequest.head?.repo?.full_name === pullRequest.base?.repo?.full_name, "Independent review requires a same repository branch.");
  assert(evidence.reviewedSha === headSha, "Reviewed SHA must match the current Head SHA.");
  assert(executionPolicy && typeof executionPolicy === "object", "Execution policy is required for independent review.");
  const trustedExecutionPolicy = parseProtectedExecutionPolicy(executionPolicy);
  assert(typeof pullRequest.head?.ref === "string", "Pull request Head branch is required.");
  validateBranchForSurface(pullRequest.head.ref, evidence.issue, evidence.executionSurface, trustedExecutionPolicy);
  const allowedOperations = new Set([
    ...(trustedExecutionPolicy.routineDeliveryOperations ?? []),
    ...(trustedExecutionPolicy.highRiskOperations ?? []),
  ]);
  for (const reason of evidence.risk.reasons.filter((value) => value.startsWith("operation:"))) {
    const operation = reason.slice("operation:".length);
    assert(allowedOperations.has(operation), `unknown operation risk reason ${operation}.`);
  }
  const allowedContracts = new Set(["change-evaluator"]);
  for (const rule of workflow.privilegedPathRules ?? []) {
    for (const contract of rule.contracts ?? []) allowedContracts.add(contract);
  }
  for (const review of evidence.reviews) {
    for (const contract of review.contracts) assert(allowedContracts.has(contract), `unknown review contract ${contract}.`);
  }
  const primaryModel = normalizeModelIdentity(
    evidence.primaryModel.configured,
    evidence.primaryModel.observed,
    [],
    trustedExecutionPolicy,
  );
  assert(primaryModel.family === evidence.primaryModel.family, "Primary model family must match the observed model.");
  assert(primaryModel.fallback === evidence.primaryModel.fallback, "Primary fallback claim must match the configured and observed models.");
  assert(!primaryModel.fallback, "Primary model fallback cannot satisfy review policy.");
  for (const review of evidence.reviews) {
    const reviewerModel = normalizeModelIdentity(review.configured, review.observed, [], trustedExecutionPolicy);
    assert(reviewerModel.family === review.family, `unknown or mismatched reviewer model family ${review.family}.`);
    assert(reviewerModel.fallback === review.fallback, `Reviewer fallback claim must match configured and observed model IDs for ${review.family}.`);
    assert(!reviewerModel.fallback, `Reviewer model fallback cannot satisfy review policy for ${review.family}.`);
    if (evidence.executionSurface === "cursor-cloud" && (review.family === "openai" || review.family === "anthropic")) {
      assert(review.configured === trustedExecutionPolicy.cursorModels[review.family], `Reviewer configured reviewer model must match trusted Cursor policy for ${review.family}.`);
    }
  }
  const derivedRisk = deriveReviewRisk(String(pullRequest.body ?? ""), changedPaths, trustedExecutionPolicy);
  assert(
    JSON.stringify(evidence.risk) === JSON.stringify(derivedRisk),
    "Risk claim must match protected derived risk and cannot reduce it.",
  );
  if (evidence.risk.level === "normal") {
    assert(evidence.risk.reasons.length === 0, "Normal risk evidence cannot contain risk reasons.");
  } else {
    assert(evidence.risk.reasons.length > 0, `${evidence.risk.level === "low" ? "Low" : "High"} risk evidence must contain at least one risk reason.`);
    for (const reason of evidence.risk.reasons.filter((value) => value.startsWith("path:"))) {
      assert(derivedRisk.reasons.includes(reason), `Claimed path risk reason ${reason} was not derived from changed paths.`);
    }
  }
  const effectiveRisk = evidence.risk.level;
  const reviewerFamilies = evidence.reviews.map(({ family }) => family);
  const validatedFamilies = validateReviewerFamilies({
    risk: effectiveRisk,
    primaryFamily: primaryModel.family,
    reviewerFamilies,
  });
  const requiredFamilies = requiredReviewerFamilies({ risk: effectiveRisk, primaryFamily: primaryModel.family });
  assert(JSON.stringify(validatedFamilies) === JSON.stringify(sorted(requiredFamilies)), "Review evidence must contain exactly the required reviewer families.");
  const required = requiredContracts(changedPaths, workflow);
  for (const review of evidence.reviews) {
    for (const contract of required) assert(review.contracts.includes(contract), `Review evidence is missing required contract ${contract} for reviewer ${review.family}.`);
  }
  return { ok: true, mode: "independent-review", headSha, reviewers: validatedFamilies, risk: effectiveRisk, contracts: required, externalChanges };
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
  const executionPolicyPath = path.resolve(options["execution-policy"] ?? path.join(path.dirname(workflowPath), "execution.json"));
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
  const executionPolicy = JSON.parse(await readFile(executionPolicyPath, "utf8"));
  const event = JSON.parse(await readFile(path.resolve(eventPath), "utf8"));
  assert(event.pull_request?.base?.sha === baseSha, "CLI base SHA must match the GitHub event.");
  assert(event.pull_request?.head?.sha === headSha, "CLI Head SHA must match the GitHub event.");
  const diffBaseSha = git("merge-base", baseSha, headSha).trim();
  assert(shaPattern.test(diffBaseSha), "Git merge-base is invalid.");
  const changedPaths = gitBuffer("-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", diffBaseSha, headSha, "--").toString("utf8").split("\0").filter(Boolean);
  const diff = git("diff", "--unified=0", "--no-ext-diff", "--no-textconv", "--no-renames", diffBaseSha, headSha, "--");
  const evidenceParentSha = git("rev-parse", "--verify", `${headSha}^`).trim();
  const evidenceCommitChangedPaths = gitBuffer("-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", evidenceParentSha, headSha, "--")
    .toString("utf8").split("\0").filter(Boolean);
  process.stdout.write(`${JSON.stringify(evaluateGitHubReviewGate({
    event,
    changedPaths,
    diff,
    workflow,
    executionPolicy,
    artifactLoader: (reference) => JSON.parse(git("show", `${headSha}:${reference}`)),
    authorityLoader: (commitSha) => JSON.parse(git("show", `${commitSha}:config/ownership.json`)),
    evidenceCommit: { headSha, parentSha: evidenceParentSha, changedPaths: evidenceCommitChangedPaths },
    isAuthorityProtected: (authorityCommitSha) => {
      if (!shaPattern.test(authorityCommitSha)) return false;
      const result = spawnSync("git", ["merge-base", "--is-ancestor", authorityCommitSha, baseSha], { cwd: repository, encoding: "utf8", windowsHide: true });
      return result.status === 0;
    },
  }), null, 2)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === modulePath) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
