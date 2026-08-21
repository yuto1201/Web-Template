import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(modulePath), "..");

const supportedPlatforms = new Set(["darwin", "linux", "win32"]);
const supportedArchitectures = new Set(["arm64", "x64"]);

/** @param {string} id @param {string} label @param {"pass" | "fail" | "optional"} status @param {string} detail */
function check(id, label, status, detail) {
  return { id, label, status, detail };
}

/**
 * @typedef {object} WorkstationSnapshot
 * @property {string} platform
 * @property {string} arch
 * @property {string | null} requiredNodeVersion
 * @property {string | null} requiredNpmVersion
 * @property {string | null} nodeVersion
 * @property {string | null} npmVersion
 * @property {string | null} gitVersion
 * @property {{ git: boolean, packageJson: boolean, packageLock: boolean, agents: boolean }} repository
 * @property {boolean} dependenciesInstalled
 * @property {boolean} environmentFilePresent
 * @property {{ cliAvailable: boolean, daemonReachable: boolean }} docker
 */

/**
 * @param {WorkstationSnapshot} snapshot
 * @param {{ requireDocker?: boolean, requireEnvironment?: boolean }} [options]
 */
export function evaluateWorkstation(snapshot, options = {}) {
  const requireDocker = options.requireDocker === true;
  const requireEnvironment = options.requireEnvironment === true;
  const checks = [];

  checks.push(
    check(
      "platform",
      "Operating system",
      supportedPlatforms.has(snapshot.platform) ? "pass" : "fail",
      supportedPlatforms.has(snapshot.platform)
        ? `${snapshot.platform} is supported.`
        : `${snapshot.platform} is not in the supported workstation set.`,
    ),
  );
  checks.push(
    check(
      "architecture",
      "CPU architecture",
      supportedArchitectures.has(snapshot.arch) ? "pass" : "fail",
      supportedArchitectures.has(snapshot.arch)
        ? `${snapshot.arch} has pinned dependency support.`
        : `${snapshot.arch} is not covered by the lockfile and CI contract.`,
    ),
  );
  checks.push(
    check(
      "node",
      "Node.js",
      snapshot.requiredNodeVersion !== null && snapshot.nodeVersion === snapshot.requiredNodeVersion ? "pass" : "fail",
      snapshot.requiredNodeVersion !== null && snapshot.nodeVersion === snapshot.requiredNodeVersion
        ? `Node.js ${snapshot.requiredNodeVersion} matches .node-version.`
        : `Expected Node.js ${snapshot.requiredNodeVersion ?? "unavailable from .node-version"}; found ${snapshot.nodeVersion ?? "unavailable"}.`,
    ),
  );
  checks.push(
    check(
      "npm",
      "npm",
      snapshot.requiredNpmVersion !== null && snapshot.npmVersion === snapshot.requiredNpmVersion ? "pass" : "fail",
      snapshot.requiredNpmVersion !== null && snapshot.npmVersion === snapshot.requiredNpmVersion
        ? `npm ${snapshot.requiredNpmVersion} matches packageManager.`
        : `Expected npm ${snapshot.requiredNpmVersion ?? "unavailable from packageManager"}; found ${snapshot.npmVersion ?? "unavailable"}.`,
    ),
  );
  checks.push(
    check(
      "git",
      "Git",
      snapshot.gitVersion ? "pass" : "fail",
      snapshot.gitVersion ? `${snapshot.gitVersion} is available.` : "Git is unavailable.",
    ),
  );

  const missingRootFiles = Object.entries(snapshot.repository)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  checks.push(
    check(
      "repository-root",
      "Repository root",
      missingRootFiles.length === 0 ? "pass" : "fail",
      missingRootFiles.length === 0
        ? "Git metadata, package manifests, and AGENTS.md are present."
        : `Run from a fresh repository root; missing: ${missingRootFiles.join(", ")}.`,
    ),
  );
  checks.push(
    check(
      "dependencies",
      "Locked dependencies",
      snapshot.dependenciesInstalled ? "pass" : "fail",
      snapshot.dependenciesInstalled
        ? "node_modules matches an npm ci installation marker."
        : "Run npm ci before continuing.",
    ),
  );
  checks.push(
    check(
      "environment",
      "Local environment file",
      snapshot.environmentFilePresent ? "pass" : requireEnvironment ? "fail" : "optional",
      snapshot.environmentFilePresent
        ? ".env.local is present; values were not read."
        : requireEnvironment
          ? ".env.local is required for this gate. Re-enter values securely from .env.example."
          : ".env.local is absent; this is allowed until hosted Auth/data work begins.",
    ),
  );
  checks.push(
    check(
      "docker-cli",
      "Docker CLI",
      snapshot.docker.cliAvailable ? "pass" : requireDocker ? "fail" : "optional",
      snapshot.docker.cliAvailable
        ? "Docker CLI is available."
        : requireDocker
          ? "Docker CLI is required for the integration gate."
          : "Docker CLI is optional until local DB/Auth integration is run.",
    ),
  );
  checks.push(
    check(
      "docker-daemon",
      "Docker daemon",
      snapshot.docker.daemonReachable ? "pass" : requireDocker ? "fail" : "optional",
      snapshot.docker.daemonReachable
        ? "Docker daemon is reachable."
        : requireDocker
          ? "Start Docker Desktop and wait for the daemon before retrying."
          : "Docker daemon is optional until local DB/Auth integration is run.",
    ),
  );

  const ok = checks.every((entry) => entry.status !== "fail");
  return {
    ok,
    status: ok ? "ready" : "action-required",
    platform: snapshot.platform,
    architecture: snapshot.arch,
    checks,
  };
}

/** @param {string} target */
async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** @param {string} target */
async function textOrNull(target) {
  try {
    return (await readFile(target, "utf8")).trim();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** @param {string} command @param {string[]} args */
function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) return null;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output || null;
}

/** @param {string} root @returns {Promise<WorkstationSnapshot>} */
export async function collectWorkstationSnapshot(root = defaultRoot) {
  const nodeVersionFile = await textOrNull(path.join(root, ".node-version"));
  const packageText = await textOrNull(path.join(root, "package.json"));
  let packageManager = null;
  if (packageText !== null) {
    try {
      packageManager = JSON.parse(packageText).packageManager ?? null;
    } catch {
      packageManager = null;
    }
  }
  const npmMatch = typeof packageManager === "string" ? /^npm@(\d+\.\d+\.\d+)$/u.exec(packageManager) : null;
  const npmExecPath = process.env.npm_execpath;
  const npmVersion = npmExecPath
    ? commandOutput(process.execPath, [npmExecPath, "--version"])
    : process.platform === "win32"
      ? commandOutput("cmd.exe", ["/d", "/s", "/c", "npm --version"])
      : commandOutput("npm", ["--version"]);
  const dockerVersion = commandOutput("docker", ["--version"]);
  const dockerDaemon = dockerVersion ? commandOutput("docker", ["version", "--format", "{{.Server.Version}}"] ) : null;

  return {
    platform: process.platform,
    arch: process.arch,
    requiredNodeVersion: nodeVersionFile,
    requiredNpmVersion: npmMatch?.[1] ?? null,
    nodeVersion: process.version.replace(/^v/u, ""),
    npmVersion,
    gitVersion: commandOutput("git", ["--version"]),
    repository: {
      git: await exists(path.join(root, ".git")),
      packageJson: await exists(path.join(root, "package.json")),
      packageLock: await exists(path.join(root, "package-lock.json")),
      agents: await exists(path.join(root, "AGENTS.md")),
    },
    dependenciesInstalled:
      (await exists(path.join(root, "node_modules"))) &&
      (await exists(path.join(root, "node_modules", ".package-lock.json"))),
    environmentFilePresent: await exists(path.join(root, ".env.local")),
    docker: {
      cliAvailable: Boolean(dockerVersion),
      daemonReachable: Boolean(dockerDaemon),
    },
  };
}

/** @param {ReturnType<typeof evaluateWorkstation>} report */
export function formatWorkstationReport(report) {
  const lines = [
    `Workstation: ${report.platform}/${report.architecture}`,
    `Status: ${report.status}`,
    "",
  ];
  for (const entry of report.checks) {
    lines.push(`[${entry.status.toUpperCase()}] ${entry.label}: ${entry.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

/** @param {string[]} args */
function parseOptions(args) {
  const allowed = new Set(["--json", "--require-docker", "--require-env"]);
  const unknown = args.filter((argument) => !allowed.has(argument));
  if (unknown.length > 0) throw new Error(`Unknown workstation doctor option: ${unknown.join(", ")}`);
  return {
    json: args.includes("--json"),
    requireDocker: args.includes("--require-docker"),
    requireEnvironment: args.includes("--require-env"),
  };
}

export async function runCli(args = process.argv.slice(2), root = process.cwd()) {
  const options = parseOptions(args);
  const snapshot = await collectWorkstationSnapshot(root);
  const report = evaluateWorkstation(snapshot, options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatWorkstationReport(report));
  if (!report.ok) process.exitCode = 1;
  return report;
}

if (path.resolve(process.argv[1] ?? "") === modulePath) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
