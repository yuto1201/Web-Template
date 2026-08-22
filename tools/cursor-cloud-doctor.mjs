import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  containsPotentialSecret,
  validateCursorEnvironmentPolicy,
  validateRepository,
} from "./repository-policy.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(modulePath), "..");
const expectedNodeVersion = "24.13.0";
const expectedNpmVersion = "11.6.2";
const activationMaximumAgeMilliseconds = 24 * 60 * 60 * 1_000;
const activationMaximumFutureMilliseconds = 5 * 60 * 1_000;

/**
 * @typedef CursorRepositorySnapshot
 * @property {unknown} [policyErrors]
 * @property {unknown} [nodeVersion]
 * @property {unknown} [nvmVersion]
 * @property {unknown} [packageNodeVersion]
 * @property {unknown} [packageNpmVersion]
 * @property {unknown} [packageManager]
 * @property {unknown} [branch]
 * @property {unknown} [headSha]
 * @property {unknown} [environment]
 * @property {unknown} [dockerfile]
 */
/**
 * @typedef CursorRuntimeSnapshot
 * @property {unknown} [node]
 * @property {unknown} [npm]
 * @property {unknown} [docker]
 * @property {unknown} [chromium]
 */
/**
 * @typedef CursorOwnership
 * @property {{ owner?: string | null, repository?: string | null }} [github]
 * @property {{ organizationName?: string | null, projectRef?: string | null }} [supabase]
 * @property {{ scope?: string | null, projectId?: string | null }} [vercel]
 * @property {{ accountId?: string | null, accountName?: string | null, zoneId?: string | null, domains?: string[] }} [cloudflare]
 */
/**
 * @typedef CursorCloudSnapshot
 * @property {CursorRepositorySnapshot} [repository]
 * @property {CursorRuntimeSnapshot} [runtime]
 * @property {CursorOwnership} [ownership]
 * @property {unknown} [executionPolicy]
 */

class SafeCliError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SafeCliError";
  }
}

class ActivationEvidenceError extends SafeCliError {
  /** @param {string} message @param {"blocked:environment" | "blocked:conflict" | "blocked:review" | "blocked:ops"} status */
  constructor(message, status) {
    super(message);
    this.name = "ActivationEvidenceError";
    this.status = status;
  }
}

const runSchema = z.strictObject({
  id: z.string().regex(/^bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
  modelObserved: z.string().regex(/^composer-2(?:\.[0-9]+)?$/u),
});
const repositorySchema = z.strictObject({
  fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  branch: z.string().regex(/^cursor\/[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  headSha: z.string().regex(/^[0-9a-f]{40}$/u),
});
const buildSchema = z.strictObject({
  status: z.literal("ready"),
  node: z.literal(expectedNodeVersion),
  npm: z.literal(expectedNpmVersion),
  docker: z.literal(true),
  chromium: z.literal(true),
});
/** @param {RegExp} modelPattern */
const reviewerProbeSchema = (modelPattern) => z.strictObject({
  observed: z.string().regex(modelPattern),
  repositoryReadProbe: z.literal("passed"),
  fileProbe: z.literal("denied"),
  shellProbe: z.literal("denied"),
  providerToolProbe: z.literal("denied"),
  completionProbe: z.literal("passed"),
});

/** @param {string} value */
function isRfc3339Timestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, offsetHourText, offsetMinuteText] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z" && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false;
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
}

const activationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  surface: z.literal("cursor-cloud"),
  run: runSchema,
  repository: repositorySchema,
  build: buildSchema,
  reviewers: z.strictObject({
    openai: reviewerProbeSchema(/^gpt-5\.6-(?:sol|terra|luna)$/u),
    anthropic: reviewerProbeSchema(/^claude-(?:opus|sonnet|fable)-5$/u),
  }),
  providers: z.strictObject({
    github: z.strictObject({
      owner: z.string().trim().min(1).max(120),
      fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
      status: z.literal("verified"),
    }),
    supabase: z.strictObject({
      organizationName: z.string().trim().min(1).max(160),
      projectRef: z.string().trim().min(1).max(160),
      status: z.literal("verified"),
    }),
    vercel: z.strictObject({
      scope: z.string().trim().min(1).max(160),
      projectId: z.string().trim().min(1).max(160),
      status: z.literal("verified"),
    }),
    cloudflare: z.strictObject({
      accountId: z.string().trim().min(1).max(160),
      accountName: z.string().trim().min(1).max(160),
      zoneId: z.string().trim().min(1).max(160),
      domain: z.string().trim().min(1).max(253),
      status: z.literal("verified"),
    }),
  }),
  verifiedAt: z.string().refine(isRfc3339Timestamp),
});

/** @param {unknown} value @returns {boolean} */
function hasSecretShape(value) {
  if (Array.isArray(value)) return value.some(hasSecretShape);
  if (!value || typeof value !== "object") {
    return typeof value === "string" && containsPotentialSecret(value);
  }
  return Object.entries(value).some(([key, child]) => (
    /(?:token|secret|password|credential|api[_-]?key|private[_-]?key|cookie|auth)/iu.test(key) ||
    hasSecretShape(child)
  ));
}

/** @param {unknown} executionPolicy */
function trustedReviewerModels(executionPolicy) {
  if (!executionPolicy || typeof executionPolicy !== "object" || !("cursorModels" in executionPolicy)) {
    throw new ActivationEvidenceError("Trusted reviewer model selectors are unavailable.", "blocked:review");
  }
  const cursorModels = executionPolicy.cursorModels;
  if (!cursorModels || typeof cursorModels !== "object") {
    throw new ActivationEvidenceError("Trusted reviewer model selectors are unavailable.", "blocked:review");
  }
  const openaiSelector = "openai" in cursorModels ? cursorModels.openai : undefined;
  const anthropicSelector = "anthropic" in cursorModels ? cursorModels.anthropic : undefined;
  const openai = typeof openaiSelector === "string"
    ? /^(gpt-5\.6-(?:sol|terra|luna))\[[^\[\]]+\]$/u.exec(openaiSelector)?.[1]
    : undefined;
  const anthropic = typeof anthropicSelector === "string"
    ? /^(claude-(?:opus|sonnet|fable)-5)\[[^\[\]]+\]$/u.exec(anthropicSelector)?.[1]
    : undefined;
  if (!openai || !anthropic) {
    throw new ActivationEvidenceError("Trusted reviewer model selectors are unavailable.", "blocked:review");
  }
  return { openai, anthropic };
}

/**
 * @param {unknown} value
 * @param {unknown} executionPolicy
 * @param {{ referenceTime?: Date | string | number }} [options]
 */
export function validateActivationEvidence(value, executionPolicy, options = {}) {
  if (hasSecretShape(value)) {
    throw new ActivationEvidenceError("Cursor activation evidence contains secret-shaped input.", "blocked:ops");
  }
  if (
    value && typeof value === "object" &&
    "providers" in value && value.providers && typeof value.providers === "object" &&
    "github" in value.providers && value.providers.github && typeof value.providers.github === "object" &&
    !("owner" in value.providers.github)
  ) {
    throw new ActivationEvidenceError("Cursor activation evidence requires a GitHub owner identity.", "blocked:ops");
  }
  const result = activationSchema.safeParse(value);
  if (!result.success) {
    const firstPath = result.error.issues[0]?.path ?? [];
    const section = firstPath[0];
    const status = section === "reviewers" || section === "run"
      ? "blocked:review"
      : section === "repository"
        ? "blocked:conflict"
        : section === "providers"
          ? "blocked:ops"
          : "blocked:environment";
    throw new ActivationEvidenceError(
      "Cursor activation evidence schema is invalid or contains an unexpected property.",
      status,
    );
  }
  const expectedModels = trustedReviewerModels(executionPolicy);
  if (
    result.data.reviewers.openai.observed !== expectedModels.openai ||
    result.data.reviewers.anthropic.observed !== expectedModels.anthropic
  ) {
    throw new ActivationEvidenceError(
      "Cursor activation evidence does not match the configured reviewer models.",
      "blocked:review",
    );
  }
  const referenceTime = options.referenceTime === undefined ? Date.now() : new Date(options.referenceTime).getTime();
  const verifiedAt = Date.parse(result.data.verifiedAt);
  if (
    !Number.isFinite(referenceTime) ||
    verifiedAt < referenceTime - activationMaximumAgeMilliseconds ||
    verifiedAt > referenceTime + activationMaximumFutureMilliseconds
  ) {
    throw new ActivationEvidenceError(
      "Cursor activation evidence must be fresh relative to the reference time.",
      "blocked:conflict",
    );
  }
  return result.data;
}

/**
 * Shared pure binding contract used by both cursor:doctor and external-operation preflight.
 * @param {ReturnType<typeof validateActivationEvidence>} activation
 * @param {{ branch?: unknown, headSha?: unknown }} repository
 * @param {CursorOwnership} ownership
 * @returns {Array<[string, string, boolean]>}
 */
export function activationRepositoryBindingChecks(activation, repository, ownership) {
  const currentBranch = repository.branch;
  const currentBranchAvailable = typeof currentBranch === "string" && currentBranch.length > 0;
  const currentBranchIsCursor = currentBranchAvailable && /^cursor\/[1-9][0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(currentBranch);
  const currentHead = repository.headSha;
  const currentHeadAvailable = typeof currentHead === "string" && /^[0-9a-f]{40}$/u.test(currentHead);
  const expectedGitHub = `${ownership.github?.owner ?? ""}/${ownership.github?.repository ?? ""}`;
  const expectedSupabaseProject = ownership.supabase?.projectRef;
  const expectedVercelScope = ownership.vercel?.scope;
  const expectedVercelProject = ownership.vercel?.projectId;
  const expectedCloudflareAccountId = ownership.cloudflare?.accountId;
  const expectedCloudflareAccountName = ownership.cloudflare?.accountName;
  const expectedCloudflareZoneId = ownership.cloudflare?.zoneId;
  const expectedCloudflareDomains = ownership.cloudflare?.domains;
  return [
    ["current-branch", currentBranchAvailable ? "current-branch-not-cursor" : "current-branch-unavailable", currentBranchIsCursor],
    ["activation-branch", "activation-branch-mismatch", currentBranchIsCursor && activation.repository.branch === currentBranch],
    ["current-head", "current-head-unavailable", currentHeadAvailable],
    ["activation-head", "activation-head-mismatch", currentHeadAvailable && activation.repository.headSha === currentHead],
    ["github-owner", "github-owner-mismatch", activation.providers.github.owner === ownership.github?.owner],
    ["github-target", "github-target-mismatch", activation.providers.github.fullName === expectedGitHub && activation.repository.fullName === expectedGitHub],
    ["supabase-owner", "supabase-owner-mismatch", activation.providers.supabase.organizationName === ownership.supabase?.organizationName],
    ["supabase-project-configured", "supabase-project-unconfigured", typeof expectedSupabaseProject === "string" && expectedSupabaseProject.length > 0],
    ["supabase-project", "supabase-project-mismatch", activation.providers.supabase.projectRef === expectedSupabaseProject],
    ["vercel-scope-configured", "vercel-scope-unconfigured", typeof expectedVercelScope === "string" && expectedVercelScope.length > 0],
    ["vercel-scope", "vercel-scope-mismatch", activation.providers.vercel.scope === expectedVercelScope],
    ["vercel-project-configured", "vercel-project-unconfigured", typeof expectedVercelProject === "string" && expectedVercelProject.length > 0],
    ["vercel-project", "vercel-project-mismatch", activation.providers.vercel.projectId === expectedVercelProject],
    ["cloudflare-account-id-configured", "cloudflare-account-id-unconfigured", typeof expectedCloudflareAccountId === "string" && expectedCloudflareAccountId.length > 0],
    ["cloudflare-account-id", "cloudflare-account-id-mismatch", activation.providers.cloudflare.accountId === expectedCloudflareAccountId],
    ["cloudflare-owner", "cloudflare-owner-mismatch", activation.providers.cloudflare.accountName === expectedCloudflareAccountName],
    ["cloudflare-zone-configured", "cloudflare-zone-unconfigured", typeof expectedCloudflareZoneId === "string" && expectedCloudflareZoneId.length > 0],
    ["cloudflare-zone", "cloudflare-zone-mismatch", activation.providers.cloudflare.zoneId === expectedCloudflareZoneId],
    ["cloudflare-domain-configured", "cloudflare-domain-unconfigured", Array.isArray(expectedCloudflareDomains) && expectedCloudflareDomains.length > 0],
    ["cloudflare-domain", "cloudflare-domain-mismatch", Array.isArray(expectedCloudflareDomains) && expectedCloudflareDomains.includes(activation.providers.cloudflare.domain)],
  ];
}

/** @param {string} command @param {string[]} args @param {string} [cwd] */
function commandOutput(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) return null;
  const output = `${result.stdout ?? ""}`.trim();
  return output || null;
}

/** @param {string} target */
async function isFile(target) {
  try {
    return (await lstat(target)).isFile();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * @param {string} root
 * @param {string} input
 * @param {unknown} executionPolicy
 * @param {{ referenceTime?: Date | string | number }} [options]
 */
export async function readActivationEvidence(root, input, executionPolicy, options = {}) {
  if (path.isAbsolute(input)) {
    throw new SafeCliError("Activation input must stay in the redacted artifact directory.");
  }
  const normalized = input.replaceAll("\\", "/");
  if (!/^\.artifacts\/cursor\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(normalized)) {
    throw new SafeCliError("Activation input must stay in the redacted artifact directory.");
  }
  const rootPath = await realpath(root);
  const target = path.resolve(rootPath, normalized);
  const prefix = `${path.join(rootPath, ".artifacts", "cursor")}${path.sep}`;
  if (!target.startsWith(prefix) || !(await isFile(target))) {
    throw new SafeCliError("Activation input must be a regular file.");
  }
  const resolvedTarget = await realpath(target);
  if (!resolvedTarget.startsWith(prefix)) {
    throw new SafeCliError("Activation input must be a regular file.");
  }
  const text = await readFile(resolvedTarget, "utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SafeCliError("Cursor activation evidence must be valid JSON.");
  }
  return validateActivationEvidence(value, executionPolicy, options);
}

async function chromiumAvailable() {
  try {
    const playwright = await import("@playwright/test");
    const executable = playwright.chromium.executablePath();
    return typeof executable === "string" && executable.length > 0 && await isFile(executable);
  } catch {
    return false;
  }
}

/** @param {string} root */
export async function collectCursorCloudSnapshot(root = defaultRoot) {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const packageManagerMatch = /^npm@(\d+\.\d+\.\d+)$/u.exec(packageJson.packageManager ?? "");
  const npmExecPath = process.env.npm_execpath;
  const npmVersion = npmExecPath
    ? commandOutput(process.execPath, [npmExecPath, "--version"])
    : process.platform === "win32"
      ? commandOutput("cmd.exe", ["/d", "/s", "/c", "npm --version"])
      : commandOutput("npm", ["--version"]);
  const [policyErrors, nodeVersion, nvmVersion, environmentText, dockerfile, ownershipText, executionPolicyText] = await Promise.all([
    validateRepository(root),
    readFile(path.join(root, ".node-version"), "utf8"),
    readFile(path.join(root, ".nvmrc"), "utf8"),
    readFile(path.join(root, ".cursor", "environment.json"), "utf8"),
    readFile(path.join(root, ".cursor", "Dockerfile"), "utf8"),
    readFile(path.join(root, "config", "ownership.json"), "utf8"),
    readFile(path.join(root, "config", "execution.json"), "utf8"),
  ]);
  return {
    repository: {
      policyErrors,
      nodeVersion: nodeVersion.trim(),
      nvmVersion: nvmVersion.trim(),
      packageNodeVersion: packageJson.engines?.node ?? null,
      packageNpmVersion: packageJson.engines?.npm ?? null,
      packageManager: packageJson.packageManager ?? null,
      branch: commandOutput("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], root),
      headSha: commandOutput("git", ["rev-parse", "--verify", "HEAD"], root),
      environment: JSON.parse(environmentText),
      dockerfile,
    },
    runtime: {
      node: process.version.replace(/^v/u, ""),
      npm: npmVersion,
      docker: Boolean(commandOutput("docker", ["--version"])),
      chromium: await chromiumAvailable(),
    },
    ownership: JSON.parse(ownershipText),
    executionPolicy: JSON.parse(executionPolicyText),
    expected: {
      node: expectedNodeVersion,
      npm: packageManagerMatch?.[1] ?? null,
    },
  };
}

/** @param {string} id @param {boolean} passed @returns {{ id: string, status: "pass" | "fail" }} */
function check(id, passed) {
  return { id, status: passed ? "pass" : "fail" };
}

/** @param {string[]} blockers @param {string} blocker @param {boolean} passed @returns {boolean} */
function gate(blockers, blocker, passed) {
  if (!passed) blockers.push(blocker);
  return passed;
}

/**
 * @param {CursorCloudSnapshot} snapshot
 * @param {{ build?: boolean, activation?: unknown, referenceTime?: Date | string | number }} [options]
 */
export function evaluateCursorCloud(snapshot, options = {}) {
  /** @type {string[]} */
  const blockers = [];
  /** @type {Array<{ id: string, status: "pass" | "fail" }>} */
  const checks = [];
  /** @type {string[]} */
  const warnings = [];
  const repository = snapshot.repository ?? {};
  const runtime = snapshot.runtime ?? {};
  const buildRequired = options.build === true || options.activation !== undefined;
  const environmentErrors = validateCursorEnvironmentPolicy({
    environmentConfig: repository.environment,
    dockerfile: repository.dockerfile,
    packageJson: { scripts: { "cursor:doctor": "node tools/cursor-cloud-doctor.mjs" } },
  });

  checks.push(check("repository-policy", gate(
    blockers,
    "repository-policy-invalid",
    Array.isArray(repository.policyErrors) && repository.policyErrors.length === 0,
  )));
  checks.push(check("environment-definition", gate(
    blockers,
    "environment-definition-invalid",
    environmentErrors.length === 0,
  )));
  if (typeof repository.dockerfile === "string" && /^FROM\s+node:[^@\s]+$/mu.test(repository.dockerfile)) {
    warnings.push("base-image-not-digest-pinned");
  }
  if (buildRequired) {
    const repositoryVersionsMatch =
      repository.nodeVersion === expectedNodeVersion &&
      repository.nvmVersion === expectedNodeVersion &&
      repository.packageNodeVersion === expectedNodeVersion;
    checks.push(check("node-runtime", gate(
      blockers,
      "node-version-mismatch",
      repositoryVersionsMatch && runtime.node === expectedNodeVersion,
    )));
    const npmVersionsMatch =
      repository.packageNpmVersion === expectedNpmVersion &&
      repository.packageManager === `npm@${expectedNpmVersion}`;
    checks.push(check("npm-runtime", gate(
      blockers,
      "npm-version-mismatch",
      npmVersionsMatch && runtime.npm === expectedNpmVersion,
    )));
    checks.push(check("docker-executable", gate(
      blockers,
      "docker-executable-unavailable",
      runtime.docker === true,
    )));
    checks.push(check("chromium-executable", gate(
      blockers,
      "chromium-executable-unavailable",
      runtime.chromium === true,
    )));
  }

  let activation = null;
  let activationFailure = null;
  if (options.activation !== undefined) {
    try {
      activation = validateActivationEvidence(options.activation, snapshot.executionPolicy, {
        referenceTime: options.referenceTime,
      });
      checks.push(check("activation-schema", true));
    } catch (error) {
      blockers.push("activation-evidence-invalid");
      checks.push(check("activation-schema", false));
      activationFailure = error instanceof ActivationEvidenceError ? error.status : "blocked:ops";
    }
  }
  if (activation) {
    for (const [id, blocker, passed] of activationRepositoryBindingChecks(activation, repository, snapshot.ownership ?? {})) {
      checks.push(check(id, gate(blockers, blocker, passed)));
    }
  }

  const environmentBlocked = blockers.some((blocker) => [
    "repository-policy-invalid",
    "environment-definition-invalid",
    "node-version-mismatch",
    "npm-version-mismatch",
    "docker-executable-unavailable",
    "chromium-executable-unavailable",
  ].includes(blocker));
  const opsBlocked = blockers.some((blocker) => /(?:-mismatch|-unconfigured)$/u.test(blocker));
  const conflictBlocked = blockers.some((blocker) => [
    "current-branch-unavailable",
    "current-branch-not-cursor",
    "activation-branch-mismatch",
    "current-head-unavailable",
    "activation-head-mismatch",
  ].includes(blocker));
  return {
    status: environmentBlocked
      ? "blocked:environment"
      : conflictBlocked
        ? "blocked:conflict"
        : opsBlocked
          ? "blocked:ops"
          : activationFailure ?? "ready",
    checks,
    blockers,
    warnings,
  };
}

/** @param {ReturnType<typeof evaluateCursorCloud>} report @param {CursorOwnership} ownership @param {boolean} [activation] */
export function formatCursorCloudReport(report, ownership, activation = false) {
  const lines = ["Cursor Cloud doctor", `Status: ${report.status}`];
  for (const entry of report.checks) lines.push(`[${entry.status.toUpperCase()}] ${entry.id}`);
  if (report.blockers.length > 0) lines.push(`Blockers: ${report.blockers.join(", ")}`);
  if (report.warnings.length > 0) lines.push(`Warnings: ${report.warnings.join(", ")}`);
  if (activation) {
    /** @type {string[]} */
    const publicIds = [];
    const candidates = [
      ownership.github?.owner,
      ownership.github?.repository,
      ownership.supabase?.projectRef,
      ownership.vercel?.scope,
      ownership.vercel?.projectId,
      ownership.cloudflare?.accountId,
      ownership.cloudflare?.zoneId,
      ...(ownership.cloudflare?.domains ?? []),
    ];
    for (const value of candidates) {
      if (typeof value === "string" && value.length > 0) publicIds.push(value);
    }
    lines.push("Public config IDs:", ...publicIds.map((value) => `- ${value}`));
  }
  return `${lines.join("\n")}\n`;
}

/** @param {string[]} args */
function parseOptions(args) {
  let build = false;
  let activationInput = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--build") {
      build = true;
    } else if (argument === "--activation-input" && index + 1 < args.length) {
      activationInput = args[index + 1];
      index += 1;
    } else {
      throw new SafeCliError("Unknown Cursor Cloud doctor option.");
    }
  }
  if (!build && activationInput === null) throw new SafeCliError("Cursor Cloud doctor requires --build or --activation-input.");
  return { build: build || activationInput !== null, activationInput };
}

/** @param {string[]} args @param {string} root */
export async function runCli(args = process.argv.slice(2), root = process.cwd()) {
  const options = parseOptions(args);
  const snapshot = await collectCursorCloudSnapshot(root);
  const activation = options.activationInput === null
    ? undefined
    : await readActivationEvidence(root, options.activationInput, snapshot.executionPolicy);
  const report = evaluateCursorCloud(snapshot, { build: options.build, activation });
  process.stdout.write(formatCursorCloudReport(report, snapshot.ownership, activation !== undefined));
  if (report.status !== "ready") process.exitCode = 1;
  return report;
}

if (path.resolve(process.argv[1] ?? "") === modulePath) {
  runCli().catch((error) => {
    console.error(error instanceof SafeCliError ? error.message : "cursor-doctor-runtime-failure");
    process.exitCode = 1;
  });
}
