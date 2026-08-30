import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceSchema = z.enum(["github", "supabase", "vercel", "cloudflare", "linear"]);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, "Expected a lowercase SHA-256 fingerprint.");
const idSchema = z.string().min(1).max(256);
const timestampSchema = z.string().datetime({ offset: true });
const hostnameSchema = z.string().min(1).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u);

const authorizationSchema = z.object({
  operatorLabels: z.array(z.enum(["codex", "claude"])) .min(2).max(2),
  externalOperatorRoles: z.array(z.enum(["implementer", "external-operator"])) .min(2).max(2),
  allowAutomaticAccountSwitch: z.literal(false, "Automatic account switching is forbidden."),
}).strict().superRefine((value, context) => {
  if (new Set(value.operatorLabels).size !== value.operatorLabels.length) {
    context.addIssue({ code: "custom", message: "Operator labels must be unique." });
  }
  if (new Set(value.externalOperatorRoles).size !== value.externalOperatorRoles.length) {
    context.addIssue({ code: "custom", message: "External operator roles must be unique." });
  }
});

const githubAccountSchema = z.object({
  login: idSchema,
  userId: z.number().int().positive(),
  nodeId: idSchema,
}).strict();
const supabaseAccountSchema = z.object({
  organizationName: idSchema,
  organizationId: z.string().regex(/^[a-z0-9]{20}$/u),
}).strict();
const vercelAccountSchema = z.object({
  teamName: idSchema,
  teamSlug: z.string().regex(/^[a-z0-9-]+$/u),
  teamId: z.string().regex(/^team_[A-Za-z0-9]+$/u),
  requiredPlan: z.enum(["Hobby", "Pro", "Enterprise"]),
}).strict();
const cloudflareAccountSchema = z.object({
  accountName: idSchema,
  accountId: z.string().regex(/^[0-9a-f]{32}$/u),
  loginEmailHint: z.string().min(1).max(128),
  loginEmailSha256: sha256Schema,
  requiredRole: idSchema,
  allowedZonePlans: z.array(z.enum(["Free", "Pro", "Business", "Enterprise"])).min(1).max(4),
}).strict().superRefine((value, context) => {
  if (new Set(value.allowedZonePlans).size !== value.allowedZonePlans.length) {
    context.addIssue({ code: "custom", message: "Allowed Cloudflare zone plans must be unique." });
  }
});
const linearAccountSchema = z.object({
  workspaceName: idSchema,
  workspaceSlug: z.string().regex(/^[a-z0-9-]+$/u),
  workspaceUrl: z.url(),
  workspaceId: idSchema.nullable(),
  userName: idSchema,
  userEmailHint: z.string().min(1).max(128),
  userEmailSha256: sha256Schema,
  userId: idSchema.nullable(),
  requiredRole: idSchema,
}).strict();

const githubTargetSchema = z.object({
  owner: idSchema,
  repository: idSchema,
  repositoryId: z.number().int().positive(),
  repositoryNodeId: idSchema,
}).strict();
const supabaseTargetSchema = z.object({ projectRef: z.string().regex(/^[a-z0-9]{20}$/u).nullable() }).strict();
const vercelTargetSchema = z.object({ projectId: z.string().regex(/^prj_[A-Za-z0-9]+$/u) }).strict();
const cloudflareTargetSchema = z.object({
  zoneId: z.string().regex(/^[0-9a-f]{32}$/u),
  domains: z.array(hostnameSchema).min(1).max(32),
}).strict().superRefine((value, context) => {
  if (new Set(value.domains).size !== value.domains.length) {
    context.addIssue({ code: "custom", message: "Cloudflare domains must be unique." });
  }
});
const linearTargetSchema = z.object({ teamKey: z.string().regex(/^[A-Z][A-Z0-9]{1,15}$/u), teamId: idSchema.nullable() }).strict();

const authoritySchema = z.object({
  schemaVersion: z.literal(2),
  authorization: authorizationSchema,
  accounts: z.object({
    github: githubAccountSchema,
    supabase: supabaseAccountSchema,
    vercel: vercelAccountSchema,
    cloudflare: cloudflareAccountSchema,
    linear: linearAccountSchema,
  }).strict(),
  servicePolicies: z.object({
    github: z.object({ mode: z.literal("repository-active") }).strict(),
    supabase: z.object({ mode: z.literal("repository-active") }).strict(),
    vercel: z.object({ mode: z.literal("repository-active") }).strict(),
    cloudflare: z.object({ mode: z.literal("repository-active") }).strict(),
    linear: z.object({ mode: z.literal("explicit-user-purpose-only") }).strict(),
  }).strict(),
  resourceTargets: z.object({
    github: githubTargetSchema,
    supabase: supabaseTargetSchema,
    vercel: vercelTargetSchema,
    cloudflare: cloudflareTargetSchema,
    linear: linearTargetSchema,
  }).strict(),
  observations: z.object({
    github: z.object({
      displayName: z.string().min(1).max(256),
      createdAt: timestampSchema,
      publicRepositories: z.number().int().nonnegative(),
      observedAt: timestampSchema,
    }).strict(),
  }).strict(),
}).strict();

const githubObservationAccountSchema = githubAccountSchema.extend({
  displayName: z.string().min(1).max(256).optional(),
  createdAt: timestampSchema.optional(),
  publicRepositories: z.number().int().nonnegative().optional(),
  observedAt: timestampSchema.optional(),
}).strict();
const githubObservationTargetSchema = z.object({
  repositoryId: z.number().int().positive(),
  repositoryNodeId: idSchema,
  owner: idSchema.optional(),
  repository: idSchema.optional(),
}).strict();
const supabaseObservationAccountSchema = supabaseAccountSchema;
const supabaseObservationTargetSchema = supabaseTargetSchema;
const vercelObservationAccountSchema = vercelAccountSchema.extend({ plan: z.enum(["Hobby", "Pro", "Enterprise"]) }).strict();
const vercelObservationTargetSchema = vercelTargetSchema;
const cloudflareObservationAccountSchema = z.object({
  accountName: idSchema,
  accountId: z.string().regex(/^[0-9a-f]{32}$/u),
  loginEmailSha256: sha256Schema.optional(),
  loginEmail: z.string().email().optional(),
  role: idSchema,
}).strict().superRefine((value, context) => {
  if (!value.loginEmailSha256 && !value.loginEmail) {
    context.addIssue({ code: "custom", message: "Cloudflare account identity requires an email fingerprint or email." });
  }
  if (value.loginEmailSha256 && value.loginEmail && emailFingerprint(value.loginEmail) !== value.loginEmailSha256) {
    context.addIssue({ code: "custom", message: "Cloudflare email fingerprint does not match the raw email." });
  }
});
const cloudflareObservationTargetSchema = cloudflareTargetSchema.extend({ zonePlan: z.enum(["Free", "Pro", "Business", "Enterprise"]) }).strict();
const linearObservationAccountSchema = z.object({
  workspaceName: idSchema,
  workspaceSlug: z.string().regex(/^[a-z0-9-]+$/u),
  workspaceUrl: z.url(),
  workspaceId: idSchema.nullable(),
  userName: idSchema,
  userEmailSha256: sha256Schema.optional(),
  userEmail: z.string().email().optional(),
  userId: idSchema.nullable(),
  role: idSchema,
}).strict().superRefine((value, context) => {
  if (!value.userEmailSha256 && !value.userEmail) {
    context.addIssue({ code: "custom", message: "Linear account identity requires an email fingerprint or email." });
  }
  if (value.userEmailSha256 && value.userEmail && emailFingerprint(value.userEmail) !== value.userEmailSha256) {
    context.addIssue({ code: "custom", message: "Linear email fingerprint does not match the raw email." });
  }
});
const linearObservationTargetSchema = linearTargetSchema;

const observationSchema = z.object({
  service: serviceSchema,
  account: z.unknown(),
  target: z.unknown(),
  previousAccount: z.unknown().optional(),
  previousTarget: z.unknown().optional(),
}).strict();
const serviceUseSchema = z.object({
  service: serviceSchema,
  operation: z.string().min(1).max(256),
  purposeCode: z.string().min(1).max(128),
  explicitUserPurpose: z.string().nullable(),
}).strict();

/** @param {unknown} value @returns {unknown} */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

/** @param {unknown} value */
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/** @param {string} value */
function emailFingerprint(value) {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
}

/** @param {string | undefined} fingerprint @param {string | undefined} email */
function observedFingerprint(fingerprint, email) {
  return fingerprint ?? emailFingerprint(/** @type {string} */ (email));
}

/** @param {unknown} value */
export function parseAuthority(value) {
  return authoritySchema.parse(value);
}

/** @param {unknown} value */
export function authorityDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(parseAuthority(value)), "utf8").digest("hex")}`;
}

/** @param {ReturnType<typeof parseAuthority>} authority @param {"github" | "supabase" | "vercel" | "cloudflare" | "linear"} service */
function references(authority, service) {
  if (service === "github") {
    const account = authority.accounts.github;
    const target = authority.resourceTargets.github;
    return { accountRef: `github:${account.userId}:${account.nodeId}`, targetRef: `github:${target.repositoryId}:${target.repositoryNodeId}` };
  }
  if (service === "supabase") {
    const account = authority.accounts.supabase;
    const target = authority.resourceTargets.supabase;
    return { accountRef: `supabase:${account.organizationId}`, targetRef: target.projectRef ? `supabase:${target.projectRef}` : null };
  }
  if (service === "vercel") {
    const account = authority.accounts.vercel;
    const target = authority.resourceTargets.vercel;
    return { accountRef: `vercel:${account.teamId}`, targetRef: `vercel:${target.projectId}` };
  }
  if (service === "cloudflare") {
    const account = authority.accounts.cloudflare;
    const target = authority.resourceTargets.cloudflare;
    return { accountRef: `cloudflare:${account.accountId}`, targetRef: `cloudflare:${target.zoneId}` };
  }
  const account = authority.accounts.linear;
  const target = authority.resourceTargets.linear;
  return {
    accountRef: account.workspaceId && account.userId ? `linear:${account.workspaceId}:${account.userId}` : "linear:incomplete",
    targetRef: target.teamId ? `linear:${target.teamId}` : null,
  };
}

/** @param {unknown} actual @param {unknown} expected @param {string} message */
function requireEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message);
}

/** @param {ReturnType<typeof parseAuthority>} authority @param {"github" | "supabase" | "vercel" | "cloudflare" | "linear"} service @param {unknown} accountValue @param {unknown} targetValue */
function evaluateIdentity(authority, service, accountValue, targetValue) {
  /** @type {string[]} */
  const warnings = [];

  if (service === "github") {
    const configuredAccount = authority.accounts.github;
    const configuredTarget = authority.resourceTargets.github;
    const account = githubObservationAccountSchema.parse(accountValue);
    const target = githubObservationTargetSchema.parse(targetValue);
    requireEqual(account.login, configuredAccount.login, "GitHub account identity mismatch.");
    requireEqual(account.userId, configuredAccount.userId, "GitHub account identity mismatch.");
    requireEqual(account.nodeId, configuredAccount.nodeId, "GitHub account identity mismatch.");
    requireEqual(target.repositoryId, configuredTarget.repositoryId, "GitHub target identity mismatch.");
    requireEqual(target.repositoryNodeId, configuredTarget.repositoryNodeId, "GitHub target identity mismatch.");
    if (target.owner !== undefined) requireEqual(target.owner, configuredTarget.owner, "GitHub target identity mismatch.");
    if (target.repository !== undefined) requireEqual(target.repository, configuredTarget.repository, "GitHub target identity mismatch.");
    /** @type {Array<["displayName" | "createdAt" | "publicRepositories", string]>} */
    const observationFields = [["displayName", "display name"], ["createdAt", "creation date"], ["publicRepositories", "public repository count"]];
    for (const [key, label] of observationFields) {
      if (account[key] !== undefined && account[key] !== authority.observations.github[key]) {
        warnings.push(`GitHub ${label} differs from the configured observation.`);
      }
    }
    return { ...references(authority, service), warnings };
  }

  if (service === "supabase") {
    const configuredAccount = authority.accounts.supabase;
    const configuredTarget = authority.resourceTargets.supabase;
    const account = supabaseObservationAccountSchema.parse(accountValue);
    const target = supabaseObservationTargetSchema.parse(targetValue);
    requireEqual(account.organizationName, configuredAccount.organizationName, "Supabase account identity mismatch.");
    requireEqual(account.organizationId, configuredAccount.organizationId, "Supabase account identity mismatch.");
    requireEqual(target.projectRef, configuredTarget.projectRef, "Supabase target identity mismatch.");
    return { ...references(authority, service), warnings };
  }

  if (service === "vercel") {
    const configuredAccount = authority.accounts.vercel;
    const configuredTarget = authority.resourceTargets.vercel;
    const account = vercelObservationAccountSchema.parse(accountValue);
    const target = vercelObservationTargetSchema.parse(targetValue);
    requireEqual(account.teamName, configuredAccount.teamName, "Vercel account identity mismatch.");
    requireEqual(account.teamSlug, configuredAccount.teamSlug, "Vercel account identity mismatch.");
    requireEqual(account.teamId, configuredAccount.teamId, "Vercel account identity mismatch.");
    requireEqual(account.plan, configuredAccount.requiredPlan, "Vercel plan mismatch.");
    requireEqual(target.projectId, configuredTarget.projectId, "Vercel target identity mismatch.");
    return { ...references(authority, service), warnings };
  }

  if (service === "cloudflare") {
    const configuredAccount = authority.accounts.cloudflare;
    const configuredTarget = authority.resourceTargets.cloudflare;
    const account = cloudflareObservationAccountSchema.parse(accountValue);
    const target = cloudflareObservationTargetSchema.parse(targetValue);
    requireEqual(account.accountName, configuredAccount.accountName, "Cloudflare account identity mismatch.");
    requireEqual(account.accountId, configuredAccount.accountId, "Cloudflare account identity mismatch.");
    requireEqual(observedFingerprint(account.loginEmailSha256, account.loginEmail), configuredAccount.loginEmailSha256, "Cloudflare account identity mismatch.");
    requireEqual(account.role, configuredAccount.requiredRole, "Cloudflare role mismatch.");
    requireEqual(target.zoneId, configuredTarget.zoneId, "Cloudflare target identity mismatch.");
    if (canonicalJson(target.domains) !== canonicalJson(configuredTarget.domains)) throw new Error("Cloudflare target identity mismatch.");
    if (!configuredAccount.allowedZonePlans.includes(target.zonePlan)) throw new Error("Cloudflare zone plan mismatch.");
    return { ...references(authority, service), warnings };
  }

  const configuredAccount = authority.accounts.linear;
  const configuredTarget = authority.resourceTargets.linear;
  const account = linearObservationAccountSchema.parse(accountValue);
  const target = linearObservationTargetSchema.parse(targetValue);
  requireEqual(account.workspaceName, configuredAccount.workspaceName, "Linear account identity mismatch.");
  requireEqual(account.workspaceSlug, configuredAccount.workspaceSlug, "Linear account identity mismatch.");
  requireEqual(account.workspaceUrl, configuredAccount.workspaceUrl, "Linear account identity mismatch.");
  requireEqual(account.workspaceId, configuredAccount.workspaceId, "Linear account identity mismatch.");
  requireEqual(account.userName, configuredAccount.userName, "Linear account identity mismatch.");
  requireEqual(observedFingerprint(account.userEmailSha256, account.userEmail), configuredAccount.userEmailSha256, "Linear account identity mismatch.");
  requireEqual(account.userId, configuredAccount.userId, "Linear account identity mismatch.");
  requireEqual(account.role, configuredAccount.requiredRole, "Linear role mismatch.");
  requireEqual(target.teamKey, configuredTarget.teamKey, "Linear target identity mismatch.");
  requireEqual(target.teamId, configuredTarget.teamId, "Linear target identity mismatch.");
  return { ...references(authority, service), warnings };
}

/** @param {"github" | "supabase" | "vercel" | "cloudflare" | "linear"} service @param {unknown} accountValue @param {unknown} targetValue */
function observedIdentity(service, accountValue, targetValue) {
  if (service === "github") {
    const account = githubObservationAccountSchema.parse(accountValue);
    const target = githubObservationTargetSchema.parse(targetValue);
    return {
      account: { login: account.login, userId: account.userId, nodeId: account.nodeId },
      target: { repositoryId: target.repositoryId, repositoryNodeId: target.repositoryNodeId },
    };
  }
  if (service === "supabase") {
    return { account: supabaseObservationAccountSchema.parse(accountValue), target: supabaseObservationTargetSchema.parse(targetValue) };
  }
  if (service === "vercel") {
    const account = vercelObservationAccountSchema.parse(accountValue);
    return {
      account: { teamName: account.teamName, teamSlug: account.teamSlug, teamId: account.teamId, plan: account.plan },
      target: vercelObservationTargetSchema.parse(targetValue),
    };
  }
  if (service === "cloudflare") {
    const account = cloudflareObservationAccountSchema.parse(accountValue);
    const target = cloudflareObservationTargetSchema.parse(targetValue);
    return {
      account: { accountName: account.accountName, accountId: account.accountId, loginEmailSha256: observedFingerprint(account.loginEmailSha256, account.loginEmail), role: account.role },
      target: { zoneId: target.zoneId, domains: target.domains, zonePlan: target.zonePlan },
    };
  }
  const account = linearObservationAccountSchema.parse(accountValue);
  return {
    account: {
      workspaceName: account.workspaceName,
      workspaceSlug: account.workspaceSlug,
      workspaceUrl: account.workspaceUrl,
      workspaceId: account.workspaceId,
      userName: account.userName,
      userEmailSha256: observedFingerprint(account.userEmailSha256, account.userEmail),
      userId: account.userId,
      role: account.role,
    },
    target: linearObservationTargetSchema.parse(targetValue),
  };
}

/**
 * Normalizes a transient provider observation for receipt persistence. Raw email may be
 * accepted from the in-process provider client, but only its normalized fingerprint leaves
 * this function.
 * @param {unknown} authorityValue @param {unknown} observationValue
 */
export function normalizeProviderObservation(authorityValue, observationValue) {
  const authority = parseAuthority(authorityValue);
  const observation = observationSchema.omit({ previousAccount: true, previousTarget: true }).parse(observationValue);
  evaluateIdentity(authority, observation.service, observation.account, observation.target);
  const normalized = observedIdentity(observation.service, observation.account, observation.target);
  if (observation.service === "github") {
    const account = githubObservationAccountSchema.parse(observation.account);
    return {
      account: {
        ...normalized.account,
        ...(account.displayName === undefined ? {} : { displayName: account.displayName }),
        ...(account.createdAt === undefined ? {} : { createdAt: account.createdAt }),
        ...(account.publicRepositories === undefined ? {} : { publicRepositories: account.publicRepositories }),
        ...(account.observedAt === undefined ? {} : { observedAt: account.observedAt }),
      },
      target: normalized.target,
    };
  }
  return normalized;
}

/** @param {unknown} authorityValue @param {unknown} observationValue */
export function evaluateAccountObservation(authorityValue, observationValue) {
  const authority = parseAuthority(authorityValue);
  const observation = observationSchema.parse(observationValue);
  const current = evaluateIdentity(authority, observation.service, observation.account, observation.target);
  if (observation.previousAccount !== undefined || observation.previousTarget !== undefined) {
    if (observation.previousAccount === undefined || observation.previousTarget === undefined) {
      throw new Error("Pre/post account and target observations must be supplied together.");
    }
    const currentIdentity = observedIdentity(observation.service, observation.account, observation.target);
    const previousIdentity = observedIdentity(observation.service, observation.previousAccount, observation.previousTarget);
    if (canonicalJson(currentIdentity.account) !== canonicalJson(previousIdentity.account)) throw new Error("account switch is not allowed.");
    if (canonicalJson(currentIdentity.target) !== canonicalJson(previousIdentity.target)) throw new Error("target switch is not allowed.");
    const previous = evaluateIdentity(authority, observation.service, observation.previousAccount, observation.previousTarget);
    current.warnings = [...new Set([...current.warnings, ...previous.warnings])].toSorted();
  }
  return { ok: true, accountRef: current.accountRef, targetRef: current.targetRef, warnings: current.warnings };
}

/** @param {unknown} authorityValue @param {unknown} inputValue */
export function authorizeServiceUse(authorityValue, inputValue) {
  const authority = parseAuthority(authorityValue);
  const input = serviceUseSchema.parse(inputValue);
  const mode = authority.servicePolicies[input.service].mode;
  if (mode === "repository-active" && input.purposeCode === "user-directed") {
    throw new Error("user-directed purpose is reserved for explicit-user-purpose-only services.");
  }
  if (mode === "explicit-user-purpose-only") {
    if (input.purposeCode !== "user-directed") {
      throw new Error("Linear use requires purposeCode user-directed.");
    }
    if (!input.explicitUserPurpose || input.explicitUserPurpose.trim().length === 0 || /[\r\n]/u.test(input.explicitUserPurpose)) {
      throw new Error("Linear use requires an explicit user purpose on one line.");
    }
    const account = authority.accounts.linear;
    const target = authority.resourceTargets.linear;
    if (!account.workspaceId || !account.userId || !target.teamId) {
      throw new Error("Linear use requires recorded stable IDs and a stable target ID.");
    }
    throw new Error("Unsupported Linear operation: no Linear operation is registered; a later Issue must define a strict user-directed operation.");
  }
  return { ...references(authority, input.service), mode };
}

/** @param {string} [root] */
export function readAuthority(root = defaultRoot) {
  return parseAuthority(JSON.parse(readFileSync(path.join(root, "config", "ownership.json"), "utf8")));
}
