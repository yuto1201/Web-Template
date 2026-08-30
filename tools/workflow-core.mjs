import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { authorityDigest, authorizeServiceUse, evaluateAccountObservation, parseAuthority } from "./authority-core.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(moduleDirectory, "..");
const protectedAuthorityRef = "main";
const workflowConfiguration = /** @type {{
  reviewerMap: Record<"codex" | "claude", "codex" | "claude">,
  baseRef: string,
  states: string[],
  transitions: Record<string, string[]>,
  privilegedPathRules: Array<{ type: "prefix" | "exact", path: string, contracts: Array<"change-evaluator" | "supabase-auditor"> }>
}} */ (JSON.parse(readFileSync(path.join(defaultRoot, "config", "workflow.json"), "utf8")));

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const modelSchema = z.enum(["codex", "claude"]);
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

/** @typedef {"github.read_issue" | "github.push_branch" | "github.create_pr" | "github.merge_pr" | "github.delete_branch" | "github.update_ruleset" | "supabase.inspect_project" | "supabase.apply_migrations" | "vercel.inspect_project" | "vercel.deploy_preview" | "vercel.deploy_production" | "cloudflare.inspect_zone" | "cloudflare.upsert_dns"} Operation */

/** @type {Operation[]} */
export const operationNames = [
  "github.read_issue",
  "github.push_branch",
  "github.create_pr",
  "github.merge_pr",
  "github.delete_branch",
  "github.update_ruleset",
  "supabase.inspect_project",
  "supabase.apply_migrations",
  "vercel.inspect_project",
  "vercel.deploy_preview",
  "vercel.deploy_production",
  "cloudflare.inspect_zone",
  "cloudflare.upsert_dns",
];

const operationSchema = z.enum(operationNames);
const branchSchema = z.string().regex(/^(?:codex|claude)\/[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const worktreeSchema = z.string().regex(/^\.worktrees\/[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const serviceSchema = z.enum(["github", "supabase", "vercel", "cloudflare", "linear"]);
const operatorLabelSchema = z.enum(["codex", "claude"]);
const externalOperatorRoleSchema = z.enum(["implementer", "external-operator"]);
const executionSurfaceSchema = z.string().trim().min(1).max(128).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u);
const receiptIdSchema = z.string().regex(/^receipt-[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const targetSources = {
  github: "resourceTargets.github",
  supabase: "resourceTargets.supabase",
  vercel: "resourceTargets.vercel",
  cloudflare: "resourceTargets.cloudflare",
};

const operationDefinitions = /** @type {Record<Operation, {
  service: "github" | "supabase" | "vercel" | "cloudflare",
  targetKind: string,
  targetIdentifier: string,
  environments: string[],
  reasonCodes: string[],
  inputs: import("zod").ZodObject<any>,
  constraints: import("zod").ZodObject<any>,
  requiresExactHead: boolean,
  evidence: string[]
}>} */ ({
  "github.read_issue": {
    service: "github",
    targetKind: "github.repository",
    targetIdentifier: targetSources.github,
    environments: ["none"],
    reasonCodes: ["issue-contract"],
    inputs: z.object({ issue: z.number().int().positive() }).strict(),
    constraints: z.object({ issue: z.number().int().positive() }).strict(),
    requiresExactHead: false,
    evidence: ["authenticated GitHub login", "repository", "sanitized Issue snapshot"],
  },
  "github.push_branch": {
    service: "github",
    targetKind: "github.repository",
    targetIdentifier: targetSources.github,
    environments: ["none"],
    reasonCodes: ["acceptance-evidence"],
    inputs: z.object({ branch: branchSchema, headSha: shaSchema }).strict(),
    constraints: z.object({ branch: branchSchema }).strict(),
    requiresExactHead: false,
    evidence: ["authenticated GitHub login", "repository", "pushed branch Head SHA"],
  },
  "github.create_pr": {
    service: "github",
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
    constraints: z.object({
      issue: z.number().int().positive(),
      branch: branchSchema,
      baseBranch: z.literal("main"),
    }).strict(),
    requiresExactHead: false,
    evidence: ["authenticated GitHub login", "draft PR URL", "PR Head SHA"],
  },
  "github.merge_pr": {
    service: "github",
    targetKind: "github.repository",
    targetIdentifier: targetSources.github,
    environments: ["production"],
    reasonCodes: ["reviewed-release"],
    inputs: z.object({ issue: z.number().int().positive(), prNumber: z.number().int().positive(), headSha: shaSchema, method: z.literal("squash") }).strict(),
    constraints: z.object({ issue: z.number().int().positive(), method: z.literal("squash") }).strict(),
    requiresExactHead: true,
    evidence: ["authenticated GitHub login", "matched PR Head SHA", "squash merge commit", "closed Issue"],
  },
  "github.delete_branch": {
    service: "github",
    targetKind: "github.repository",
    targetIdentifier: targetSources.github,
    environments: ["production"],
    reasonCodes: ["verified-cleanup"],
    inputs: z.object({ branch: branchSchema, mergedPrNumber: z.number().int().positive(), headSha: shaSchema }).strict(),
    constraints: z.object({ branch: branchSchema }).strict(),
    requiresExactHead: false,
    evidence: ["merged PR identity", "deleted exact remote branch"],
  },
  "github.update_ruleset": {
    service: "github",
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
    constraints: z.object({
      issue: z.number().int().positive(),
      rulesetName: z.literal("main exact-Head review"),
      targetBranch: z.literal("main"),
      requiredCheckName: z.literal("Exact Head review policy"),
      enforcement: z.literal("active"),
    }).strict(),
    requiresExactHead: true,
    evidence: ["authenticated GitHub owner", "ruleset ID", "active enforcement", "required exact-Head check"],
  },
  "supabase.inspect_project": {
    service: "supabase",
    targetKind: "supabase.project",
    targetIdentifier: targetSources.supabase,
    environments: ["production"],
    reasonCodes: ["issue-contract"],
    inputs: z.object({ projectRefSource: z.literal("config/ownership.json") }).strict(),
    constraints: z.object({ projectRefSource: z.literal("config/ownership.json") }).strict(),
    requiresExactHead: false,
    evidence: ["authenticated Supabase organization", "project ref fingerprint", "read-only inspection"],
  },
  "supabase.apply_migrations": {
    service: "supabase",
    targetKind: "supabase.project",
    targetIdentifier: targetSources.supabase,
    environments: ["production"],
    reasonCodes: ["acceptance-evidence"],
    inputs: z.object({
      projectRefSource: z.literal("config/ownership.json"),
      migrations: z.array(relativeFileSchema.regex(/^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/u)).min(1),
    }).strict(),
    constraints: z.object({
      projectRefSource: z.literal("config/ownership.json"),
      migrations: z.array(relativeFileSchema.regex(/^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/u)).min(1),
    }).strict(),
    requiresExactHead: true,
    evidence: ["authenticated Supabase organization", "project ref fingerprint", "applied migration names"],
  },
  "vercel.inspect_project": {
    service: "vercel",
    targetKind: "vercel.project",
    targetIdentifier: targetSources.vercel,
    environments: ["production"],
    reasonCodes: ["issue-contract"],
    inputs: z.object({ projectSource: z.literal("config/ownership.json") }).strict(),
    constraints: z.object({ projectSource: z.literal("config/ownership.json") }).strict(),
    requiresExactHead: false,
    evidence: ["authenticated Vercel scope", "project identity", "read-only inspection"],
  },
  "vercel.deploy_preview": {
    service: "vercel",
    targetKind: "vercel.project",
    targetIdentifier: targetSources.vercel,
    environments: ["preview"],
    reasonCodes: ["acceptance-evidence"],
    inputs: z.object({ projectSource: z.literal("config/ownership.json"), headSha: shaSchema }).strict(),
    constraints: z.object({ projectSource: z.literal("config/ownership.json") }).strict(),
    requiresExactHead: true,
    evidence: ["authenticated Vercel scope", "preview deployment URL", "deployed Head SHA"],
  },
  "vercel.deploy_production": {
    service: "vercel",
    targetKind: "vercel.project",
    targetIdentifier: targetSources.vercel,
    environments: ["production"],
    reasonCodes: ["reviewed-release"],
    inputs: z.object({ projectSource: z.literal("config/ownership.json"), headSha: shaSchema }).strict(),
    constraints: z.object({ projectSource: z.literal("config/ownership.json") }).strict(),
    requiresExactHead: true,
    evidence: ["authenticated Vercel scope", "production deployment URL", "deployed Head SHA"],
  },
  "cloudflare.inspect_zone": {
    service: "cloudflare",
    targetKind: "cloudflare.zone",
    targetIdentifier: targetSources.cloudflare,
    environments: ["production"],
    reasonCodes: ["issue-contract"],
    inputs: z.object({ zoneSource: z.literal("config/ownership.json") }).strict(),
    constraints: z.object({ zoneSource: z.literal("config/ownership.json") }).strict(),
    requiresExactHead: false,
    evidence: ["authenticated Cloudflare account", "zone identity", "read-only DNS snapshot"],
  },
  "cloudflare.upsert_dns": {
    service: "cloudflare",
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
    constraints: z.object({
      zoneSource: z.literal("config/ownership.json"),
      recordName: z.string().regex(/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/u),
      recordType: z.enum(["A", "AAAA", "CNAME", "TXT"]),
      target: z.string().min(1).max(253),
      proxied: z.literal(false),
    }).strict(),
    requiresExactHead: true,
    evidence: ["authenticated Cloudflare account", "zone identity", "exact DNS record after write"],
  },
});

/** @param {unknown} operation */
export function requiresAuthoritativeHead(operation) {
  return operationDefinitions[operationSchema.parse(operation)].requiresExactHead;
}

const operationPurposeDefinitions = /** @type {Record<string, (constraints: Record<string, unknown>) => string>} */ ({
  "github.read_issue": ({ issue }) => `Read the frozen Issue ${issue}.`,
  "github.push_branch": ({ branch }) => `Push the exact verified branch ${branch}.`,
  "github.create_pr": ({ issue }) => `Create the exact reviewed pull request for Issue ${issue}.`,
  "github.merge_pr": ({ issue }) => `Merge the exact reviewed pull request for Issue ${issue}.`,
  "github.delete_branch": ({ branch }) => `Delete the exact merged branch ${branch}.`,
  "github.update_ruleset": ({ issue }) => `Update the exact protected-branch ruleset for Issue ${issue}.`,
  "supabase.inspect_project": () => "Inspect the configured Supabase project.",
  "supabase.apply_migrations": () => "Apply the exact frozen Supabase migrations.",
  "vercel.inspect_project": () => "Inspect the configured Vercel project.",
  "vercel.deploy_preview": () => "Deploy the exact reviewed Vercel preview.",
  "vercel.deploy_production": () => "Deploy the exact reviewed Vercel production release.",
  "cloudflare.inspect_zone": () => "Inspect the configured Cloudflare zone.",
  "cloudflare.upsert_dns": () => "Upsert the exact reviewed Cloudflare DNS record.",
});

const externalRequestBaseSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().regex(/^issue-[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*-[1-9][0-9]*$/u),
  issue: z.number().int().positive(),
  operation: operationSchema,
  target: z.object({ kind: z.string().min(1), identifier: z.string().min(1).max(200) }).strict(),
  environment: z.enum(["none", "preview", "production"]),
  reasonCode: z.enum(["issue-contract", "acceptance-evidence", "reviewed-release", "verified-cleanup", "user-directed"]),
  operatorLabel: operatorLabelSchema,
  executionRole: externalOperatorRoleSchema,
  executionSurface: executionSurfaceSchema,
  inputs: z.record(z.string(), z.unknown()),
}).strict();

const singleLineSchema = z.string().trim().min(1).regex(/^[^\r\n]+$/u);
const acceptanceCriterionSchema = z.object({ id: acceptanceIdSchema, text: singleLineSchema }).strict();
const externalAuthorizationBaseSchema = z.object({
  service: serviceSchema,
  operation: operationSchema,
  purposeCode: z.enum(["issue-contract", "acceptance-evidence", "reviewed-release", "verified-cleanup", "user-directed"]),
  purpose: singleLineSchema,
  accountRef: z.string().regex(/^accounts\.(?:github|supabase|vercel|cloudflare|linear)$/u),
  targetRef: z.string().regex(/^resourceTargets\.(?:github|supabase|vercel|cloudflare|linear)$/u),
  environment: z.enum(["none", "preview", "production"]),
  constraints: z.record(z.string(), z.unknown()),
  requiresExactHead: z.boolean(),
}).strict();
const externalAuthorizationSchema = externalAuthorizationBaseSchema.transform((authorization, context) => {
  const definition = operationDefinitions[authorization.operation];
  const expectedAccountRef = `accounts.${definition.service}`;
  const expectedTargetRef = definition.targetIdentifier;
  const failures = [
    [authorization.service === definition.service, ["service"], `Operation ${authorization.operation} requires service ${definition.service}.`],
    [authorization.accountRef === expectedAccountRef, ["accountRef"], `Operation ${authorization.operation} requires account reference ${expectedAccountRef}.`],
    [authorization.targetRef === expectedTargetRef, ["targetRef"], `Operation ${authorization.operation} requires target reference ${expectedTargetRef}.`],
    [definition.environments.includes(authorization.environment), ["environment"], `Invalid environment for ${authorization.operation}.`],
    [definition.reasonCodes.includes(authorization.purposeCode), ["purposeCode"], `Invalid purpose code for ${authorization.operation}.`],
    [authorization.requiresExactHead === requiresAuthoritativeHead(authorization.operation), ["requiresExactHead"], `Invalid exact-Head requirement for ${authorization.operation}.`],
  ];
  for (const [valid, pathValue, message] of failures) {
    if (!valid) context.addIssue({ code: "custom", path: /** @type {(string | number)[]} */ (pathValue), message: /** @type {string} */ (message) });
  }
  const constraints = definition.constraints.safeParse(authorization.constraints);
  if (!constraints.success) {
    for (const issue of constraints.error.issues) {
      context.addIssue({ ...issue, path: ["constraints", ...issue.path] });
    }
    return z.NEVER;
  }
  const expectedPurpose = operationPurposeDefinitions[authorization.operation](constraints.data);
  if (authorization.purpose !== expectedPurpose) {
    context.addIssue({ code: "custom", path: ["purpose"], message: `Operation ${authorization.operation} requires purpose: ${expectedPurpose}` });
    return z.NEVER;
  }
  if (failures.some(([valid]) => !valid)) return z.NEVER;
  return { ...authorization, constraints: constraints.data };
});
const issueContractInputSchema = z.object({
  schemaVersion: z.literal(2),
  issue: z.number().int().positive(),
  repository: repositorySchema,
  goal: singleLineSchema,
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
  dependencies: z.array(z.number().int().positive()),
  externalAuthorizations: z.array(externalAuthorizationSchema),
}).strict();
const issueContractSchema = issueContractInputSchema.extend({
  authority: z.object({ commitSha: shaSchema, digest: digestSchema }).strict(),
  fetchedAt: timestampSchema,
  digest: digestSchema,
}).strict();

const receiptBindingSchema = z.object({
  receiptId: receiptIdSchema,
  requestId: externalRequestBaseSchema.shape.requestId,
  service: z.enum(["github", "supabase", "vercel", "cloudflare"]),
  operatorLabel: operatorLabelSchema,
  executionRole: externalOperatorRoleSchema,
  executionSurface: executionSurfaceSchema,
  authorityDigest: digestSchema,
  issueContractDigest: digestSchema,
  authorizationDigest: digestSchema,
  requestDigest: digestSchema,
  mutationDigest: digestSchema,
}).strict();
const observationPairSchema = z.object({
  accountObservation: z.unknown(),
  targetObservation: z.unknown(),
  observedAt: timestampSchema,
}).strict();
const preflightReceiptSchema = receiptBindingSchema.extend({
  schemaVersion: z.literal(1),
  accountObservation: z.unknown(),
  targetObservation: z.unknown(),
  observedAt: timestampSchema,
  expiresAt: timestampSchema,
}).strict();
const operationResultSchema = receiptBindingSchema.extend({
  schemaVersion: z.literal(1),
  preflight: observationPairSchema,
  postflight: observationPairSchema,
  outcome: z.unknown(),
}).strict();

/** @type {Record<Operation, import("zod").ZodObject<any>>} */
const operationSuccessEvidenceSchemas = {
  "github.read_issue": z.object({ issue: z.number().int().positive(), state: z.enum(["OPEN", "CLOSED"]), updatedAt: timestampSchema }).strict(),
  "github.push_branch": z.object({ branch: branchSchema, headSha: shaSchema }).strict(),
  "github.create_pr": z.object({
    issue: z.number().int().positive(),
    branch: branchSchema,
    baseBranch: z.literal("main"),
    headSha: shaSchema,
    prNumber: z.number().int().positive(),
    state: z.literal("OPEN"),
  }).strict(),
  "github.merge_pr": z.object({
    issue: z.number().int().positive(),
    prNumber: z.number().int().positive(),
    headSha: shaSchema,
    method: z.literal("squash"),
    mergeCommitSha: shaSchema,
    issueClosed: z.literal(true),
  }).strict(),
  "github.delete_branch": z.object({
    branch: branchSchema,
    mergedPrNumber: z.number().int().positive(),
    headSha: shaSchema,
    deleted: z.literal(true),
  }).strict(),
  "github.update_ruleset": z.object({
    issue: z.number().int().positive(),
    rulesetName: z.literal("main exact-Head review"),
    targetBranch: z.literal("main"),
    rulesetId: z.number().int().positive(),
    enforcement: z.literal("active"),
    requiredCheckName: z.literal("Exact Head review policy"),
  }).strict(),
  "supabase.inspect_project": z.object({
    projectRefSource: z.literal("config/ownership.json"),
    projectRefDigest: digestSchema,
    status: z.literal("reachable"),
  }).strict(),
  "supabase.apply_migrations": z.object({
    projectRefSource: z.literal("config/ownership.json"),
    projectRefDigest: digestSchema,
    appliedMigrations: operationDefinitions["supabase.apply_migrations"].inputs.shape.migrations,
  }).strict(),
  "vercel.inspect_project": z.object({
    projectSource: z.literal("config/ownership.json"),
    projectIdDigest: digestSchema,
    status: z.literal("reachable"),
  }).strict(),
  "vercel.deploy_preview": z.object({
    projectSource: z.literal("config/ownership.json"),
    deploymentId: singleLineSchema,
    projectIdDigest: digestSchema,
    headSha: shaSchema,
    environment: z.literal("preview"),
  }).strict(),
  "vercel.deploy_production": z.object({
    projectSource: z.literal("config/ownership.json"),
    deploymentId: singleLineSchema,
    projectIdDigest: digestSchema,
    headSha: shaSchema,
    environment: z.literal("production"),
  }).strict(),
  "cloudflare.inspect_zone": z.object({
    zoneSource: z.literal("config/ownership.json"),
    zoneIdDigest: digestSchema,
    zonePlan: z.enum(["Free", "Pro", "Business", "Enterprise"]),
    recordSetDigest: digestSchema,
  }).strict(),
  "cloudflare.upsert_dns": z.object({
    zoneSource: z.literal("config/ownership.json"),
    recordId: singleLineSchema,
    zoneIdDigest: digestSchema,
    recordName: operationDefinitions["cloudflare.upsert_dns"].inputs.shape.recordName,
    recordType: operationDefinitions["cloudflare.upsert_dns"].inputs.shape.recordType,
    target: operationDefinitions["cloudflare.upsert_dns"].inputs.shape.target,
    proxied: z.literal(false),
  }).strict(),
};

/** @type {Record<Operation, Array<[string, string, string]>>} */
const operationResultInputBindings = {
  "github.read_issue": [["issue", "issue", "Issue"]],
  "github.push_branch": [["branch", "branch", "branch"], ["headSha", "headSha", "Head SHA"]],
  "github.create_pr": [["issue", "issue", "Issue"], ["branch", "branch", "branch"], ["baseBranch", "baseBranch", "base branch"], ["headSha", "headSha", "Head SHA"]],
  "github.merge_pr": [["issue", "issue", "Issue"], ["prNumber", "prNumber", "PR number"], ["headSha", "headSha", "Head SHA"], ["method", "method", "merge method"]],
  "github.delete_branch": [["branch", "branch", "branch"], ["mergedPrNumber", "mergedPrNumber", "merged PR number"], ["headSha", "headSha", "Head SHA"]],
  "github.update_ruleset": [["issue", "issue", "Issue"], ["rulesetName", "rulesetName", "ruleset name"], ["targetBranch", "targetBranch", "target branch"], ["requiredCheckName", "requiredCheckName", "required check"], ["enforcement", "enforcement", "ruleset enforcement"]],
  "supabase.inspect_project": [["projectRefSource", "projectRefSource", "Supabase project source"]],
  "supabase.apply_migrations": [["projectRefSource", "projectRefSource", "Supabase project source"], ["migrations", "appliedMigrations", "migration list"]],
  "vercel.inspect_project": [["projectSource", "projectSource", "Vercel project source"]],
  "vercel.deploy_preview": [["projectSource", "projectSource", "Vercel project source"], ["headSha", "headSha", "Head SHA"]],
  "vercel.deploy_production": [["projectSource", "projectSource", "Vercel project source"], ["headSha", "headSha", "Head SHA"]],
  "cloudflare.inspect_zone": [["zoneSource", "zoneSource", "Cloudflare zone source"]],
  "cloudflare.upsert_dns": [["zoneSource", "zoneSource", "Cloudflare zone source"], ["recordName", "recordName", "DNS record name"], ["recordType", "recordType", "DNS record type"], ["target", "target", "DNS target"], ["proxied", "proxied", "DNS proxy mode"]],
};

/** @type {Partial<Record<Operation, [string, string]>>} */
const operationTargetDigestBindings = {
  "supabase.inspect_project": ["projectRefDigest", "Supabase project reference"],
  "supabase.apply_migrations": ["projectRefDigest", "Supabase project reference"],
  "vercel.inspect_project": ["projectIdDigest", "Vercel project reference"],
  "vercel.deploy_preview": ["projectIdDigest", "Vercel project reference"],
  "vercel.deploy_production": ["projectIdDigest", "Vercel project reference"],
  "cloudflare.inspect_zone": ["zoneIdDigest", "Cloudflare zone reference"],
  "cloudflare.upsert_dns": ["zoneIdDigest", "Cloudflare zone reference"],
};

for (const operation of operationNames) {
  const inputFields = Object.keys(operationDefinitions[operation].inputs.shape).sort();
  const boundFields = operationResultInputBindings[operation].map(([inputField]) => inputField).sort();
  if (canonicalJson(inputFields) !== canonicalJson(boundFields)) {
    throw new Error(`Operation ${operation} result binding does not enumerate every frozen mutation input.`);
  }
}

const acceptanceEvidenceSchema = z.object({
  id: acceptanceIdSchema,
  status: z.enum(["supported", "unsupported"]),
  evidence: z.array(singleLineSchema).min(1),
}).strict();
const verificationSchema = z.object({
  schemaVersion: z.literal(1),
  issue: z.number().int().positive(),
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
}).extend({
  primaryModel: modelSchema,
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
  schemaVersion: z.literal(1),
  issue: z.number().int().positive(),
  primaryModel: modelSchema,
  reviewerModel: modelSchema,
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
  if (value.primaryModel === value.reviewerModel) {
    context.addIssue({ code: "custom", path: ["reviewerModel"], message: "Self-approval is forbidden." });
  }
  if (value.headSha !== value.verifySha) {
    context.addIssue({ code: "custom", path: ["verifySha"], message: "Review Head and verification SHA must match." });
  }
  if (value.verdict === "approved" && value.findings.some(({ blocking }) => blocking)) {
    context.addIssue({ code: "custom", path: ["verdict"], message: "An approved review cannot contain blocking findings." });
  }
  if (value.verdict === "unavailable" && !value.unavailableReason) {
    context.addIssue({ code: "custom", path: ["unavailableReason"], message: "Unavailable review needs a fixed reason." });
  }
  if (value.verdict !== "unavailable" && value.unavailableReason) {
    context.addIssue({ code: "custom", path: ["unavailableReason"], message: "Unavailable reason is only valid for unavailable review." });
  }
});

const reviewPacketSchema = z.object({
  schemaVersion: z.literal(1),
  issue: z.number().int().positive(),
  repository: repositorySchema,
  primaryModel: modelSchema,
  reviewerModel: modelSchema,
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

/** @param {unknown} input @param {string} fetchedAt @param {unknown} protectedAuthorityValue */
export function snapshotIssueContract(input, fetchedAt, protectedAuthorityValue) {
  const parsed = issueContractInputSchema.parse(input);
  const protectedAuthority = z.object({
    commitSha: shaSchema,
    authority: z.unknown(),
    digest: digestSchema,
  }).strict().parse(protectedAuthorityValue);
  const authority = parseAuthority(protectedAuthority.authority);
  const digest = authorityDigest(authority);
  if (protectedAuthority.digest !== digest) throw new Error("Protected authority digest mismatch.");
  const repository = `${authority.resourceTargets.github.owner}/${authority.resourceTargets.github.repository}`;
  if (parsed.repository !== repository) throw new Error("Issue repository does not match protected authority.");
  unique(parsed.acceptanceCriteria.map(({ id }) => id), "Acceptance criteria");
  unique(parsed.dependencies.map(String), "Dependencies");
  unique(parsed.externalAuthorizations.map(({ operation }) => operation), "External authorizations");
  for (const authorization of parsed.externalAuthorizations) {
    if ("issue" in authorization.constraints && authorization.constraints.issue !== parsed.issue) {
      throw new Error("External authorization Issue constraint does not match the Issue contract.");
    }
  }
  const contract = {
    ...parsed,
    authority: { commitSha: protectedAuthority.commitSha, digest },
    fetchedAt,
  };
  return issueContractSchema.parse({ ...contract, digest: digestValue(contract) });
}

/** @param {unknown} value */
export function validateIssueContract(value) {
  const contract = issueContractSchema.parse(value);
  unique(contract.acceptanceCriteria.map(({ id }) => id), "Acceptance criteria");
  unique(contract.dependencies.map(String), "Dependencies");
  unique(contract.externalAuthorizations.map(({ operation }) => operation), "External authorizations");
  for (const authorization of contract.externalAuthorizations) {
    if ("issue" in authorization.constraints && authorization.constraints.issue !== contract.issue) {
      throw new Error("External authorization Issue constraint does not match the Issue contract.");
    }
  }
  if (digestValue(contract) !== contract.digest) throw new Error("Issue contract digest mismatch.");
  return contract;
}

/** @param {ReturnType<typeof parseAuthority>} authority @param {"github" | "supabase" | "vercel" | "cloudflare"} service */
function resolveOwnershipTarget(authority, service) {
  if (service === "github") return `${authority.resourceTargets.github.owner}/${authority.resourceTargets.github.repository}`;
  if (service === "supabase" && authority.resourceTargets.supabase.projectRef) return authority.resourceTargets.supabase.projectRef;
  if (service === "vercel") return authority.resourceTargets.vercel.projectId;
  if (service === "cloudflare") return authority.resourceTargets.cloudflare.zoneId;
  throw new Error(`Protected authority target ${service} is not configured.`);
}

/**
 * Load only the protected ref's committed authority. Candidate filesystem contents are never consulted.
 * @param {string} root
 * @param {string} baseRef
 */
export function loadProtectedAuthority(root, baseRef) {
  if (typeof baseRef !== "string") throw new Error("Protected authority requires a protected branch ref.");
  if (baseRef.startsWith("refs/") && !baseRef.startsWith("refs/heads/")) {
    throw new Error("Protected authority requires a protected branch ref.");
  }
  const branchName = baseRef.startsWith("refs/heads/") ? baseRef.slice("refs/heads/".length) : baseRef;
  let checkedBranch;
  try {
    checkedBranch = runGit(root, ["check-ref-format", "--branch", branchName]).trim();
  } catch {
    throw new Error("Protected authority requires a protected branch ref.");
  }
  if (checkedBranch !== branchName) throw new Error("Protected authority requires a protected branch ref.");
  const canonicalRef = `refs/heads/${branchName}`;
  const commitSha = runGit(root, ["rev-parse", "--verify", `${canonicalRef}^{commit}`]).trim();
  shaSchema.parse(commitSha);
  return loadAuthorityAtCommit(root, commitSha);
}

/** @param {string} root @param {string} commitSha */
function loadAuthorityAtCommit(root, commitSha) {
  shaSchema.parse(commitSha);
  const serialized = runGit(root, ["show", `${commitSha}:config/ownership.json`]);
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Protected authority is not valid JSON.");
  }
  const authority = parseAuthority(value);
  return { commitSha, authority, digest: authorityDigest(authority) };
}

/** @param {unknown} contractValue @param {unknown} requestValue */
export function resolveExternalAuthorization(contractValue, requestValue) {
  const contract = validateIssueContract(contractValue);
  const request = externalRequestBaseSchema.parse(requestValue);
  if (contract.issue !== request.issue) throw new Error("Operation request Issue does not match the frozen Issue contract.");
  const authorization = contract.externalAuthorizations.find(({ operation }) => operation === request.operation);
  if (!authorization) throw new Error(`Operation ${request.operation} is outside the frozen Issue contract.`);
  const definition = operationDefinitions[request.operation];
  const expectedPurpose = operationPurposeDefinitions[request.operation](authorization.constraints);
  if (authorization.purpose !== expectedPurpose) {
    throw new Error(`Operation ${request.operation} has an invalid frozen purpose.`);
  }
  if (request.target.kind !== definition.targetKind) {
    throw new Error(`Operation ${request.operation} requires target kind ${definition.targetKind}.`);
  }
  if (request.target.identifier !== authorization.targetRef) {
    throw new Error(`Operation ${request.operation} requires target reference ${authorization.targetRef}.`);
  }
  if (request.environment !== authorization.environment) throw new Error(`Invalid environment for ${request.operation}.`);
  if (request.reasonCode !== authorization.purposeCode) throw new Error(`Invalid purpose code for ${request.operation}.`);
  const inputs = definition.inputs.parse(request.inputs);
  for (const [key, expected] of Object.entries(authorization.constraints)) {
    if (canonicalJson(inputs[key]) !== canonicalJson(expected)) {
      throw new Error(`Operation ${request.operation} does not match frozen constraint ${key}.`);
    }
  }
  return authorization;
}

/** @param {unknown} value @param {string} [root] @param {unknown} [contractValue] */
export function validateExternalOperationRequest(value, root = defaultRoot, contractValue) {
  const request = externalRequestBaseSchema.parse(value);
  const contract = validateIssueContract(contractValue ?? JSON.parse(readFileSync(
    resolveInside(root, `.artifacts/issues/${request.issue}/issue-contract.json`, `.artifacts/issues/${request.issue}`),
    "utf8",
  )));
  const definition = operationDefinitions[request.operation];
  const expectedPrefix = `issue-${request.issue}-${request.operation.replace(/[._]/gu, "-")}-`;
  if (!request.requestId.startsWith(expectedPrefix)) throw new Error("Operation requestId does not match its Issue and operation.");
  const inputs = definition.inputs.parse(request.inputs);
  if ("issue" in inputs && inputs.issue !== request.issue) {
    throw new Error("Operation request Issue does not match operation inputs.");
  }
  const authorization = resolveExternalAuthorization(contract, { ...request, inputs });
  const currentProtectedAuthority = loadProtectedAuthority(root, protectedAuthorityRef);
  let protectedMergeBase;
  try {
    protectedMergeBase = runGit(root, ["merge-base", currentProtectedAuthority.commitSha, contract.authority.commitSha]).trim();
  } catch {
    throw new Error("Operation request authority commit is not reachable from the protected base ref.");
  }
  if (protectedMergeBase !== contract.authority.commitSha) {
    throw new Error("Operation request authority commit is not reachable from the protected base ref.");
  }
  const protectedAuthority = contract.authority.commitSha === currentProtectedAuthority.commitSha
    ? currentProtectedAuthority
    : loadAuthorityAtCommit(root, contract.authority.commitSha);
  if (protectedAuthority.commitSha !== contract.authority.commitSha || protectedAuthority.digest !== contract.authority.digest) {
    throw new Error("Operation request protected authority snapshot does not match the frozen Issue contract.");
  }
  if (!protectedAuthority.authority.authorization.operatorLabels.includes(request.operatorLabel)) {
    throw new Error("Operation request operator label is not authorized by protected authority.");
  }
  if (!protectedAuthority.authority.authorization.externalOperatorRoles.includes(request.executionRole)) {
    throw new Error("Operation request execution role is not authorized by protected authority.");
  }
  const serviceUse = authorizeServiceUse(protectedAuthority.authority, {
    service: definition.service,
    operation: request.operation,
    purposeCode: authorization.purposeCode,
    explicitUserPurpose: authorization.purposeCode === "user-directed" ? authorization.purpose : null,
  });
  if (!serviceUse.targetRef) throw new Error(`Protected authority target ${definition.service} is not configured.`);
  return {
    ...request,
    inputs,
    authorization,
    authority: contract.authority,
    resolvedAccountRef: serviceUse.accountRef,
    resolvedTargetRef: serviceUse.targetRef,
    resolvedTarget: resolveOwnershipTarget(protectedAuthority.authority, definition.service),
    expectedEvidence: definition.evidence,
  };
}

/**
 * Receipt validators are deliberately stateless across callers. The guarded adapter owns one state
 * instance for its execution boundary and must persist/serialize that boundary when processes change.
 */
export function createOperationReceiptState() {
  return {
    validatedPreflights: new Map(),
    executionClaims: new Map(),
    mutationClaims: new Map(),
    consumedReceiptIds: new Set(),
  };
}

/** @param {unknown} value */
function parseReceiptState(value) {
  if (!value || typeof value !== "object") throw new Error("Receipt validation requires caller-owned receipt state.");
  const state = /** @type {{ validatedPreflights?: unknown, executionClaims?: unknown, mutationClaims?: unknown, consumedReceiptIds?: unknown }} */ (value);
  if (
    !(state.validatedPreflights instanceof Map) ||
    !(state.executionClaims instanceof Map) ||
    !(state.mutationClaims instanceof Map) ||
    !(state.consumedReceiptIds instanceof Set)
  ) {
    throw new Error("Receipt validation requires caller-owned preflight, execution-claim, mutation, and terminal state.");
  }
  return /** @type {{ validatedPreflights: Map<string, any>, executionClaims: Map<string, any>, mutationClaims: Map<string, any>, consumedReceiptIds: Set<string> }} */ (state);
}

/** @param {unknown} value @param {string} label */
function receiptTimestamp(value, label) {
  const parsed = timestampSchema.parse(value);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid.`);
  return { value: parsed, milliseconds };
}

/** @param {unknown} contextValue */
function resolveReceiptContext(contextValue) {
  if (!contextValue || typeof contextValue !== "object") throw new Error("Receipt validation context is required.");
  const context = /** @type {Record<string, any>} */ (contextValue);
  if (typeof context.root !== "string" || context.root.length === 0) throw new Error("Receipt validation root is required.");
  const executionSurface = executionSurfaceSchema.parse(context.executionSurface);
  const now = receiptTimestamp(context.now ?? new Date().toISOString(), "Receipt validation time");
  const receiptState = parseReceiptState(context.receiptState);
  const contract = validateIssueContract(context.contract);
  const request = externalRequestBaseSchema.parse(context.request);
  const validatedRequest = validateExternalOperationRequest(request, context.root, contract);
  const authoritySnapshot = loadAuthorityAtCommit(context.root, contract.authority.commitSha);
  if (authoritySnapshot.digest !== contract.authority.digest) {
    throw new Error("Receipt protected authority digest mismatch.");
  }
  return {
    root: context.root,
    executionSurface,
    now,
    receiptState,
    contract,
    request,
    validatedRequest,
    authority: authoritySnapshot.authority,
    service: operationDefinitions[request.operation].service,
  };
}

/** @param {ReturnType<typeof resolveReceiptContext>} context */
function expectedReceiptBinding(context) {
  return {
    requestId: context.request.requestId,
    service: context.service,
    operatorLabel: context.request.operatorLabel,
    executionRole: context.request.executionRole,
    executionSurface: context.request.executionSurface,
    authorityDigest: context.contract.authority.digest,
    issueContractDigest: context.contract.digest,
    authorizationDigest: digestValue(context.validatedRequest.authorization),
    requestDigest: digestValue(context.request),
    mutationDigest: digestValue({ operation: context.request.operation, inputs: context.request.inputs }),
  };
}

/** @param {Record<string, any>} actual @param {ReturnType<typeof expectedReceiptBinding>} expected @param {string} actualSurface */
function assertReceiptBinding(actual, expected, actualSurface) {
  /** @type {Record<string, string>} */
  const labels = {
    requestId: "request ID",
    service: "service",
    operatorLabel: "operator label",
    executionRole: "execution role",
    executionSurface: "execution surface",
    authorityDigest: "authority digest",
    issueContractDigest: "Issue contract digest",
    authorizationDigest: "authorization digest",
    requestDigest: "request digest",
    mutationDigest: "mutation digest",
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (actual[key] !== expectedValue) throw new Error(`Receipt ${labels[key]} mismatch.`);
  }
  if (actual.executionSurface !== actualSurface) throw new Error("Receipt execution surface does not match the live adapter surface.");
}

/** @param {unknown} value @param {unknown} contextValue */
export function validatePreflightReceipt(value, contextValue) {
  const receipt = preflightReceiptSchema.parse(value);
  const context = resolveReceiptContext(contextValue);
  if (context.receiptState.consumedReceiptIds.has(receipt.receiptId)) {
    throw new Error("Preflight receipt ID has already been consumed and cannot be reused.");
  }
  if (context.receiptState.validatedPreflights.has(receipt.receiptId)) {
    throw new Error("Preflight receipt ID has already been validated and cannot be reused.");
  }
  assertReceiptBinding(receipt, expectedReceiptBinding(context), context.executionSurface);
  const observedAt = receiptTimestamp(receipt.observedAt, "Preflight observedAt");
  const expiresAt = receiptTimestamp(receipt.expiresAt, "Preflight expiresAt");
  if (observedAt.milliseconds > context.now.milliseconds) throw new Error("Preflight receipt observation is dated in the future.");
  if (expiresAt.milliseconds <= context.now.milliseconds) throw new Error("Preflight receipt is expired or stale.");
  if (expiresAt.milliseconds <= observedAt.milliseconds || expiresAt.milliseconds - observedAt.milliseconds > 120_000) {
    throw new Error("Preflight receipt validity window must be positive and no longer than two minutes.");
  }
  const identity = evaluateAccountObservation(context.authority, {
    service: receipt.service,
    account: receipt.accountObservation,
    target: receipt.targetObservation,
  });
  if (identity.accountRef !== context.validatedRequest.resolvedAccountRef) throw new Error("Preflight account reference mismatch.");
  if (identity.targetRef !== context.validatedRequest.resolvedTargetRef) throw new Error("Preflight target reference mismatch.");
  const validated = {
    ok: true,
    receiptId: receipt.receiptId,
    requestId: receipt.requestId,
    issue: context.contract.issue,
    service: receipt.service,
    operatorLabel: receipt.operatorLabel,
    executionRole: receipt.executionRole,
    executionSurface: receipt.executionSurface,
    authorityDigest: receipt.authorityDigest,
    issueContractDigest: receipt.issueContractDigest,
    authorizationDigest: receipt.authorizationDigest,
    requestDigest: receipt.requestDigest,
    mutationDigest: receipt.mutationDigest,
    accountRefDigest: digestValue(identity.accountRef),
    targetRefDigest: digestValue(identity.targetRef),
    accountObservationDigest: digestValue(receipt.accountObservation),
    targetObservationDigest: digestValue(receipt.targetObservation),
    observedAt: receipt.observedAt,
    expiresAt: receipt.expiresAt,
    validatedAt: context.now.value,
    warnings: identity.warnings,
  };
  context.receiptState.validatedPreflights.set(receipt.receiptId, {
    ...validated,
    receiptDigest: digestValue(receipt),
  });
  return validated;
}

/** @param {unknown} receiptIdValue @param {unknown} contextValue */
export function claimOperationExecution(receiptIdValue, contextValue) {
  const receiptId = receiptIdSchema.parse(receiptIdValue);
  if (!contextValue || typeof contextValue !== "object") throw new Error("Execution claim context is required.");
  const context = /** @type {Record<string, any>} */ (contextValue);
  const receiptState = parseReceiptState(context.receiptState);
  const now = receiptTimestamp(context.now ?? new Date().toISOString(), "Execution claim time");
  if (receiptState.consumedReceiptIds.has(receiptId)) {
    throw new Error("Receipt execution is already terminal; mutation retry is forbidden.");
  }
  if (receiptState.executionClaims.has(receiptId)) {
    throw new Error("Receipt execution has already been claimed; mutation retry is forbidden.");
  }
  const preflight = receiptState.validatedPreflights.get(receiptId);
  if (!preflight) throw new Error("Execution claim requires a valid preflight receipt.");
  if (now.milliseconds < Date.parse(preflight.validatedAt)) {
    throw new Error("Execution claim time predates preflight validation.");
  }
  if (now.milliseconds >= Date.parse(preflight.expiresAt)) {
    throw new Error("Preflight receipt is expired or stale at execution claim time.");
  }
  const existingMutation = receiptState.mutationClaims.get(preflight.mutationDigest);
  if (existingMutation) {
    const phase = existingMutation.status === "finalized" ? "terminal" : "already claimed";
    throw new Error(`The same mutation is ${phase}; mutation retry under another receipt ID is forbidden.`);
  }
  const claim = {
    ok: true,
    status: "claimed",
    receiptId,
    requestId: preflight.requestId,
    requestDigest: preflight.requestDigest,
    mutationDigest: preflight.mutationDigest,
    startedAt: now.value,
  };
  receiptState.validatedPreflights.delete(receiptId);
  receiptState.executionClaims.set(receiptId, { ...preflight, ...claim });
  receiptState.mutationClaims.set(preflight.mutationDigest, {
    status: "claimed",
    receiptId,
    requestDigest: preflight.requestDigest,
    mutationDigest: preflight.mutationDigest,
    startedAt: now.value,
  });
  return claim;
}

/** @param {Operation} operation */
function operationOutcomeSchema(operation) {
  const successEvidenceSchema = operationSuccessEvidenceSchemas[operation];
  const terminalEvidenceBase = {
    operation: z.literal(operation),
    detailDigest: digestSchema,
  };
  return z.discriminatedUnion("status", [
    z.object({
      status: z.literal("succeeded"),
      evidence: successEvidenceSchema,
      evidenceDigest: digestSchema,
    }).strict(),
    z.object({
      status: z.literal("failed"),
      retryPolicy: z.literal("forbidden"),
      evidence: z.object({
        ...terminalEvidenceBase,
        errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/u),
        providerState: z.enum(["unchanged", "unknown"]),
      }).strict(),
      evidenceDigest: digestSchema,
    }).strict(),
    z.object({
      status: z.literal("ambiguous"),
      retryPolicy: z.literal("inspect-provider-state-only"),
      evidence: z.object({
        ...terminalEvidenceBase,
        reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/u),
        providerState: z.literal("unknown"),
      }).strict(),
      evidenceDigest: digestSchema,
    }).strict(),
  ]);
}

/** @param {Operation} operation @param {Record<string, any>} evidence @param {Record<string, any>} inputs @param {string} targetRef @param {unknown} postTarget */
function validateOperationSuccessEvidence(operation, evidence, inputs, targetRef, postTarget) {
  const checks = operationResultInputBindings[operation].map(([inputField, evidenceField, label]) => [
    canonicalJson(evidence[evidenceField]),
    canonicalJson(inputs[inputField]),
    label,
  ]);
  const targetBinding = operationTargetDigestBindings[operation];
  if (targetBinding) checks.push([evidence[targetBinding[0]], digestValue(targetRef), targetBinding[1]]);
  if (operation === "cloudflare.inspect_zone" && postTarget && typeof postTarget === "object") {
    checks.push([evidence.zonePlan, /** @type {Record<string, any>} */ (postTarget).zonePlan, "Cloudflare zone plan"]);
  }
  for (const [actual, expected, label] of checks) {
    if (actual !== expected) throw new Error(`Operation result ${label} does not match the frozen mutation request.`);
  }
}

/**
 * Validates only operation-specific, redacted result evidence. Full result callers still validate
 * authority, request, claim, and observation continuity through validateOperationResult.
 * @param {unknown} operationValue @param {unknown} outcomeValue @param {unknown} contextValue
 */
export function validateOperationResultEvidence(operationValue, outcomeValue, contextValue) {
  const operation = operationSchema.parse(operationValue);
  if (!contextValue || typeof contextValue !== "object") throw new Error("Operation result evidence context is required.");
  const context = /** @type {Record<string, any>} */ (contextValue);
  const inputs = operationDefinitions[operation].inputs.parse(context.inputs);
  const targetRef = z.string().min(1).parse(context.targetRef);
  const outcome = operationOutcomeSchema(operation).parse(outcomeValue);
  if (outcome.evidenceDigest !== digestValue(outcome.evidence)) {
    throw new Error("Operation result evidence digest does not match the validated redacted evidence.");
  }
  if (outcome.status === "succeeded") {
    validateOperationSuccessEvidence(operation, outcome.evidence, inputs, targetRef, context.postTarget);
  }
  return outcome;
}

/** @param {unknown} value @param {unknown} contextValue */
export function validateOperationResult(value, contextValue) {
  const result = operationResultSchema.parse(value);
  const context = resolveReceiptContext(contextValue);
  if (context.receiptState.consumedReceiptIds.has(result.receiptId)) {
    throw new Error("Execution claim has already been finalized; result receipt reuse is forbidden.");
  }
  const claim = context.receiptState.executionClaims.get(result.receiptId);
  if (!claim) throw new Error("Operation result requires an atomic execution claim before mutation.");
  assertReceiptBinding(result, expectedReceiptBinding(context), context.executionSurface);
  if (result.requestDigest !== claim.requestDigest || result.mutationDigest !== claim.mutationDigest) {
    throw new Error("Operation result does not match the claimed request and mutation digests.");
  }
  if (result.preflight.observedAt !== claim.observedAt) throw new Error("Result preflight observation timestamp mismatch.");
  const postObservedAt = receiptTimestamp(result.postflight.observedAt, "Result postflight observedAt");
  if (postObservedAt.milliseconds <= Date.parse(claim.startedAt)) throw new Error("Result postflight observation must be after execution startedAt.");
  if (postObservedAt.milliseconds > context.now.milliseconds) throw new Error("Operation result observation is dated in the future.");
  if (context.now.milliseconds - postObservedAt.milliseconds > 120_000) throw new Error("Operation result observation is stale.");
  const identity = evaluateAccountObservation(context.authority, {
    service: result.service,
    account: result.postflight.accountObservation,
    target: result.postflight.targetObservation,
    previousAccount: result.preflight.accountObservation,
    previousTarget: result.preflight.targetObservation,
  });
  if (digestValue(result.preflight.accountObservation) !== claim.accountObservationDigest) {
    throw new Error("Result preflight account observation does not match the validated receipt.");
  }
  if (digestValue(result.preflight.targetObservation) !== claim.targetObservationDigest) {
    throw new Error("Result preflight target observation does not match the validated receipt.");
  }
  if (digestValue(identity.accountRef) !== claim.accountRefDigest) throw new Error("Result account reference does not match preflight.");
  if (digestValue(identity.targetRef) !== claim.targetRefDigest) throw new Error("Result target reference does not match preflight.");
  const outcome = validateOperationResultEvidence(context.request.operation, result.outcome, {
    inputs: context.request.inputs,
    targetRef: context.validatedRequest.resolvedTargetRef,
    postTarget: result.postflight.targetObservation,
  });
  const validated = {
    ok: true,
    consumed: true,
    finalized: true,
    receiptId: result.receiptId,
    requestId: result.requestId,
    issue: context.contract.issue,
    service: result.service,
    operatorLabel: result.operatorLabel,
    executionRole: result.executionRole,
    executionSurface: result.executionSurface,
    authorityDigest: result.authorityDigest,
    issueContractDigest: result.issueContractDigest,
    authorizationDigest: result.authorizationDigest,
    requestDigest: result.requestDigest,
    mutationDigest: result.mutationDigest,
    accountRefDigest: digestValue(identity.accountRef),
    targetRefDigest: digestValue(identity.targetRef),
    outcome: outcome.status,
    ...(outcome.status === "succeeded" ? {} : { retryPolicy: outcome.retryPolicy }),
    evidence: outcome.evidence,
    evidenceDigest: outcome.evidenceDigest,
    startedAt: claim.startedAt,
    observedAt: result.postflight.observedAt,
    warnings: identity.warnings,
  };
  context.receiptState.executionClaims.delete(result.receiptId);
  context.receiptState.consumedReceiptIds.add(result.receiptId);
  context.receiptState.mutationClaims.set(result.mutationDigest, {
    status: "finalized",
    receiptId: result.receiptId,
    requestDigest: result.requestDigest,
    mutationDigest: result.mutationDigest,
    startedAt: claim.startedAt,
    finalizedAt: context.now.value,
    outcome: outcome.status,
  });
  return validated;
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
  if (requiresAuthoritativeHead(request.operation)) {
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
  return verificationSchema.parse(value);
}

/** @param {unknown} value */
export function validateReviewResult(value) {
  const review = reviewResultSchema.parse(value);
  unique(review.contracts, "Review contracts");
  unique(review.acceptanceAssessment.map(({ id }) => id), "Review acceptance assessment");
  return review;
}

/** @param {unknown} value @param {string} root */
export function validateReviewPacket(value, root) {
  const packet = reviewPacketSchema.parse(value);
  if (packet.primaryModel === packet.reviewerModel) throw new Error("Review packet cannot request self-review.");
  if (workflowConfiguration.reviewerMap[packet.primaryModel] !== packet.reviewerModel) {
    throw new Error("Review packet does not use the opposite model.");
  }
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
  return packet;
}

/** @param {unknown} reviewValue @param {unknown} packetValue @param {string} root */
export function validateReviewAgainstPacket(reviewValue, packetValue, root) {
  const packet = validateReviewPacket(packetValue, root);
  const review = validateReviewResult(reviewValue);
  if (review.issue !== packet.issue) throw new Error("Review issue does not match the packet.");
  if (review.primaryModel !== packet.primaryModel) throw new Error("Review primaryModel does not match the packet.");
  if (review.reviewerModel !== packet.reviewerModel) throw new Error("Review reviewerModel does not match the packet.");
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
 * @param {{currentHeadSha:string, contract:unknown, verification:unknown, packet:unknown, review:unknown, root:string}} input
 */
export function runPremergeGate(input) {
  const contract = validateIssueContract(input.contract);
  const verification = validateVerification(input.verification);
  const packet = validateReviewPacket(input.packet, input.root);
  const review = validateReviewAgainstPacket(input.review, packet, input.root);
  if (input.currentHeadSha !== verification.headSha) throw new Error("Verification evidence is stale for the current Head SHA.");
  if (input.currentHeadSha !== review.headSha || input.currentHeadSha !== review.verifySha) {
    throw new Error("Review evidence is stale for the current Head SHA.");
  }
  if (packet.headSha !== input.currentHeadSha || packet.verifySha !== input.currentHeadSha) {
    throw new Error("Review packet is stale for the current Head SHA.");
  }
  if (verification.issue !== contract.issue || review.issue !== contract.issue) throw new Error("Evidence Issue mismatch.");
  if (packet.repository !== contract.repository) throw new Error("Review packet repository mismatch.");
  if (packet.baseSha !== verification.baseSha) throw new Error("Review packet base SHA mismatch.");
  if (verification.contractDigest !== contract.digest || review.contractDigest !== contract.digest) {
    throw new Error("Evidence contract digest mismatch.");
  }
  if (verification.status !== "passed" || verification.commands.some(({ status }) => status !== "passed")) {
    throw new Error("Mechanical verification has not passed.");
  }
  if (
    review.verdict !== "approved" ||
    review.findings.some(({ blocking, severity }) => blocking || ["critical", "high"].includes(severity))
  ) {
    throw new Error("Independent review has not approved the current Head.");
  }
  if (Date.parse(contract.fetchedAt) > Date.parse(verification.completedAt)) throw new Error("Verification predates the Issue contract.");
  if (Date.parse(verification.completedAt) > Date.parse(review.reviewedAt)) throw new Error("Review predates verification.");
  const ids = contract.acceptanceCriteria.map(({ id }) => id);
  checkExactAcceptanceMappings(ids, verification.acceptanceEvidence, "Verification evidence");
  checkExactAcceptanceMappings(ids, review.acceptanceAssessment, "Review assessment");
  return {
    ok: true,
    issue: contract.issue,
    headSha: input.currentHeadSha,
    contractDigest: contract.digest,
    reviewer: review.reviewerModel,
    reviewedAt: review.reviewedAt,
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
  const verification = validateVerification({
    schemaVersion: evidence.schemaVersion,
    issue: evidence.issue,
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
  const repositoryDiff = runGit(root, ["diff", "--no-ext-diff", "--no-renames", "--binary", baseSha, currentHeadSha, "--"]);
  const changedPaths = runGit(root, ["-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", "-z", baseSha, currentHeadSha, "--"])
    .split("\0")
    .filter(Boolean)
    .map((candidate) => relativeFileSchema.parse(candidate));
  if (changedPaths.length === 0) throw new Error("Review preparation requires at least one committed changed path.");
  const packet = validateReviewPacket({
    schemaVersion: 1,
    issue: evidence.issue,
    repository: contract.repository,
    primaryModel: evidence.primaryModel,
    reviewerModel: workflowConfiguration.reviewerMap[evidence.primaryModel],
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
  }, root);
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
  const packet = await readArtifactJson(root, `${headRoot}/review-packet.json`);
  const review = validateReviewAgainstPacket(value, packet, root);
  const reviewPath = `${headRoot}/review.json`;
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
  const review = await readArtifactJson(root, `${headRoot}/review.json`);
  const validatedPacket = validateReviewPacket(packet, root);
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

  return { currentHeadSha, contract, verification, packet, review, root };
}

/** @param {string} root @param {number} issue */
export async function runAuthoritativePremergeGate(root, issue) {
  return runPremergeGate(await loadAuthoritativeGateInput(root, issue));
}

/** @param {string} root @param {number} issue */
export async function renderAuthoritativePullRequestBody(root, issue) {
  return renderPullRequestBody(await loadAuthoritativeGateInput(root, issue));
}

/** @param {string} root @param {number} issue @param {number} prNumber @param {unknown} operatorMetadata */
export async function createMergeOperationRequest(root, issue, prNumber, operatorMetadata) {
  const input = await loadAuthoritativeGateInput(root, issue);
  const gate = runPremergeGate(input);
  const operator = z.object({
    operatorLabel: operatorLabelSchema,
    executionRole: externalOperatorRoleSchema,
    executionSurface: executionSurfaceSchema,
  }).strict().parse(operatorMetadata);
  const request = {
    schemaVersion: 1,
    requestId: `issue-${issue}-github-merge-pr-1`,
    issue,
    operation: "github.merge_pr",
    target: { kind: "github.repository", identifier: targetSources.github },
    environment: "production",
    reasonCode: "reviewed-release",
    ...operator,
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
  const review = validateReviewResult(input.review);
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
  return `Closes #${gate.issue}\n\n## Summary\n- ${safe(contract.goal)}\n\n## Verification\n- Head SHA: \`${gate.headSha}\`\n- Contract digest: \`${gate.contractDigest}\`\n${commands}\n\n## Acceptance evidence\n${evidence}\n\n## Opposite-model review\n- Primary: ${review.primaryModel}\n- Reviewer: ${review.reviewerModel}\n- Reviewed SHA: \`${review.headSha}\`\n- Verdict: ${review.verdict}\n- Contracts: ${review.contracts.join(", ")}\n\n## External changes\n${externalChanges}\n\n## Remaining work\n${remainingWork}\n`;
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
    `refs/heads/codex/${evidence.issue}-*`,
    `refs/heads/claude/${evidence.issue}-*`,
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
  schemaVersion: z.literal(1),
  fetchedAt: timestampSchema,
  completedAt: timestampSchema,
  reviewedAt: timestampSchema,
  issueContract: issueContractInputSchema,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  primaryModel: modelSchema,
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
  const branch = `${fixture.primaryModel}/${fixture.issueContract.issue}-${fixture.slug}`;
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, ".gitignore"), ".artifacts/\n", "utf8");
  await writeJson(path.join(root, "config", "ownership.json"), {
    schemaVersion: 2,
    authorization: {
      operatorLabels: ["codex", "claude"],
      externalOperatorRoles: ["implementer", "external-operator"],
      allowAutomaticAccountSwitch: false,
    },
    accounts: {
      github: { login: "fixture", userId: 1, nodeId: "fixture-user" },
      supabase: { organizationName: "fixture", organizationId: "abcdefghijklmnopqrst" },
      vercel: { teamName: "fixture", teamSlug: "fixture", teamId: "team_fixture", requiredPlan: "Hobby" },
      cloudflare: {
        accountName: "fixture",
        accountId: "1".repeat(32),
        loginEmailHint: "f***@example.invalid",
        loginEmailSha256: "2".repeat(64),
        requiredRole: "Super Administrator",
        allowedZonePlans: ["Free"],
      },
      linear: {
        workspaceName: "fixture",
        workspaceSlug: "fixture",
        workspaceUrl: "https://linear.app/fixture",
        workspaceId: null,
        userName: "fixture",
        userEmailHint: "f***@example.invalid",
        userEmailSha256: "3".repeat(64),
        userId: null,
        requiredRole: "Admin",
      },
    },
    servicePolicies: {
      github: { mode: "repository-active" },
      supabase: { mode: "repository-active" },
      vercel: { mode: "repository-active" },
      cloudflare: { mode: "repository-active" },
      linear: { mode: "explicit-user-purpose-only" },
    },
    resourceTargets: {
      github: {
        owner: fixture.issueContract.repository.split("/")[0],
        repository: fixture.issueContract.repository.split("/")[1],
        repositoryId: 1,
        repositoryNodeId: "fixture-repository",
      },
      supabase: { projectRef: "abcdefghijklmnopqrst" },
      vercel: { projectId: "prj_fixture" },
      cloudflare: { zoneId: "4".repeat(32), domains: ["fixture.example.com"] },
      linear: { teamKey: "FIX", teamId: null },
    },
    observations: {
      github: {
        displayName: "Fixture",
        createdAt: "2020-01-01T00:00:00Z",
        publicRepositories: 1,
        observedAt: fixture.fetchedAt,
      },
    },
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

  const protectedAuthority = loadProtectedAuthority(root, protectedAuthorityRef);
  const contract = snapshotIssueContract(fixture.issueContract, fixture.fetchedAt, protectedAuthority);
  const issueRootRelative = path.join(".artifacts", "issues", String(contract.issue));
  const headRootRelative = path.join(issueRootRelative, headSha);
  const issueRoot = path.resolve(root, issueRootRelative);
  const headRoot = path.resolve(root, headRootRelative);
  const contractPathRelative = path.join(issueRootRelative, "issue-contract.json").replaceAll("\\", "/");
  await writeJson(path.join(root, contractPathRelative), contract);
  const prepared = await prepareReviewArtifacts(root, {
    schemaVersion: 1,
    issue: contract.issue,
    primaryModel: fixture.primaryModel,
    status: "passed",
    commands: fixture.commands,
    acceptanceEvidence: fixture.acceptanceEvidence,
    externalChanges: fixture.externalChanges,
    remainingWork: fixture.remainingWork,
    completedAt: fixture.completedAt,
  });
  const packet = prepared.packet;
  const recorded = await recordReviewResult(root, contract.issue, {
    schemaVersion: 1,
    issue: contract.issue,
    primaryModel: packet.primaryModel,
    reviewerModel: packet.reviewerModel,
    headSha: packet.headSha,
    verifySha: packet.verifySha,
    contractDigest: contract.digest,
    verdict: "approved",
    contracts: packet.requiredContracts,
    findings: fixture.findings,
    acceptanceAssessment: fixture.acceptanceAssessment,
    reviewedAt: fixture.reviewedAt,
  });
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
  const merge = await createMergeOperationRequest(root, contract.issue, fixture.prNumber, {
    operatorLabel: fixture.primaryModel,
    executionRole: "implementer",
    executionSurface: "github-cli",
  });

  return { gate, state, branch, baseSha, headSha, request: merge.request, paths: {
    contract: contractPathRelative,
    verification: prepared.paths.verification,
    diff: prepared.paths.diff,
    packet: prepared.paths.packet,
    review: recorded.reviewPath,
    pullRequest: path.join(headRootRelative, "pull-request.md").replaceAll("\\", "/"),
    mergeRequest: merge.requestPath,
  } };
}

export const schemas = {
  issueContractInputSchema,
  issueContractSchema,
  verificationSchema,
  reviewResultSchema,
  reviewPacketSchema,
  cleanupPlanSchema,
};
