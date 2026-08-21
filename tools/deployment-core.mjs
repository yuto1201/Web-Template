import { readFileSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** @typedef {{
  releaseEvidenceMaxAgeMinutes: number,
  releaseEvidenceFutureSkewMinutes: number,
  environments: Record<"development" | "preview" | "production", { requiredKeys: string[], allowedKeys: string[] }>,
  smokeChecks: Array<{ path: string, status: number, contains?: string, jsonStatus?: string }>,
  remoteSchemaOrder: Array<{ stage: "expand" | "deploy" | "contract", requiresExplicitApproval: boolean }>,
  forbiddenProductionOperations: string[]
}} DeploymentConfiguration */
/** @typedef {{ vercel: { scope: string | null, projectId: string | null } }} OwnershipConfiguration */

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(moduleDirectory, "..");
const keySchema = z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/u);
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const environmentSchema = z.enum(["development", "preview", "production"]);
const pathSchema = z.string().min(1).max(128).regex(/^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]+\/?)*$/u);
const uniqueKeyArraySchema = z.array(keySchema).max(64).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "Environment key names must be unique." });
});
const environmentPolicySchema = z.object({ requiredKeys: uniqueKeyArraySchema, allowedKeys: uniqueKeyArraySchema }).strict()
  .superRefine(({ requiredKeys, allowedKeys }, context) => {
    for (const key of requiredKeys) {
      if (!allowedKeys.includes(key)) context.addIssue({ code: "custom", message: `Required key ${key} is not allowed.` });
    }
  });
const smokeDefinitionSchema = z.object({
  path: pathSchema,
  status: z.number().int().min(100).max(599),
  contains: z.string().min(1).max(256).optional(),
  jsonStatus: z.string().min(1).max(64).optional(),
}).strict();
const deploymentConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.literal("vercel"),
  productionBranch: z.string().min(1).max(128),
  releaseEvidenceMaxAgeMinutes: z.number().int().min(1).max(1440),
  releaseEvidenceFutureSkewMinutes: z.number().int().min(0).max(30),
  environments: z.object({
    development: environmentPolicySchema,
    preview: environmentPolicySchema,
    production: environmentPolicySchema,
  }).strict(),
  keyClasses: z.record(keySchema, z.enum(["public-policy", "public-staging", "production-secret"])),
  smokeChecks: z.array(smokeDefinitionSchema).min(1).max(16),
  remoteSchemaOrder: z.array(z.object({
    stage: z.enum(["expand", "deploy", "contract"]),
    requiresExplicitApproval: z.boolean(),
  }).strict()).length(3),
  forbiddenProductionOperations: z.array(z.string().min(1).max(128)).min(1).max(32),
}).strict().superRefine((value, context) => {
  const paths = value.smokeChecks.map(({ path: smokePath }) => smokePath);
  if (new Set(paths).size !== paths.length) context.addIssue({ code: "custom", message: "Smoke check paths must be unique." });
  for (const environment of environmentSchema.options) {
    for (const key of value.environments[environment].allowedKeys) {
      if (!value.keyClasses[key]) context.addIssue({ code: "custom", message: `Missing key class for ${key}.` });
      if (environment === "preview" && value.keyClasses[key] === "production-secret") {
        context.addIssue({ code: "custom", message: `Preview cannot allow production-secret key ${key}.` });
      }
      if (environment === "preview" && /(?:SERVICE_ROLE|SECRET|PRIVATE|TOKEN|PASSWORD)/u.test(key)) {
        context.addIssue({ code: "custom", message: `Preview key name looks secret-bearing: ${key}.` });
      }
    }
  }
});
const ownershipConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  vercel: z.object({
    scope: z.string().regex(/^team_[A-Za-z0-9]+$/u).nullable(),
    projectId: z.string().regex(/^prj_[A-Za-z0-9]+$/u).nullable(),
  }).strict(),
}).passthrough();

/** @param {string} name @param {{ parse(value: unknown): unknown }} schema @returns {unknown} */
function readConfiguration(name, schema) {
  try {
    return schema.parse(JSON.parse(readFileSync(path.join(defaultRoot, "config", name), "utf8")));
  } catch (error) {
    throw new Error(`Invalid canonical configuration: ${name}.`, { cause: error });
  }
}

const deploymentConfiguration = /** @type {DeploymentConfiguration} */ (readConfiguration("deployment.json", deploymentConfigurationSchema));
const ownershipConfiguration = /** @type {OwnershipConfiguration} */ (readConfiguration("ownership.json", ownershipConfigurationSchema));

export class DeploymentCheckpointError extends Error {
  /** @param {string} checkpoint @param {string} message */
  constructor(checkpoint, message) {
    super(`[${checkpoint}] ${message}`);
    this.name = "DeploymentCheckpointError";
    this.checkpoint = checkpoint;
  }
}

const linkSchema = z.object({
  orgId: z.string().regex(/^team_[A-Za-z0-9]+$/u),
  projectId: z.string().regex(/^prj_[A-Za-z0-9]+$/u),
  projectName: z.string().min(1).max(128).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
}).strict();
const environmentSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("vercel-key-names-only"),
  environments: z.object({
    development: uniqueKeyArraySchema,
    preview: uniqueKeyArraySchema,
    production: uniqueKeyArraySchema,
  }).strict(),
}).strict();

const smokeEvidenceSchema = z.object({
  path: pathSchema,
  status: z.number().int().min(100).max(599),
  contains: z.string().optional(),
  jsonStatus: z.string().optional(),
}).strict();
const releaseEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("vercel-api"),
  environment: z.enum(["preview", "production"]),
  teamId: z.string().regex(/^team_[A-Za-z0-9]+$/u),
  projectId: z.string().regex(/^prj_[A-Za-z0-9]+$/u),
  deploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/u),
  url: z.string().max(2048).url().superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
      context.addIssue({ code: "custom", message: "Expected a credential-free HTTPS Vercel origin." });
    }
    if (!/^[a-z0-9-]+\.vercel\.app$/u.test(url.hostname)) {
      context.addIssue({ code: "custom", message: "Expected a Vercel deployment hostname." });
    }
  }),
  status: z.literal("READY"),
  commitSha: shaSchema,
  smoke: z.array(smokeEvidenceSchema).min(1).max(16),
  verifiedAt: z.iso.datetime({ offset: true }),
}).strict();

/** @param {string[]} values @param {string} checkpoint */
function uniqueSorted(values, checkpoint) {
  const parsed = values.map((value) => keySchema.parse(value));
  if (new Set(parsed).size !== parsed.length) throw new DeploymentCheckpointError(checkpoint, "Environment key names must be unique.");
  return parsed.toSorted();
}

/** @param {string} root */
export async function readLocalVercelLink(root = defaultRoot) {
  const linkDirectory = path.join(root, ".vercel");
  const linkPath = path.join(root, ".vercel", "project.json");
  let actualDirectory;
  let actual;
  try {
    actualDirectory = await realpath(linkDirectory);
    actual = await realpath(linkPath);
  } catch {
    throw new DeploymentCheckpointError("link", ".vercel/project.json is missing.");
  }
  if (actual !== path.join(actualDirectory, "project.json")) {
    throw new DeploymentCheckpointError("link", "Vercel linkage must be a regular .vercel/project.json path.");
  }
  try {
    return linkSchema.parse(JSON.parse(await readFile(actual, "utf8")));
  } catch {
    throw new DeploymentCheckpointError("link", ".vercel/project.json is malformed.");
  }
}

/** @param {unknown} snapshotValue @param {string} [root] */
export async function validateDeploymentPreflight(snapshotValue, root = defaultRoot) {
  const ownership = ownershipConfiguration;
  const link = await readLocalVercelLink(root);
  if (!ownership.vercel?.scope || !ownership.vercel?.projectId) {
    throw new DeploymentCheckpointError("ownership", "config/ownership.json has no exact Vercel scope/project.");
  }
  if (link.orgId !== ownership.vercel.scope || link.projectId !== ownership.vercel.projectId) {
    throw new DeploymentCheckpointError("link", "Local Vercel linkage does not match config/ownership.json.");
  }
  let snapshot;
  try {
    snapshot = environmentSnapshotSchema.parse(snapshotValue);
  } catch {
    throw new DeploymentCheckpointError("environment-shape", "Expected names-only environment snapshot.");
  }
  /** @type {Record<"development" | "preview" | "production", { present: number, missing: number, forbidden: number }>} */
  const environments = /** @type {any} */ ({});
  for (const environment of environmentSchema.options) {
    const checkpoint = `environment:${environment}`;
    const present = uniqueSorted(snapshot.environments[environment], checkpoint);
    const policy = deploymentConfiguration.environments[environment];
    const missing = policy.requiredKeys.filter((key) => !present.includes(key));
    const forbidden = present.filter((key) => !policy.allowedKeys.includes(key));
    if (missing.length > 0) throw new DeploymentCheckpointError(checkpoint, `Missing keys: ${missing.join(", ")}.`);
    if (forbidden.length > 0) throw new DeploymentCheckpointError(checkpoint, `Forbidden keys: ${forbidden.join(", ")}.`);
    environments[environment] = { present: present.length, missing: 0, forbidden: 0 };
  }
  return { ok: true, checkpoint: "preflight", link, environments };
}

/** @param {unknown} value @param {string} expectedCommitSha */
export function validateReleaseEvidence(value, expectedCommitSha, now = new Date()) {
  const expectedSha = shaSchema.parse(expectedCommitSha);
  const evidence = releaseEvidenceSchema.parse(value);
  if (!ownershipConfiguration.vercel.scope || !ownershipConfiguration.vercel.projectId) {
    throw new DeploymentCheckpointError("ownership", "config/ownership.json has no exact Vercel scope/project.");
  }
  if (evidence.teamId !== ownershipConfiguration.vercel.scope || evidence.projectId !== ownershipConfiguration.vercel.projectId) {
    throw new DeploymentCheckpointError("release-project", "Release evidence does not match the canonical Vercel project.");
  }
  if (evidence.commitSha !== expectedSha) throw new DeploymentCheckpointError("release-sha", "Deployment commit does not match the verified commit.");
  const verifiedAt = Date.parse(evidence.verifiedAt);
  const nowMilliseconds = now.getTime();
  const oldest = nowMilliseconds - (deploymentConfiguration.releaseEvidenceMaxAgeMinutes * 60_000);
  const newest = nowMilliseconds + (deploymentConfiguration.releaseEvidenceFutureSkewMinutes * 60_000);
  if (!Number.isFinite(nowMilliseconds) || verifiedAt < oldest || verifiedAt > newest) {
    throw new DeploymentCheckpointError("release-time", "Release evidence is stale or dated too far in the future.");
  }
  if (evidence.smoke.length !== deploymentConfiguration.smokeChecks.length) {
    throw new DeploymentCheckpointError("smoke", "Smoke evidence must exactly cover the configured checks.");
  }
  for (const expected of deploymentConfiguration.smokeChecks) {
    const matches = evidence.smoke.filter(({ path: smokePath }) => smokePath === expected.path);
    if (matches.length !== 1) throw new DeploymentCheckpointError("smoke", `Expected exactly one result for ${expected.path}.`);
    const actual = matches[0];
    if (actual.status !== expected.status) throw new DeploymentCheckpointError("smoke", `${expected.path} returned ${actual.status}.`);
    if (expected.contains && actual.contains !== expected.contains) throw new DeploymentCheckpointError("smoke", `${expected.path} content marker is missing.`);
    if (expected.jsonStatus && actual.jsonStatus !== expected.jsonStatus) throw new DeploymentCheckpointError("smoke", `${expected.path} JSON status is invalid.`);
  }
  return {
    ok: true,
    checkpoint: "release",
    teamId: evidence.teamId,
    projectId: evidence.projectId,
    deploymentId: evidence.deploymentId,
    url: evidence.url,
    commitSha: evidence.commitSha,
  };
}

export function validateRemoteSchemaOrder() {
  const stages = deploymentConfiguration.remoteSchemaOrder.map(({ stage }) => stage);
  if (stages.join(",") !== "expand,deploy,contract") throw new DeploymentCheckpointError("schema-order", "Remote schema order must be expand, deploy, contract.");
  const contract = deploymentConfiguration.remoteSchemaOrder.find(({ stage }) => stage === "contract");
  if (!contract?.requiresExplicitApproval) throw new DeploymentCheckpointError("schema-order", "Contract migrations require explicit approval.");
  if (!deploymentConfiguration.forbiddenProductionOperations.includes("database.reset")) {
    throw new DeploymentCheckpointError("schema-order", "Production database reset must be forbidden.");
  }
  return { ok: true, stages, contractRequiresExplicitApproval: true, productionReset: "forbidden" };
}

/** @param {string} root */
export async function lintDeploymentWorkflows(root = defaultRoot) {
  const workflowRoot = path.join(root, ".github", "workflows");
  const errors = [];
  for (const name of await readdir(workflowRoot)) {
    if (!/\.ya?ml$/u.test(name)) continue;
    const content = await readFile(path.join(workflowRoot, name), "utf8");
    if (/^\s*pull_request_target\s*:/mu.test(content)) errors.push(`${name}: pull_request_target is forbidden.`);
    if (/--token(?:=|\s+)\$\{\{/u.test(content)) errors.push(`${name}: Vercel tokens must not appear in command arguments.`);
    if (/\b(?:echo|printenv|env)\b[^\n]*(?:SECRET|TOKEN|KEY)/iu.test(content)) errors.push(`${name}: secret-like environment output is forbidden.`);
  }
  return errors;
}

export const deploymentSchemas = { environmentSnapshotSchema, releaseEvidenceSchema };
export const canonicalVercelOwnership = Object.freeze({ ...ownershipConfiguration.vercel });
