import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  classifyRisk,
  executionOperationNames,
  loadExecutionPolicy,
  normalizeModelIdentity,
  requiredReviewerFamilies,
  validateBranchForSurface,
  validateReviewerFamilies,
} from "./execution-policy.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(moduleDirectory, "..");
const executionPolicy = await loadExecutionPolicy(defaultRoot);
const workflowConfiguration = /** @type {{
  baseRef: string,
  states: string[],
  transitions: Record<string, string[]>,
  privilegedPathRules: Array<{ type: "prefix" | "exact", path: string, contracts: Array<"change-evaluator" | "supabase-auditor"> }>
}} */ (JSON.parse(readFileSync(path.join(defaultRoot, "config", "workflow.json"), "utf8")));

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const surfaceNames = /** @type {["codex-local" | "claude-local" | "cursor-cloud", ...Array<"codex-local" | "claude-local" | "cursor-cloud">]} */ (Object.keys(executionPolicy.surfaces));
const familyNames = /** @type {["openai" | "anthropic" | "cursor" | "xai", ...Array<"openai" | "anthropic" | "cursor" | "xai">]} */ (Object.keys(executionPolicy.modelFamilies));
const surfaceSchema = z.enum(surfaceNames);
const familySchema = z.enum([...familyNames, "unknown"]);
const knownFamilySchema = z.enum(familyNames);
export const modelIdentitySchema = z.object({
  configured: z.string().min(1),
  observed: z.string().min(1),
  family: familySchema,
  fallback: z.boolean(),
  parameters: z.array(z.object({
    id: z.string().min(1),
    value: z.string().min(1),
  }).strict()),
}).strict().superRefine((value, context) => {
  const normalized = normalizeModelIdentity(value.configured, value.observed, value.parameters, executionPolicy);
  if (value.family !== normalized.family) {
    context.addIssue({ code: "custom", path: ["family"], message: "Model family must be derived from the observed model ID." });
  }
  if (value.fallback !== normalized.fallback) {
    context.addIssue({ code: "custom", path: ["fallback"], message: "Model fallback must be derived from configured and observed model IDs." });
  }
  if (JSON.stringify(value.parameters) !== JSON.stringify(normalized.parameters)) {
    context.addIssue({ code: "custom", path: ["parameters"], message: "Model parameters must use canonical order." });
  }
});
export const riskSchema = z.object({
  level: z.enum(["normal", "high"]),
  reasons: z.array(z.string().min(1)),
}).strict();
const contractNameSchema = z.enum(["change-evaluator", "supabase-auditor"]);
const acceptanceIdSchema = z.string().regex(/^AC-[1-9][0-9]*$/u);
const relativeFileSchema = z.string().min(1).superRefine((value, context) => {
  const normalized = path.posix.normalize(value);
  if (
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    normalized !== value ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    context.addIssue({ code: "custom", message: "Expected a canonical POSIX repository-relative path." });
  }
});

export const operationNames = executionOperationNames;

const operationSchema = z.enum(operationNames);
const branchPrefixPattern = Object.values(executionPolicy.surfaces)
  .map(({ branchPrefix }) => branchPrefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
  .join("|");
const branchSchema = z.string().regex(new RegExp(`^(?:${branchPrefixPattern})\\/[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$`, "u"));
const worktreeSchema = z.string().regex(/^\.worktrees\/[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);

const targetSources = {
  github: "config/ownership.json#github",
  supabase: "config/ownership.json#supabase.projectRef",
  vercel: "config/ownership.json#vercel.projectId",
  cloudflare: "config/ownership.json#cloudflare.zoneId",
};

const operationDefinitions = /** @type {Record<string, {
  targetKind: string,
  targetIdentifier: string,
  environments: string[],
  reasonCodes: string[],
  inputs: import("zod").ZodType,
  evidence: string[]
}>} */ ({
  "github.read_issue": {
    targetKind: "github.repository",
    targetIdentifier: targetSources.github,
    environments: ["none"],
    reasonCodes: ["issue-contract"],
    inputs: z.object({ issue: z.number().int().positive() }).strict(),
    evidence: ["authenticated GitHub login", "repository", "sanitized Issue snapshot"],
  },
  "github.push_branch": {
    targetKind: "github.repository",
    targetIdentifier: targetSources.github,
    environments: ["none"],
    reasonCodes: ["acceptance-evidence"],
    inputs: z.object({ branch: branchSchema, headSha: shaSchema }).strict(),
    evidence: ["authenticated GitHub login", "repository", "pushed branch Head SHA"],
  },
  "github.create_pr": {
    targetKind: "github.repository",
    targetIdentifier: targetSources.github,
    environments: ["none"],
    reasonCodes: ["reviewed-release"],
    inputs: z.object({
      issue: z.number().int().positive(),
      branch: branchSchema,
      baseBranch: z.literal("main"),
      headSha: shaSchema,
    }).strict(),
    evidence: ["authenticated GitHub login", "draft PR URL", "PR Head SHA"],
  },
  "github.merge_pr": {
    targetKind: "github.repository",
    targetIdentifier: targetSources.github,
    environments: ["production"],
    reasonCodes: ["reviewed-release"],
    inputs: z.object({ issue: z.number().int().positive(), prNumber: z.number().int().positive(), headSha: shaSchema, method: z.literal("squash") }).strict(),
    evidence: ["authenticated GitHub login", "matched PR Head SHA", "squash merge commit", "closed Issue"],
  },
  "github.delete_branch": {
    targetKind: "github.repository",
    targetIdentifier: targetSources.github,
    environments: ["production"],
    reasonCodes: ["verified-cleanup"],
    inputs: z.object({ branch: branchSchema, mergedPrNumber: z.number().int().positive(), headSha: shaSchema }).strict(),
    evidence: ["merged PR identity", "deleted exact remote branch"],
  },
  "github.update_ruleset": {
    targetKind: "github.repository",
    targetIdentifier: targetSources.github,
    environments: ["production"],
    reasonCodes: ["reviewed-release"],
    inputs: z.object({
      issue: z.number().int().positive(),
      rulesetName: z.literal("main exact-Head review"),
      targetBranch: z.literal("main"),
      requiredCheckName: z.literal("Exact Head review policy"),
      enforcement: z.literal("active"),
    }).strict(),
    evidence: ["authenticated GitHub owner", "ruleset ID", "active enforcement", "required exact-Head check"],
  },
  "supabase.inspect_project": {
    targetKind: "supabase.project",
    targetIdentifier: targetSources.supabase,
    environments: ["production"],
    reasonCodes: ["issue-contract"],
    inputs: z.object({ projectRefSource: z.literal("config/ownership.json") }).strict(),
    evidence: ["authenticated Supabase organization", "project ref fingerprint", "read-only inspection"],
  },
  "supabase.apply_migrations": {
    targetKind: "supabase.project",
    targetIdentifier: targetSources.supabase,
    environments: ["production"],
    reasonCodes: ["acceptance-evidence"],
    inputs: z.object({
      projectRefSource: z.literal("config/ownership.json"),
      migrations: z.array(relativeFileSchema.regex(/^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/u)).min(1),
    }).strict(),
    evidence: ["authenticated Supabase organization", "project ref fingerprint", "applied migration names"],
  },
  "vercel.inspect_project": {
    targetKind: "vercel.project",
    targetIdentifier: targetSources.vercel,
    environments: ["production"],
    reasonCodes: ["issue-contract"],
    inputs: z.object({ projectSource: z.literal("config/ownership.json") }).strict(),
    evidence: ["authenticated Vercel scope", "project identity", "read-only inspection"],
  },
  "vercel.deploy_preview": {
    targetKind: "vercel.project",
    targetIdentifier: targetSources.vercel,
    environments: ["preview"],
    reasonCodes: ["acceptance-evidence"],
    inputs: z.object({ projectSource: z.literal("config/ownership.json"), headSha: shaSchema }).strict(),
    evidence: ["authenticated Vercel scope", "preview deployment URL", "deployed Head SHA"],
  },
  "vercel.deploy_production": {
    targetKind: "vercel.project",
    targetIdentifier: targetSources.vercel,
    environments: ["production"],
    reasonCodes: ["reviewed-release"],
    inputs: z.object({ projectSource: z.literal("config/ownership.json"), headSha: shaSchema }).strict(),
    evidence: ["authenticated Vercel scope", "production deployment URL", "deployed Head SHA"],
  },
  "cloudflare.inspect_zone": {
    targetKind: "cloudflare.zone",
    targetIdentifier: targetSources.cloudflare,
    environments: ["production"],
    reasonCodes: ["issue-contract"],
    inputs: z.object({ zoneSource: z.literal("config/ownership.json") }).strict(),
    evidence: ["authenticated Cloudflare account", "zone identity", "read-only DNS snapshot"],
  },
  "cloudflare.upsert_dns": {
    targetKind: "cloudflare.zone",
    targetIdentifier: targetSources.cloudflare,
    environments: ["production"],
    reasonCodes: ["reviewed-release"],
    inputs: z.object({
      zoneSource: z.literal("config/ownership.json"),
      recordName: z.string().regex(/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/u),
      recordType: z.enum(["A", "AAAA", "CNAME", "TXT"]),
      target: z.string().min(1).max(253),
      proxied: z.literal(false),
    }).strict(),
    evidence: ["authenticated Cloudflare account", "zone identity", "exact DNS record after write"],
  },
});

const externalRequestBaseSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().regex(/^issue-[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*-[1-9][0-9]*$/u),
  issue: z.number().int().positive(),
  operation: operationSchema,
  target: z.object({ kind: z.string().min(1), identifier: z.string().min(1).max(200) }).strict(),
  environment: z.enum(["none", "preview", "production"]),
  reasonCode: z.enum(["issue-contract", "acceptance-evidence", "reviewed-release", "verified-cleanup"]),
  inputs: z.record(z.string(), z.unknown()),
}).strict();

const singleLineSchema = z.string().trim().min(1).regex(/^[^\r\n]+$/u);
const acceptanceCriterionSchema = z.object({ id: acceptanceIdSchema, text: singleLineSchema }).strict();
const issueContractInputSchema = z.object({
  schemaVersion: z.literal(1),
  issue: z.number().int().positive(),
  repository: repositorySchema,
  goal: singleLineSchema,
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
  dependencies: z.array(z.number().int().positive()),
  externalOperations: z.array(operationSchema),
}).strict();
const issueContractSchema = issueContractInputSchema.extend({
  fetchedAt: timestampSchema,
  digest: digestSchema,
}).strict();

const acceptanceEvidenceSchema = z.object({
  id: acceptanceIdSchema,
  status: z.enum(["supported", "unsupported"]),
  evidence: z.array(singleLineSchema).min(1),
}).strict();
const verificationSchema = z.object({
  schemaVersion: z.literal(2),
  issue: z.number().int().positive(),
  executionSurface: surfaceSchema,
  primaryModel: modelIdentitySchema,
  risk: riskSchema,
  requiredReviewerFamilies: z.array(knownFamilySchema).min(1),
  baseSha: shaSchema,
  headSha: shaSchema,
  contractDigest: digestSchema,
  status: z.enum(["passed", "failed"]),
  commands: z.array(z.object({
    command: singleLineSchema,
    status: z.enum(["passed", "failed", "not-run"]),
    summary: singleLineSchema,
  }).strict()).min(1),
  acceptanceEvidence: z.array(acceptanceEvidenceSchema).min(1),
  externalChanges: z.array(singleLineSchema),
  remainingWork: z.array(singleLineSchema),
  completedAt: timestampSchema,
}).strict();
const verificationInputSchema = verificationSchema.omit({
  baseSha: true,
  headSha: true,
  contractDigest: true,
  risk: true,
  requiredReviewerFamilies: true,
}).strict();

const findingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  blocking: z.boolean(),
  location: singleLineSchema,
  summary: singleLineSchema,
}).strict().superRefine((value, context) => {
  if (["critical", "high"].includes(value.severity) && !value.blocking) {
    context.addIssue({ code: "custom", path: ["blocking"], message: "Critical and high findings must be blocking." });
  }
});
const reviewAssessmentSchema = z.object({
  id: acceptanceIdSchema,
  status: z.enum(["supported", "unsupported"]),
  evidenceRef: singleLineSchema,
}).strict();
const reviewResultObjectSchema = z.object({
  schemaVersion: z.literal(2),
  issue: z.number().int().positive(),
  executionSurface: surfaceSchema,
  primaryModel: modelIdentitySchema,
  reviewerModel: modelIdentitySchema,
  risk: riskSchema,
  headSha: shaSchema,
  verifySha: shaSchema,
  contractDigest: digestSchema,
  verdict: z.enum(["approved", "changes-requested", "unavailable"]),
  contracts: z.array(contractNameSchema).min(1),
  findings: z.array(findingSchema),
  acceptanceAssessment: z.array(reviewAssessmentSchema).min(1),
  reviewedAt: timestampSchema,
  unavailableReason: z.enum(["timeout", "command-missing", "invalid-output"]).optional(),
}).strict();
export const reviewResultKeys = Object.keys(reviewResultObjectSchema.shape)
  .filter((key) => key !== "unavailableReason");
const reviewResultSchema = reviewResultObjectSchema.superRefine((value, context) => {
  if (value.headSha !== value.verifySha) {
    context.addIssue({ code: "custom", path: ["verifySha"], message: "Review Head and verification SHA must match." });
  }
  if (value.verdict === "approved" && value.findings.some(({ blocking }) => blocking)) {
    context.addIssue({ code: "custom", path: ["verdict"], message: "An approved review cannot contain blocking findings." });
  }
  if (value.verdict === "approved" && value.findings.some(({ severity }) => ["critical", "high"].includes(severity))) {
    context.addIssue({ code: "custom", path: ["verdict"], message: "An approved review cannot contain critical or high findings." });
  }
  if (value.verdict === "approved") {
    for (const key of /** @type {Array<"primaryModel" | "reviewerModel">} */ (["primaryModel", "reviewerModel"])) {
      if (value[key].family === "unknown") {
        context.addIssue({ code: "custom", path: [key, "family"], message: "An approved review cannot use an unknown model family." });
      }
      if (value[key].fallback) {
        context.addIssue({ code: "custom", path: [key, "fallback"], message: "An approved review cannot use model fallback evidence." });
      }
    }
  }
  if (value.verdict === "unavailable" && !value.unavailableReason) {
    context.addIssue({ code: "custom", path: ["unavailableReason"], message: "Unavailable review needs a fixed reason." });
  }
  if (value.verdict !== "unavailable" && value.unavailableReason) {
    context.addIssue({ code: "custom", path: ["unavailableReason"], message: "Unavailable reason is only valid for unavailable review." });
  }
});

const reviewPacketSchema = z.object({
  schemaVersion: z.literal(2),
  issue: z.number().int().positive(),
  repository: repositorySchema,
  executionSurface: surfaceSchema,
  primaryModel: modelIdentitySchema,
  risk: riskSchema,
  requiredReviewerFamilies: z.array(knownFamilySchema).min(1),
  baseSha: shaSchema,
  headSha: shaSchema,
  verifySha: shaSchema,
  contractPath: relativeFileSchema,
  contractDigest: digestSchema,
  verifyPath: relativeFileSchema,
  verifyDigest: digestSchema,
  diffPath: relativeFileSchema,
  diffDigest: digestSchema,
  changedPaths: z.array(relativeFileSchema).min(1),
  requiredContracts: z.array(contractNameSchema).min(1),
  createdAt: timestampSchema,
}).strict();

const cleanupPlanSchema = z.object({
  schemaVersion: z.literal(1),
  issue: z.number().int().positive(),
  repository: repositorySchema,
  pr: z.object({
    number: z.number().int().positive(),
    state: z.string(),
    headRefName: branchSchema,
    headRefOid: shaSchema,
    mergeCommit: shaSchema.nullable(),
  }).strict(),
  recordedHeadSha: shaSchema,
  branch: branchSchema,
  worktree: worktreeSchema,
  worktreeClean: z.boolean(),
  remoteBranchDeleted: z.boolean(),
  localBranchSha: shaSchema,
  candidateBranches: z.array(branchSchema),
  candidateWorktrees: z.array(worktreeSchema),
}).strict();
const cleanupEvidenceSchema = cleanupPlanSchema.omit({
  worktreeClean: true,
  localBranchSha: true,
  candidateBranches: true,
  candidateWorktrees: true,
});

/** @param {unknown} value @returns {unknown} */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

/** @param {unknown} value */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/** @param {unknown} value */
export function digestValue(value) {
  const copy = value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ ({ ...value })
    : value;
  if (copy && typeof copy === "object" && !Array.isArray(copy)) {
    delete /** @type {Record<string, unknown>} */ (copy).digest;
  }
  return `sha256:${createHash("sha256").update(canonicalJson(copy), "utf8").digest("hex")}`;
}

/** @param {string[]} values @param {string} label */
function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates.`);
}

/** @param {unknown} input @param {string} fetchedAt */
export function snapshotIssueContract(input, fetchedAt) {
  const parsed = issueContractInputSchema.parse(input);
  unique(parsed.acceptanceCriteria.map(({ id }) => id), "Acceptance criteria");
  unique(parsed.dependencies.map(String), "Dependencies");
  unique(parsed.externalOperations, "External operations");
  const contract = { ...parsed, fetchedAt };
  return issueContractSchema.parse({ ...contract, digest: digestValue(contract) });
}

/** @param {unknown} value */
export function validateIssueContract(value) {
  const contract = issueContractSchema.parse(value);
  unique(contract.acceptanceCriteria.map(({ id }) => id), "Acceptance criteria");
  if (digestValue(contract) !== contract.digest) throw new Error("Issue contract digest mismatch.");
  return contract;
}

/** @param {string} root @param {string} source */
function resolveOwnershipTarget(root, source) {
  const ownership = JSON.parse(readFileSync(path.join(root, "config", "ownership.json"), "utf8"));
  if (source === targetSources.github) {
    const owner = ownership.github?.owner;
    const repository = ownership.github?.repository;
    if (!owner || !repository) throw new Error("GitHub ownership target is incomplete.");
    return `${owner}/${repository}`;
  }
  if (source === targetSources.supabase && ownership.supabase?.projectRef) return ownership.supabase.projectRef;
  if (source === targetSources.vercel && ownership.vercel?.projectId) return ownership.vercel.projectId;
  if (source === targetSources.cloudflare && ownership.cloudflare?.zoneId) return ownership.cloudflare.zoneId;
  throw new Error(`Ownership target ${source} is not configured.`);
}

/** @param {unknown} value @param {string} [root] @param {unknown} [contractValue] */
export function validateExternalOperationRequest(value, root = defaultRoot, contractValue) {
  const request = externalRequestBaseSchema.parse(value);
  const contract = validateIssueContract(contractValue ?? JSON.parse(readFileSync(
    resolveInside(root, `.artifacts/issues/${request.issue}/issue-contract.json`, `.artifacts/issues/${request.issue}`),
    "utf8",
  )));
  if (contract.issue !== request.issue) throw new Error("Operation request Issue does not match the frozen Issue contract.");
  if (!contract.externalOperations.includes(request.operation)) {
    throw new Error(`Operation ${request.operation} is outside the frozen Issue contract.`);
  }
  const definition = operationDefinitions[request.operation];
  if (request.target.kind !== definition.targetKind) {
    throw new Error(`Operation ${request.operation} requires target kind ${definition.targetKind}.`);
  }
  if (request.target.identifier !== definition.targetIdentifier) {
    throw new Error(`Operation ${request.operation} requires target identifier ${definition.targetIdentifier}.`);
  }
  if (!definition.environments.includes(request.environment)) throw new Error(`Invalid environment for ${request.operation}.`);
  if (!definition.reasonCodes.includes(request.reasonCode)) throw new Error(`Invalid reason code for ${request.operation}.`);
  const expectedPrefix = `issue-${request.issue}-${request.operation.replace(/[._]/gu, "-")}-`;
  if (!request.requestId.startsWith(expectedPrefix)) throw new Error("Operation requestId does not match its Issue and operation.");
  const inputs = definition.inputs.parse(request.inputs);
  if ("issue" in inputs && inputs.issue !== request.issue) {
    throw new Error("Operation request Issue does not match operation inputs.");
  }
  return {
    ...request,
    inputs,
    resolvedTarget: resolveOwnershipTarget(root, definition.targetIdentifier),
    expectedEvidence: definition.evidence,
  };
}

/** @param {string} candidate */
function canonicalPath(candidate) {
  const resolved = path.resolve(candidate);
  try {
    return realpathSync.native(resolved);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return resolved;
    throw error;
  }
}

/** @param {string} root @param {string} candidate @param {string} subtree */
export function resolveInside(root, candidate, subtree) {
  const canonicalRoot = canonicalPath(root);
  const base = path.resolve(canonicalRoot, subtree);
  const resolved = canonicalPath(path.isAbsolute(candidate) ? candidate : path.resolve(canonicalRoot, candidate));
  const relative = path.relative(base, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes ${subtree}.`);
  }
  return resolved;
}

/** @param {string} root @param {string} requestPath */
export async function readExternalOperationRequest(root, requestPath) {
  const resolved = resolveInside(root, requestPath, path.join(".artifacts", "ops-requests"));
  if (path.extname(resolved).toLowerCase() !== ".json") throw new Error("Operation request must be JSON.");
  const actual = await realpath(resolved);
  resolveInside(root, actual, path.join(".artifacts", "ops-requests"));
  const request = validateExternalOperationRequest(JSON.parse(await readFile(actual, "utf8")), root);
  let gate = null;
  if (["github.merge_pr", "vercel.deploy_production", "cloudflare.upsert_dns"].includes(request.operation)) {
    gate = await runAuthoritativePremergeGate(root, request.issue);
    if ("headSha" in request.inputs && request.inputs.headSha !== gate.headSha) {
      throw new Error("External operation Head SHA does not match the authoritative review gate.");
    }
  }
  return {
    request,
    gate,
    resultPath: path.join(".artifacts", "ops-results", `${request.requestId}.result.json`).replaceAll("\\", "/"),
  };
}

/** @param {string[]} changedPaths */
export function requiredReviewContracts(changedPaths) {
  const contracts = new Set(["change-evaluator"]);
  for (const candidate of changedPaths) {
    const normalized = relativeFileSchema.parse(candidate).toLowerCase();
    for (const rule of workflowConfiguration.privilegedPathRules) {
      const rulePath = rule.path.toLowerCase();
      const matches = rule.type === "exact" ? normalized === rulePath : normalized.startsWith(rulePath);
      if (matches) {
        rule.contracts.forEach((contract) => contracts.add(contract));
      }
    }
  }
  return [...contracts].sort();
}

/** @param {unknown} value */
export function validateVerification(value) {
  const verification = verificationSchema.parse(value);
  unique(verification.risk.reasons, "Verification risk reasons");
  unique(verification.requiredReviewerFamilies, "Verification reviewer families");
  return verification;
}

/** @param {unknown} value */
export function validateReviewResult(value) {
  const review = reviewResultSchema.parse(value);
  unique(review.risk.reasons, "Review risk reasons");
  unique(review.contracts, "Review contracts");
  unique(review.acceptanceAssessment.map(({ id }) => id), "Review acceptance assessment");
  return review;
}

/** @param {unknown} value @param {string} root @param {unknown} [contractValue] */
export function validateReviewPacket(value, root, contractValue) {
  const packet = reviewPacketSchema.parse(value);
  unique(packet.risk.reasons, "Review packet risk reasons");
  unique(packet.requiredReviewerFamilies, "Review packet reviewer families");
  if (packet.primaryModel.family === "unknown") throw new Error("unknown primary model family cannot satisfy review policy.");
  if (packet.primaryModel.fallback) throw new Error("Primary model fallback cannot satisfy review policy.");
  if (packet.headSha !== packet.verifySha) throw new Error("Review packet verification SHA is stale.");
  const issueRoot = path.join(".artifacts", "issues", String(packet.issue));
  const headRoot = path.join(issueRoot, packet.headSha);
  const expectedContractPath = path.join(issueRoot, "issue-contract.json").replaceAll("\\", "/");
  const expectedVerifyPath = path.join(headRoot, "verify.json").replaceAll("\\", "/");
  const expectedDiffPath = path.join(headRoot, "change.diff").replaceAll("\\", "/");
  if (packet.contractPath !== expectedContractPath || packet.verifyPath !== expectedVerifyPath || packet.diffPath !== expectedDiffPath) {
    throw new Error("Review packet must use the canonical Issue and Head artifact paths.");
  }
  resolveInside(root, packet.contractPath, issueRoot);
  resolveInside(root, packet.verifyPath, headRoot);
  resolveInside(root, packet.diffPath, headRoot);
  const expectedContracts = requiredReviewContracts(packet.changedPaths);
  if (canonicalJson(packet.requiredContracts.toSorted()) !== canonicalJson(expectedContracts)) {
    throw new Error("Review packet privileged-path contracts are incomplete.");
  }
  const expectedFamilies = requiredReviewerFamilies({
    risk: packet.risk.level,
    primaryFamily: packet.primaryModel.family,
  });
  if (canonicalJson(packet.requiredReviewerFamilies.toSorted()) !== canonicalJson(expectedFamilies)) {
    throw new Error("Review packet reviewer-family requirements do not match execution policy.");
  }
  if (contractValue !== undefined) {
    const contract = validateIssueContract(contractValue);
    const expectedRisk = classifyRisk({
      changedPaths: packet.changedPaths,
      externalOperations: contract.externalOperations,
    }, executionPolicy);
    if (canonicalJson(packet.risk) !== canonicalJson(expectedRisk)) {
      throw new Error("Review packet risk does not match execution policy.");
    }
  }
  return packet;
}

/** @param {unknown} reviewValue @param {unknown} packetValue @param {string} root @param {unknown} [contractValue] */
export function validateReviewAgainstPacket(reviewValue, packetValue, root, contractValue) {
  const packet = validateReviewPacket(packetValue, root, contractValue);
  const review = validateReviewResult(reviewValue);
  if (review.issue !== packet.issue) throw new Error("Review issue does not match the packet.");
  if (review.executionSurface !== packet.executionSurface) throw new Error("Review executionSurface does not match the packet.");
  if (canonicalJson(review.primaryModel) !== canonicalJson(packet.primaryModel)) throw new Error("Review primaryModel does not match the packet.");
  if (canonicalJson(review.risk) !== canonicalJson(packet.risk)) throw new Error("Review risk does not match the packet.");
  if (!packet.requiredReviewerFamilies.includes(review.reviewerModel.family)) {
    throw new Error(`Review family ${review.reviewerModel.family} is not required by the packet.`);
  }
  if (review.headSha !== packet.headSha) throw new Error("Review headSha does not match the packet.");
  if (review.verifySha !== packet.verifySha) throw new Error("Review verifySha does not match the packet.");
  if (review.contractDigest !== packet.contractDigest) throw new Error("Review contractDigest does not match the packet.");
  if (canonicalJson(review.contracts.toSorted()) !== canonicalJson(packet.requiredContracts.toSorted())) {
    throw new Error("Review did not cover every required privileged-path contract.");
  }
  return review;
}

/** @param {string} current @param {string} next @param {string | null} [resumeState] */
export function transitionWorkflowState(current, next, resumeState = null) {
  if (!workflowConfiguration.states.includes(current) || !workflowConfiguration.states.includes(next)) {
    throw new Error("Unknown workflow state.");
  }
  if (current.startsWith("blocked:") || current === "paused") {
    if (!resumeState || next !== resumeState) throw new Error("Blocked or paused recovery requires its recorded resumeState.");
    return { current: next, previous: current, resumeState: null };
  }
  const allowed = workflowConfiguration.transitions[current] ?? [];
  if (!allowed.includes(next)) throw new Error(`Invalid workflow transition: ${current} -> ${next}.`);
  return {
    current: next,
    previous: current,
    resumeState: next.startsWith("blocked:") || next === "paused" ? current : null,
  };
}

/** @param {string} root @param {number} issue @param {string} next */
export async function transitionPersistedWorkflowState(root, issue, next) {
  if (!Number.isInteger(issue) || issue < 1) throw new Error("Issue must be a positive integer.");
  const relative = `.artifacts/issues/${issue}/state.json`;
  const statePath = resolveInside(root, relative, `.artifacts/issues/${issue}`);
  const state = JSON.parse(await readFile(await realpath(statePath), "utf8"));
  if (state.issue !== issue || typeof state.current !== "string") throw new Error("Persisted workflow state is invalid.");
  const transition = transitionWorkflowState(state.current, next, state.resumeState ?? null);
  const updated = {
    ...state,
    ...transition,
    transitions: [...(Array.isArray(state.transitions) ? state.transitions : []), transition],
  };
  await writeJson(statePath, updated);
  return updated;
}

/** @param {unknown} reviewValue */
export function stateForReview(reviewValue) {
  const review = validateReviewResult(reviewValue);
  if (review.verdict === "unavailable") return "blocked:review";
  if (review.verdict === "approved" && !review.findings.some(({ blocking }) => blocking)) return "approved-for-merge";
  return "changes-requested";
}

/** @param {string[]} ids @param {Array<{id:string,status:string}>} mappings @param {string} label */
function checkExactAcceptanceMappings(ids, mappings, label) {
  const counts = new Map(ids.map((id) => [id, 0]));
  for (const mapping of mappings) {
    if (!counts.has(mapping.id)) throw new Error(`${label} contains unknown criterion ${mapping.id}.`);
    counts.set(mapping.id, (counts.get(mapping.id) ?? 0) + 1);
    if (mapping.status !== "supported") throw new Error(`${label} marks ${mapping.id} unsupported.`);
  }
  for (const [id, count] of counts) if (count !== 1) throw new Error(`${label} must map ${id} exactly once.`);
}

/**
 * @param {{currentHeadSha:string, contract:unknown, verification:unknown, packet:unknown, reviews:unknown[], root:string}} input
 */
export function runPremergeGate(input) {
  const contract = validateIssueContract(input.contract);
  const verification = validateVerification(input.verification);
  const packet = validateReviewPacket(input.packet, input.root, contract);
  const reviewValues = z.array(z.unknown()).min(1).parse(input.reviews);
  const reviews = reviewValues.map((review) => validateReviewAgainstPacket(review, packet, input.root, contract));
  const reviewerFamilies = reviews.map(({ reviewerModel }) => reviewerModel.family);
  validateReviewerFamilies({
    risk: packet.risk.level,
    primaryFamily: packet.primaryModel.family,
    reviewerFamilies,
  });
  if (canonicalJson(reviewerFamilies.toSorted()) !== canonicalJson(packet.requiredReviewerFamilies.toSorted())) {
    throw new Error("Review evidence must contain exactly the required reviewer families.");
  }
  if (input.currentHeadSha !== verification.headSha) throw new Error("Verification evidence is stale for the current Head SHA.");
  if (reviews.some((review) => input.currentHeadSha !== review.headSha || input.currentHeadSha !== review.verifySha)) {
    throw new Error("Review evidence is stale for the current Head SHA.");
  }
  if (packet.headSha !== input.currentHeadSha || packet.verifySha !== input.currentHeadSha) {
    throw new Error("Review packet is stale for the current Head SHA.");
  }
  if (verification.issue !== contract.issue || reviews.some(({ issue }) => issue !== contract.issue)) throw new Error("Evidence Issue mismatch.");
  if (packet.repository !== contract.repository) throw new Error("Review packet repository mismatch.");
  if (packet.baseSha !== verification.baseSha) throw new Error("Review packet base SHA mismatch.");
  if (verification.executionSurface !== packet.executionSurface) throw new Error("Verification executionSurface does not match the packet.");
  if (canonicalJson(verification.primaryModel) !== canonicalJson(packet.primaryModel)) throw new Error("Verification primaryModel does not match the packet.");
  if (canonicalJson(verification.risk) !== canonicalJson(packet.risk)) throw new Error("Verification risk does not match the packet.");
  if (canonicalJson(verification.requiredReviewerFamilies.toSorted()) !== canonicalJson(packet.requiredReviewerFamilies.toSorted())) {
    throw new Error("Verification reviewer-family requirements do not match the packet.");
  }
  if (verification.contractDigest !== contract.digest || reviews.some(({ contractDigest }) => contractDigest !== contract.digest)) {
    throw new Error("Evidence contract digest mismatch.");
  }
  if (verification.status !== "passed" || verification.commands.some(({ status }) => status !== "passed")) {
    throw new Error("Mechanical verification has not passed.");
  }
  if (reviews.some((review) => review.verdict !== "approved" ||
    review.findings.some(({ blocking, severity }) => blocking || ["critical", "high"].includes(severity)))) {
    throw new Error("Independent review has not approved the current Head.");
  }
  if (Date.parse(contract.fetchedAt) > Date.parse(verification.completedAt)) throw new Error("Verification predates the Issue contract.");
  if (reviews.some(({ reviewedAt }) => Date.parse(verification.completedAt) > Date.parse(reviewedAt))) throw new Error("Review predates verification.");
  const ids = contract.acceptanceCriteria.map(({ id }) => id);
  checkExactAcceptanceMappings(ids, verification.acceptanceEvidence, "Verification evidence");
  for (const review of reviews) checkExactAcceptanceMappings(ids, review.acceptanceAssessment, `Review assessment (${review.reviewerModel.family})`);
  return {
    ok: true,
    issue: contract.issue,
    headSha: input.currentHeadSha,
    contractDigest: contract.digest,
    risk: packet.risk,
    reviewers: reviews.map(({ reviewerModel, reviewedAt }) => ({ family: reviewerModel.family, reviewedAt })),
  };
}

/** @param {string} root @param {string[]} args */
function runGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    const detail = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
  return result.stdout;
}

/** @param {string} root @param {string} relativePath */
async function readArtifactJson(root, relativePath) {
  const absolute = resolveInside(root, relativePath, ".artifacts");
  const actual = await realpath(absolute);
  resolveInside(root, actual, ".artifacts");
  return JSON.parse(await readFile(actual, "utf8"));
}

/**
 * Derive review artifacts from the real git repository; callers supply outcomes, not SHAs, paths, or digests.
 * @param {string} root
 * @param {unknown} value
 */
export async function prepareReviewArtifacts(root, value) {
  const evidence = verificationInputSchema.parse(value);
  const currentHeadSha = runGit(root, ["rev-parse", "HEAD"]).trim();
  const baseSha = runGit(root, ["merge-base", workflowConfiguration.baseRef, currentHeadSha]).trim();
  shaSchema.parse(currentHeadSha);
  shaSchema.parse(baseSha);
  if (runGit(root, ["status", "--porcelain=v1", "--untracked-files=no"]).trim()) {
    throw new Error("Review preparation requires a clean tracked working tree.");
  }
  const issueRoot = `.artifacts/issues/${evidence.issue}`;
  const headRoot = `${issueRoot}/${currentHeadSha}`;
  const contractPath = `${issueRoot}/issue-contract.json`;
  const verifyPath = `${headRoot}/verify.json`;
  const diffPath = `${headRoot}/change.diff`;
  const packetPath = `${headRoot}/review-packet.json`;
  const contract = validateIssueContract(await readArtifactJson(root, contractPath));
  if (contract.issue !== evidence.issue) throw new Error("Verification input Issue does not match the frozen contract.");
  const repositoryDiff = runGit(root, ["diff", "--no-ext-diff", "--no-renames", "--binary", baseSha, currentHeadSha, "--"]);
  const changedPaths = runGit(root, ["-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", "-z", baseSha, currentHeadSha, "--"])
    .split("\0")
    .filter(Boolean)
    .map((candidate) => relativeFileSchema.parse(candidate));
  if (changedPaths.length === 0) throw new Error("Review preparation requires at least one committed changed path.");
  const risk = classifyRisk({ changedPaths, externalOperations: contract.externalOperations }, executionPolicy);
  const reviewerFamilies = requiredReviewerFamilies({ risk: risk.level, primaryFamily: evidence.primaryModel.family });
  const verification = validateVerification({
    schemaVersion: evidence.schemaVersion,
    issue: evidence.issue,
    executionSurface: evidence.executionSurface,
    primaryModel: evidence.primaryModel,
    risk,
    requiredReviewerFamilies: reviewerFamilies,
    baseSha,
    headSha: currentHeadSha,
    contractDigest: contract.digest,
    status: evidence.status,
    commands: evidence.commands,
    acceptanceEvidence: evidence.acceptanceEvidence,
    externalChanges: evidence.externalChanges,
    remainingWork: evidence.remainingWork,
    completedAt: evidence.completedAt,
  });
  const packet = validateReviewPacket({
    schemaVersion: 2,
    issue: evidence.issue,
    repository: contract.repository,
    executionSurface: evidence.executionSurface,
    primaryModel: evidence.primaryModel,
    risk,
    requiredReviewerFamilies: reviewerFamilies,
    baseSha,
    headSha: currentHeadSha,
    verifySha: currentHeadSha,
    contractPath,
    contractDigest: contract.digest,
    verifyPath,
    verifyDigest: digestValue(verification),
    diffPath,
    diffDigest: digestValue(repositoryDiff),
    changedPaths,
    requiredContracts: requiredReviewContracts(changedPaths),
    createdAt: evidence.completedAt,
  }, root, contract);
  await writeJson(path.join(root, verifyPath), verification);
  await writeFile(path.join(root, diffPath), repositoryDiff, "utf8");
  await writeJson(path.join(root, packetPath), packet);
  return { contract, verification, packet, paths: { contract: contractPath, verification: verifyPath, diff: diffPath, packet: packetPath } };
}

/** @param {string} root @param {number} issue @param {unknown} value */
export async function recordReviewResult(root, issue, value) {
  if (!Number.isInteger(issue) || issue < 1) throw new Error("Issue must be a positive integer.");
  const currentHeadSha = runGit(root, ["rev-parse", "HEAD"]).trim();
  const headRoot = `.artifacts/issues/${issue}/${currentHeadSha}`;
  const contract = await readArtifactJson(root, `.artifacts/issues/${issue}/issue-contract.json`);
  const packet = await readArtifactJson(root, `${headRoot}/review-packet.json`);
  const review = validateReviewAgainstPacket(value, packet, root, contract);
  const reviewPath = `${headRoot}/reviews/${review.reviewerModel.family}.json`;
  await writeJson(path.join(root, reviewPath), review);
  return { review, reviewPath, nextState: stateForReview(review) };
}

/**
 * Load gate evidence from canonical artifact paths and bind it to the repository's real current Head and diff.
 * @param {string} root
 * @param {number} issue
 */
export async function loadAuthoritativeGateInput(root, issue) {
  if (!Number.isInteger(issue) || issue < 1) throw new Error("Issue must be a positive integer.");
  const currentHeadSha = runGit(root, ["rev-parse", "HEAD"]).trim();
  shaSchema.parse(currentHeadSha);
  if (runGit(root, ["status", "--porcelain=v1", "--untracked-files=no"]).trim()) {
    throw new Error("Pre-merge gate requires a clean tracked working tree.");
  }

  const issueRoot = `.artifacts/issues/${issue}`;
  const headRoot = `${issueRoot}/${currentHeadSha}`;
  const contract = await readArtifactJson(root, `${issueRoot}/issue-contract.json`);
  const verification = await readArtifactJson(root, `${headRoot}/verify.json`);
  const packet = await readArtifactJson(root, `${headRoot}/review-packet.json`);
  const validatedPacket = validateReviewPacket(packet, root, contract);
  const reviews = await Promise.all(validatedPacket.requiredReviewerFamilies.map((family) =>
    readArtifactJson(root, `${headRoot}/reviews/${family}.json`)));
  const authoritativeBaseSha = runGit(root, ["merge-base", workflowConfiguration.baseRef, currentHeadSha]).trim();
  if (validatedPacket.baseSha !== authoritativeBaseSha) throw new Error("Review packet base SHA does not match the authoritative base ref.");

  const verifyDigest = digestValue(verification);
  if (validatedPacket.verifyDigest !== verifyDigest) throw new Error("Review packet verification digest mismatch.");

  const diffPath = resolveInside(root, validatedPacket.diffPath, headRoot);
  const diffActualPath = await realpath(diffPath);
  resolveInside(root, diffActualPath, headRoot);
  const recordedDiff = await readFile(diffActualPath, "utf8");
  const repositoryDiff = runGit(root, ["diff", "--no-ext-diff", "--no-renames", "--binary", authoritativeBaseSha, currentHeadSha, "--"]);
  if (recordedDiff !== repositoryDiff) throw new Error("Recorded review diff does not match the repository diff.");
  if (validatedPacket.diffDigest !== digestValue(recordedDiff)) throw new Error("Review packet diff digest mismatch.");

  const repositoryChangedPaths = runGit(root, ["-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", "-z", authoritativeBaseSha, currentHeadSha, "--"])
    .split("\0")
    .filter(Boolean)
    .map((candidate) => relativeFileSchema.parse(candidate))
    .toSorted();
  if (canonicalJson(validatedPacket.changedPaths.toSorted()) !== canonicalJson(repositoryChangedPaths)) {
    throw new Error("Review packet changed paths do not match the repository diff.");
  }

  return { currentHeadSha, contract, verification, packet, reviews, root };
}

/** @param {string} root @param {number} issue */
export async function runAuthoritativePremergeGate(root, issue) {
  return runPremergeGate(await loadAuthoritativeGateInput(root, issue));
}

/** @param {string} root @param {number} issue */
export async function renderAuthoritativePullRequestBody(root, issue) {
  return renderPullRequestBody(await loadAuthoritativeGateInput(root, issue));
}

/** @param {string} root @param {number} issue @param {number} prNumber */
export async function createMergeOperationRequest(root, issue, prNumber) {
  const input = await loadAuthoritativeGateInput(root, issue);
  const gate = runPremergeGate(input);
  const request = {
    schemaVersion: 1,
    requestId: `issue-${issue}-github-merge-pr-1`,
    issue,
    operation: "github.merge_pr",
    target: { kind: "github.repository", identifier: targetSources.github },
    environment: "production",
    reasonCode: "reviewed-release",
    inputs: { issue, prNumber, headSha: gate.headSha, method: "squash" },
  };
  const validated = validateExternalOperationRequest(request, root, input.contract);
  const requestPath = `.artifacts/ops-requests/${request.requestId}.json`;
  await writeJson(path.join(root, requestPath), request);
  return { gate, request: validated, requestPath };
}

/** @param {Parameters<typeof runPremergeGate>[0]} input */
export function renderPullRequestBody(input) {
  const gate = runPremergeGate(input);
  const contract = validateIssueContract(input.contract);
  const verification = validateVerification(input.verification);
  const reviews = input.reviews.map(validateReviewResult);
  /** @param {string} value */
  const safe = (value) => value
    .replaceAll("`", "\\`")
    .replace(/\b(closes?|fix(?:e[sd])?|resolves?)\s+#/giu, "$1 \\#")
    .replaceAll("@", "@\u200b");
  const commands = verification.commands.map(({ command, summary }) => `- \`${safe(command)}\`: ${safe(summary)}`).join("\n");
  const evidence = verification.acceptanceEvidence.map(({ id, evidence: refs }) => `- ${id}: ${refs.map(safe).join("; ")}`).join("\n");
  const externalChanges = verification.externalChanges.length === 0
    ? "- None."
    : verification.externalChanges.map((item) => `- ${safe(item)}`).join("\n");
  const remainingWork = verification.remainingWork.length === 0
    ? "- None for this Issue."
    : verification.remainingWork.map((item) => `- ${safe(item)}`).join("\n");
  const reviewLines = reviews.map((review) => `- Reviewer ${review.reviewerModel.family}: ${review.verdict}; observed ${safe(review.reviewerModel.observed)}; Reviewed SHA: \`${review.headSha}\`; Contracts: ${review.contracts.join(", ")}`).join("\n");
  return `Closes #${gate.issue}\n\n## Summary\n- ${safe(contract.goal)}\n\n## Verification\n- Execution surface: ${verification.executionSurface}\n- Primary: ${verification.primaryModel.family} (${safe(verification.primaryModel.observed)})\n- Risk: ${verification.risk.level}${verification.risk.reasons.length > 0 ? ` (${verification.risk.reasons.map(safe).join(", ")})` : ""}\n- Head SHA: \`${gate.headSha}\`\n- Contract digest: \`${gate.contractDigest}\`\n${commands}\n\n## Acceptance evidence\n${evidence}\n\n## Cross-model reviews\n${reviewLines}\n\n## External changes\n${externalChanges}\n\n## Remaining work\n${remainingWork}\n`;
}

/** @param {unknown} value @param {string} root */
export function validateCleanupPlan(value, root) {
  const plan = cleanupPlanSchema.parse(value);
  if (plan.pr.state !== "MERGED" || !plan.pr.mergeCommit) throw new Error("Cleanup requires an exact merged PR with a merge commit.");
  if (plan.pr.headRefOid !== plan.recordedHeadSha) throw new Error("Cleanup Head SHA does not match the merged PR.");
  if (plan.localBranchSha !== plan.recordedHeadSha) throw new Error("Cleanup local branch SHA does not match the merged PR.");
  if (plan.pr.headRefName !== plan.branch) throw new Error("Cleanup branch does not match the merged PR.");
  const branchIssue = Number(plan.branch.split("/")[1]?.split("-")[0]);
  if (branchIssue !== plan.issue) throw new Error("Cleanup branch is unrelated to the Issue.");
  if (!plan.worktreeClean) throw new Error("Cleanup refuses a dirty worktree.");
  if (!plan.remoteBranchDeleted) throw new Error("Cleanup requires confirmed exact remote branch deletion first.");
  if (plan.candidateBranches.length !== 1 || plan.candidateBranches[0] !== plan.branch) throw new Error("Cleanup branch target is ambiguous.");
  if (plan.candidateWorktrees.length !== 1 || plan.candidateWorktrees[0] !== plan.worktree) throw new Error("Cleanup worktree target is ambiguous.");
  const worktreeIssue = Number(plan.worktree.slice(".worktrees/".length).split("-")[0]);
  if (worktreeIssue !== plan.issue) throw new Error("Cleanup worktree is unrelated to the Issue.");
  resolveInside(root, plan.worktree, ".worktrees");
  return {
    safe: true,
    localActions: [
      { operation: "git.worktree.remove", target: plan.worktree },
      { operation: "git.branch.delete", target: plan.branch },
    ],
    preservedCandidates: { branches: [], worktrees: [] },
  };
}

/**
 * Re-derive every local cleanup fact from git. Remote PR/branch facts remain Codex-collected provider evidence.
 * @param {unknown} evidenceValue
 * @param {string} root
 */
export function collectAndValidateCleanupPlan(evidenceValue, root) {
  const evidence = cleanupEvidenceSchema.parse(evidenceValue);
  const worktree = worktreeSchema.parse(evidence.worktree);
  const worktreeAbsolute = resolveInside(root, worktree, ".worktrees");
  const canonicalRoot = canonicalPath(root);
  const localBranchSha = runGit(root, ["rev-parse", `refs/heads/${evidence.branch}`]).trim();
  const candidateBranches = runGit(root, [
    "for-each-ref",
    "--format=%(refname:short)",
    ...Object.values(executionPolicy.surfaces).map(({ branchPrefix }) => `refs/heads/${branchPrefix}/${evidence.issue}-*`),
  ]).split(/\r?\n/u).filter(Boolean).toSorted();
  const candidateWorktrees = runGit(root, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.relative(canonicalRoot, canonicalPath(line.slice("worktree ".length))).replaceAll("\\", "/"))
    .filter((candidate) => worktreeSchema.safeParse(candidate).success)
    .filter((candidate) => Number(candidate.slice(".worktrees/".length).split("-")[0]) === evidence.issue)
    .toSorted();
  const worktreeClean = runGit(worktreeAbsolute, ["status", "--porcelain=v1", "--untracked-files=all"]).trim() === "";
  return validateCleanupPlan({
    ...evidence,
    localBranchSha,
    worktreeClean,
    candidateBranches,
    candidateWorktrees,
  }, root);
}

/** @param {string} outputPath @param {unknown} value */
async function writeJson(outputPath, value) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const fixtureSchema = z.object({
  schemaVersion: z.literal(2),
  fetchedAt: timestampSchema,
  completedAt: timestampSchema,
  reviewedAt: timestampSchema,
  issueContract: issueContractInputSchema,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  executionSurface: surfaceSchema,
  primaryModel: modelIdentitySchema,
  reviewerModels: z.array(modelIdentitySchema).min(1),
  changedPaths: z.array(relativeFileSchema).min(1),
  commands: verificationSchema.shape.commands,
  acceptanceEvidence: verificationSchema.shape.acceptanceEvidence,
  externalChanges: verificationSchema.shape.externalChanges,
  remainingWork: verificationSchema.shape.remainingWork,
  findings: z.array(findingSchema),
  acceptanceAssessment: z.array(reviewAssessmentSchema),
  prNumber: z.number().int().positive(),
}).strict();

/** @param {unknown} fixtureValue @param {string} root */
export async function simulateWorkflowFixture(fixtureValue, root) {
  const fixture = fixtureSchema.parse(fixtureValue);
  const branchPrefix = executionPolicy.surfaces[fixture.executionSurface].branchPrefix;
  const branch = validateBranchForSurface(
    `${branchPrefix}/${fixture.issueContract.issue}-${fixture.slug}`,
    fixture.issueContract.issue,
    fixture.executionSurface,
    executionPolicy,
  );
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, ".gitignore"), ".artifacts/\n", "utf8");
  await writeJson(path.join(root, "config", "ownership.json"), {
    schemaVersion: 1,
    github: { owner: fixture.issueContract.repository.split("/")[0], repository: fixture.issueContract.repository.split("/")[1] },
    supabase: { organizationName: "fixture", projectRef: null },
    vercel: { scope: null, projectId: null },
    cloudflare: { accountName: "fixture", zoneId: null, domains: [] },
  });
  await writeFile(path.join(root, "README.md"), "# Workflow fixture\n", "utf8");
  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.name", "Workflow Fixture"]);
  runGit(root, ["config", "user.email", "workflow@example.invalid"]);
  runGit(root, ["add", ".gitignore", "README.md", "config/ownership.json"]);
  runGit(root, ["commit", "-m", "fixture base"]);
  const baseSha = runGit(root, ["rev-parse", "HEAD"]).trim();
  runGit(root, ["switch", "-c", branch]);
  for (const changedPath of fixture.changedPaths) {
    const absolute = path.join(root, changedPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `fixture change for ${changedPath}\n`, "utf8");
  }
  runGit(root, ["add", "--", ...fixture.changedPaths]);
  runGit(root, ["commit", "-m", "fixture verified change"]);
  const headSha = runGit(root, ["rev-parse", "HEAD"]).trim();

  const contract = snapshotIssueContract(fixture.issueContract, fixture.fetchedAt);
  const issueRootRelative = path.join(".artifacts", "issues", String(contract.issue));
  const headRootRelative = path.join(issueRootRelative, headSha);
  const issueRoot = path.resolve(root, issueRootRelative);
  const headRoot = path.resolve(root, headRootRelative);
  const contractPathRelative = path.join(issueRootRelative, "issue-contract.json").replaceAll("\\", "/");
  await writeJson(path.join(root, contractPathRelative), contract);
  const prepared = await prepareReviewArtifacts(root, {
    schemaVersion: 2,
    issue: contract.issue,
    executionSurface: fixture.executionSurface,
    primaryModel: fixture.primaryModel,
    status: "passed",
    commands: fixture.commands,
    acceptanceEvidence: fixture.acceptanceEvidence,
    externalChanges: fixture.externalChanges,
    remainingWork: fixture.remainingWork,
    completedAt: fixture.completedAt,
  });
  const packet = prepared.packet;
  const recorded = await Promise.all(fixture.reviewerModels.map((reviewerModel) => recordReviewResult(root, contract.issue, {
    schemaVersion: 2,
    issue: contract.issue,
    executionSurface: packet.executionSurface,
    primaryModel: packet.primaryModel,
    reviewerModel,
    risk: packet.risk,
    headSha: packet.headSha,
    verifySha: packet.verifySha,
    contractDigest: contract.digest,
    verdict: "approved",
    contracts: packet.requiredContracts,
    findings: fixture.findings,
    acceptanceAssessment: fixture.acceptanceAssessment,
    reviewedAt: fixture.reviewedAt,
  })));
  /** @type {{ current: string, previous: string, resumeState: string | null }} */
  let state = { current: "approved", previous: "proposed", resumeState: null };
  const transitions = [];
  for (const next of ["claimed", "in-progress", "verify-passed", "review-requested", "approved-for-merge"]) {
    state = transitionWorkflowState(state.current, next, state.resumeState);
    transitions.push(state);
  }
  await mkdir(headRoot, { recursive: true });
  await writeJson(path.join(issueRoot, "state.json"), { schemaVersion: 1, issue: contract.issue, branch, ...state, transitions });
  const authoritativeInput = await loadAuthoritativeGateInput(root, contract.issue);
  const gate = runPremergeGate(authoritativeInput);
  const prBody = renderPullRequestBody(authoritativeInput);
  await writeFile(path.join(headRoot, "pull-request.md"), prBody, "utf8");
  const merge = await createMergeOperationRequest(root, contract.issue, fixture.prNumber);

  return { gate, state, branch, baseSha, headSha, request: merge.request, paths: {
    contract: contractPathRelative,
    verification: prepared.paths.verification,
    diff: prepared.paths.diff,
    packet: prepared.paths.packet,
    reviews: recorded.map(({ reviewPath }) => reviewPath),
    pullRequest: path.join(headRootRelative, "pull-request.md").replaceAll("\\", "/"),
    mergeRequest: merge.requestPath,
  } };
}

export const schemas = {
  issueContractInputSchema,
  issueContractSchema,
  modelIdentitySchema,
  riskSchema,
  verificationSchema,
  reviewResultSchema,
  reviewPacketSchema,
  cleanupPlanSchema,
};
