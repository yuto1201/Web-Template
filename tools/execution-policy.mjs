import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const knownFamilies = ["openai", "anthropic", "cursor", "xai"];
const familySchema = z.enum([...knownFamilies, "unknown"]);
const riskSchema = z.enum(["normal", "high"]);
const surfaceSchema = z.enum(["codex-local", "claude-local", "cursor-cloud"]);

/**
 * Temporary duplicate of workflow-core's operation list. Task 2 makes this
 * module canonical; the focused unit test prevents drift in the meantime.
 */
export const executionOperationNames = [
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

const operationSchema = z.enum(executionOperationNames);
const canonicalPathSchema = z.string().min(1).superRefine((value, context) => {
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

const regexSourceSchema = z.string().min(3).superRefine((value, context) => {
  if (!value.startsWith("^") || !value.endsWith("$")) {
    context.addIssue({ code: "custom", message: "Model family patterns must be anchored." });
    return;
  }
  try {
    new RegExp(value, "u");
  } catch {
    context.addIssue({ code: "custom", message: "Model family pattern must be a valid regular expression." });
  }
});

const prefixRuleSchema = z.object({
  type: z.literal("prefix"),
  path: z.string().min(1),
}).strict().superRefine((value, context) => {
  const candidate = value.path.endsWith("/") ? value.path.slice(0, -1) : value.path;
  const parsed = canonicalPathSchema.safeParse(candidate);
  if (!parsed.success) context.addIssue({ code: "custom", path: ["path"], message: "Expected a canonical POSIX prefix path." });
});

const exactRuleSchema = z.object({
  type: z.literal("exact"),
  path: canonicalPathSchema,
}).strict();

const executionPolicySchema = z.object({
  schemaVersion: z.literal(1),
  surfaces: z.object({
    "codex-local": z.object({ branchPrefix: z.literal("codex"), providerOperator: z.literal(true) }).strict(),
    "claude-local": z.object({ branchPrefix: z.literal("claude"), providerOperator: z.literal(false) }).strict(),
    "cursor-cloud": z.object({ branchPrefix: z.literal("cursor"), providerOperator: z.literal(true) }).strict(),
  }).strict(),
  modelFamilies: z.object({
    openai: z.array(regexSourceSchema).min(1),
    anthropic: z.array(regexSourceSchema).min(1),
    cursor: z.array(regexSourceSchema).min(1),
    xai: z.array(regexSourceSchema).min(1),
  }).strict(),
  cursorModels: z.object({
    openai: z.string().min(1),
    anthropic: z.string().min(1),
  }).strict(),
  highRiskPathRules: z.array(z.union([exactRuleSchema, prefixRuleSchema])).min(1),
  routineDeliveryOperations: z.array(operationSchema).min(1),
  highRiskOperations: z.array(operationSchema).min(1),
}).strict().superRefine((value, context) => {
  const ruleKeys = value.highRiskPathRules.map((rule) => `${rule.type}:${rule.path}`);
  if (new Set(ruleKeys).size !== ruleKeys.length) {
    context.addIssue({ code: "custom", path: ["highRiskPathRules"], message: "High-risk path rules must be unique." });
  }

  for (const key of /** @type {Array<"routineDeliveryOperations" | "highRiskOperations">} */ (["routineDeliveryOperations", "highRiskOperations"])) {
    if (new Set(value[key]).size !== value[key].length) {
      context.addIssue({ code: "custom", path: [key], message: `${key} must be unique.` });
    }
  }
  if (value.routineDeliveryOperations.some((operation) => value.highRiskOperations.includes(operation))) {
    context.addIssue({ code: "custom", message: "Routine and high-risk operations must not overlap." });
  }
});

const modelIdentityInputSchema = z.object({
  configured: z.string().min(1),
  observed: z.string().min(1),
  parameters: z.array(z.object({ id: z.string().min(1), value: z.string().min(1) }).strict()),
}).strict();

/**
 * @typedef {z.infer<typeof executionPolicySchema>} ExecutionPolicy
 */

/** @param {string} root @returns {Promise<ExecutionPolicy>} */
export async function loadExecutionPolicy(root) {
  const source = await readFile(path.join(root, "config", "execution.json"), "utf8");
  return executionPolicySchema.parse(JSON.parse(source));
}

/** @param {string} configured */
function configuredBaseModel(configured) {
  const match = /^(.*)\[[^\[\]]+\]$/u.exec(configured);
  return match ? match[1] : configured;
}

/** @param {string} observed @param {ExecutionPolicy} policy */
function classifyModelFamily(observed, policy) {
  for (const family of /** @type {Array<"openai" | "anthropic" | "cursor" | "xai">} */ (knownFamilies)) {
    if (policy.modelFamilies[family].some((source) => new RegExp(source, "u").test(observed))) return family;
  }
  return "unknown";
}

/**
 * @param {string} configured
 * @param {string} observed
 * @param {Array<{ id: string, value: string }>} parameters
 * @param {ExecutionPolicy} policy
 */
export function normalizeModelIdentity(configured, observed, parameters, policy) {
  const input = modelIdentityInputSchema.parse({ configured, observed, parameters });
  executionPolicySchema.parse(policy);
  return {
    configured: input.configured,
    observed: input.observed,
    family: classifyModelFamily(input.observed, policy),
    fallback: configuredBaseModel(input.configured) !== input.observed,
    parameters: [...input.parameters].sort((left, right) => left.id.localeCompare(right.id) || left.value.localeCompare(right.value)),
  };
}

/**
 * @param {string} branch
 * @param {number} issue
 * @param {"codex-local" | "claude-local" | "cursor-cloud"} surface
 * @param {ExecutionPolicy} policy
 */
export function validateBranchForSurface(branch, issue, surface, policy) {
  const parsedSurface = surfaceSchema.parse(surface);
  const parsedIssue = z.number().int().positive().parse(issue);
  const parsedBranch = z.string().parse(branch);
  const parsedPolicy = executionPolicySchema.parse(policy);
  const prefix = parsedPolicy.surfaces[parsedSurface].branchPrefix;
  const issuePrefix = `${prefix}/${parsedIssue}-`;

  if (!parsedBranch.startsWith(`${prefix}/`)) throw new Error(`Branch does not belong to surface ${parsedSurface}.`);
  if (!parsedBranch.startsWith(issuePrefix)) throw new Error(`Branch does not belong to issue ${parsedIssue}.`);
  if (!new RegExp(`^${prefix}/${parsedIssue}-[a-z0-9]+(?:-[a-z0-9]+)*$`, "u").test(parsedBranch)) {
    throw new Error("branch must use the canonical issue slug format.");
  }
  return parsedBranch;
}

/** @param {string} changedPath @param {{ type: "exact" | "prefix", path: string }} rule */
function matchesPathRule(changedPath, rule) {
  if (rule.type === "exact") return changedPath === rule.path;
  if (rule.path.endsWith("/")) return changedPath.startsWith(rule.path);
  return changedPath === rule.path || changedPath.startsWith(`${rule.path}/`);
}

const riskInputSchema = z.object({
  changedPaths: z.array(canonicalPathSchema),
  externalOperations: z.array(z.string()),
}).strict();

/** @param {{ changedPaths: string[], externalOperations: string[] }} input @param {ExecutionPolicy} policy */
export function classifyRisk(input, policy) {
  const parsedInput = riskInputSchema.parse(input);
  const parsedPolicy = executionPolicySchema.parse(policy);
  const reasons = new Set();

  for (const operation of parsedInput.externalOperations) {
    if (!executionOperationNames.includes(operation)) throw new Error(`Unknown external operation ${operation}.`);
  }

  for (const changedPath of parsedInput.changedPaths) {
    for (const rule of parsedPolicy.highRiskPathRules) {
      if (matchesPathRule(changedPath, rule)) reasons.add(`path:${rule.path}`);
    }
  }
  for (const operation of parsedInput.externalOperations) {
    if (parsedPolicy.highRiskOperations.includes(operation)) reasons.add(`operation:${operation}`);
  }

  const sortedReasons = [...reasons].sort((left, right) => left.localeCompare(right));
  return { level: sortedReasons.length === 0 ? "normal" : "high", reasons: sortedReasons };
}

/** @param {{ risk: "normal" | "high", primaryFamily: string }} input */
export function requiredReviewerFamilies(input) {
  const risk = riskSchema.parse(input.risk);
  const primaryFamily = familySchema.parse(input.primaryFamily);
  if (primaryFamily === "unknown") throw new Error("unknown primary model family cannot satisfy review policy.");
  if (risk === "high") return ["anthropic", "openai"];
  return [primaryFamily === "anthropic" ? "openai" : "anthropic"];
}

/** @param {{ risk: "normal" | "high", primaryFamily: string, reviewerFamilies: string[] }} input */
export function validateReviewerFamilies(input) {
  const parsed = z.object({
    risk: riskSchema,
    primaryFamily: familySchema,
    reviewerFamilies: z.array(familySchema).min(1),
  }).strict().parse(input);
  if (parsed.reviewerFamilies.includes("unknown")) throw new Error("Unknown reviewer model family cannot satisfy review policy.");
  if (new Set(parsed.reviewerFamilies).size !== parsed.reviewerFamilies.length) {
    throw new Error("Reviewer families must be unique.");
  }

  if (parsed.risk === "normal" && !parsed.reviewerFamilies.some((family) => family !== parsed.primaryFamily)) {
    throw new Error("Normal-risk review requires a reviewer family different from the primary family.");
  }

  const required = requiredReviewerFamilies(parsed);
  for (const family of required) {
    if (!parsed.reviewerFamilies.includes(family)) throw new Error(`Reviewer family ${family} is required.`);
  }
  return [...parsed.reviewerFamilies].sort((left, right) => left.localeCompare(right));
}
