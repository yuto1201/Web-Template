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

class ActivationEvidenceError extends Error {
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
});
const buildSchema = z.strictObject({
  status: z.literal("ready"),
  node: z.literal(expectedNodeVersion),
  npm: z.literal(expectedNpmVersion),
  docker: z.literal(true),
  chromium: z.literal(true),
});
const reviewerProbeSchema = (modelPattern) => z.strictObject({
  observed: z.string().regex(modelPattern),
  readonlyProbe: z.literal("passed"),
  providerToolProbe: z.literal("denied"),
});
const verifiedSource = z.literal("config/ownership.json");

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
      target: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
      status: z.literal("verified"),
    }),
    supabase: z.strictObject({
      owner: z.string().trim().min(1).max(160),
      targetSource: verifiedSource,
      status: z.literal("verified"),
    }),
    vercel: z.strictObject({
      ownerSource: verifiedSource,
      targetSource: verifiedSource,
      status: z.literal("verified"),
    }),
    cloudflare: z.strictObject({
      owner: z.string().trim().min(1).max(160),
      targetSource: verifiedSource,
      status: z.literal("verified"),
    }),
  }),
  verifiedAt: z.string().refine(isRfc3339Timestamp),
});

/** @param {unknown} value */
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

/** @param {unknown} value */
export function validateActivationEvidence(value) {
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
  return result.data;
}

/** @param {string} command @param {string[]} args */
function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
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

/** @param {string} root @param {string} input */
export async function readActivationEvidence(root, input) {
  if (path.isAbsolute(input)) {
    throw new Error("Activation input must stay in the redacted artifact directory.");
  }
  const normalized = input.replaceAll("\\", "/");
  if (!/^\.artifacts\/cursor\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(normalized)) {
    throw new Error("Activation input must stay in the redacted artifact directory.");
  }
  const rootPath = await realpath(root);
  const target = path.resolve(rootPath, normalized);
  const prefix = `${path.join(rootPath, ".artifacts", "cursor")}${path.sep}`;
  if (!target.startsWith(prefix) || !(await isFile(target))) {
    throw new Error("Activation input must be a regular file.");
  }
  const resolvedTarget = await realpath(target);
  if (!resolvedTarget.startsWith(prefix)) {
    throw new Error("Activation input must be a regular file.");
  }
  const text = await readFile(resolvedTarget, "utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Cursor activation evidence must be valid JSON.");
  }
  return validateActivationEvidence(value);
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
  const [policyErrors, nodeVersion, nvmVersion, environmentText, dockerfile, ownershipText] = await Promise.all([
    validateRepository(root),
    readFile(path.join(root, ".node-version"), "utf8"),
    readFile(path.join(root, ".nvmrc"), "utf8"),
    readFile(path.join(root, ".cursor", "environment.json"), "utf8"),
    readFile(path.join(root, ".cursor", "Dockerfile"), "utf8"),
    readFile(path.join(root, "config", "ownership.json"), "utf8"),
  ]);
  return {
    repository: {
      policyErrors,
      nodeVersion: nodeVersion.trim(),
      nvmVersion: nvmVersion.trim(),
      packageNodeVersion: packageJson.engines?.node ?? null,
      packageNpmVersion: packageJson.engines?.npm ?? null,
      packageManager: packageJson.packageManager ?? null,
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
    expected: {
      node: expectedNodeVersion,
      npm: packageManagerMatch?.[1] ?? null,
    },
  };
}

/** @param {string} id @param {boolean} passed */
function check(id, passed) {
  return { id, status: passed ? "pass" : "fail" };
}

/** @param {string[]} blockers @param {string} blocker @param {boolean} passed */
function gate(blockers, blocker, passed) {
  if (!passed) blockers.push(blocker);
  return passed;
}

/**
 * @param {Awaited<ReturnType<typeof collectCursorCloudSnapshot>> | Record<string, any>} snapshot
 * @param {{ build?: boolean, activation?: unknown }} [options]
 */
export function evaluateCursorCloud(snapshot, options = {}) {
  const blockers = [];
  const checks = [];
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
      activation = validateActivationEvidence(options.activation);
      checks.push(check("activation-schema", true));
    } catch (error) {
      blockers.push("activation-evidence-invalid");
      checks.push(check("activation-schema", false));
      activationFailure = error instanceof ActivationEvidenceError ? error.status : "blocked:ops";
    }
  }
  if (activation) {
    const expectedGitHub = `${snapshot.ownership?.github?.owner ?? ""}/${snapshot.ownership?.github?.repository ?? ""}`;
    const ownershipChecks = [
      ["github-owner", "github-owner-mismatch", activation.providers.github.owner === snapshot.ownership?.github?.owner],
      ["github-target", "github-target-mismatch", activation.providers.github.target === expectedGitHub && activation.repository.fullName === expectedGitHub],
      ["supabase-owner", "supabase-owner-mismatch", activation.providers.supabase.owner === snapshot.ownership?.supabase?.organizationName],
      ["cloudflare-owner", "cloudflare-owner-mismatch", activation.providers.cloudflare.owner === snapshot.ownership?.cloudflare?.accountName],
    ];
    for (const [id, blocker, passed] of ownershipChecks) {
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
  const opsBlocked = blockers.some((blocker) => /(?:owner|target)-mismatch$/u.test(blocker));
  return {
    status: environmentBlocked
      ? "blocked:environment"
      : opsBlocked
        ? "blocked:ops"
        : activationFailure ?? "ready",
    checks,
    blockers,
    warnings,
  };
}

/** @param {ReturnType<typeof evaluateCursorCloud>} report @param {Record<string, any>} ownership @param {boolean} [activation] */
export function formatCursorCloudReport(report, ownership, activation = false) {
  const lines = ["Cursor Cloud doctor", `Status: ${report.status}`];
  for (const entry of report.checks) lines.push(`[${entry.status.toUpperCase()}] ${entry.id}`);
  if (report.blockers.length > 0) lines.push(`Blockers: ${report.blockers.join(", ")}`);
  if (report.warnings.length > 0) lines.push(`Warnings: ${report.warnings.join(", ")}`);
  if (activation) {
    const publicIds = [
      ownership.github?.owner,
      ownership.github?.repository,
      ownership.supabase?.projectRef,
      ownership.vercel?.scope,
      ownership.vercel?.projectId,
      ownership.cloudflare?.accountId,
      ownership.cloudflare?.zoneId,
      ...(ownership.cloudflare?.domains ?? []),
    ].filter((value) => typeof value === "string" && value.length > 0);
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
      throw new Error("Unknown Cursor Cloud doctor option.");
    }
  }
  if (!build && activationInput === null) throw new Error("Cursor Cloud doctor requires --build or --activation-input.");
  return { build: build || activationInput !== null, activationInput };
}

/** @param {string[]} args @param {string} root */
export async function runCli(args = process.argv.slice(2), root = process.cwd()) {
  const options = parseOptions(args);
  const snapshot = await collectCursorCloudSnapshot(root);
  const activation = options.activationInput === null
    ? undefined
    : await readActivationEvidence(root, options.activationInput);
  const report = evaluateCursorCloud(snapshot, { build: options.build, activation });
  process.stdout.write(formatCursorCloudReport(report, snapshot.ownership, activation !== undefined));
  if (report.status !== "ready") process.exitCode = 1;
  return report;
}

if (path.resolve(process.argv[1] ?? "") === modulePath) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : "Cursor Cloud doctor failed.");
    process.exitCode = 1;
  });
}
