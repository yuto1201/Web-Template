import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directPatterns = [
  { label: "Supabase secret key", expression: /sb_secret_[A-Za-z0-9_-]{16,}/gu },
  { label: "decoded service-role claim", expression: /["']role["']\s*:\s*["']service_role["']/gu },
  { label: "server-only build sentinel", expression: /SERVER_ONLY_BUILD_SENTINEL_[A-Za-z0-9_-]+/gu },
];
const jwtPattern = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu;
const staticAssetExtensions = new Set([".css", ".html", ".js", ".json", ".txt"]);
const renderedPayloadExtensions = new Set([".body", ".html", ".rsc"]);
const secretEnvironmentName = /(?:API_KEY|DATABASE_URL|PASSWORD|PRIVATE_KEY|SECRET|SERVICE_ROLE|TOKEN|_KEY)$/iu;

/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(target));
    } else if (entry.isFile()) {
      files.push(target);
    }
  }
  return files;
}

/** @param {string} value */
function isServiceRoleJwt(value) {
  const payload = value.split(".")[1];
  if (!payload) {
    return false;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.role === "service_role";
  } catch {
    return false;
  }
}

/**
 * @param {string[]} files
 * @param {string} relativeTo
 * @param {Array<{ name: string, value: string }>} forbiddenValues
 */
async function scanFiles(files, relativeTo, forbiddenValues) {
  const findings = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const pattern of directPatterns) {
      pattern.expression.lastIndex = 0;
      if (pattern.expression.test(content)) {
        findings.push({ file: path.relative(relativeTo, file), label: pattern.label });
      }
    }

    jwtPattern.lastIndex = 0;
    if ([...content.matchAll(jwtPattern)].some(([candidate]) => isServiceRoleJwt(candidate))) {
      findings.push({ file: path.relative(relativeTo, file), label: "legacy service-role JWT" });
    }

    for (const forbidden of forbiddenValues) {
      if (content.includes(forbidden.value)) {
        findings.push({ file: path.relative(relativeTo, file), label: `server environment value (${forbidden.name})` });
      }
    }
  }
  return findings;
}

/**
 * Scan every file in a supplied directory. This export is used for focused unit fixtures.
 * @param {string} directory
 * @param {Array<{ name: string, value: string }>} [forbiddenValues]
 */
export async function scanClientBundle(directory, forbiddenValues = []) {
  return scanFiles(await listFiles(directory), directory, forbiddenValues);
}

/**
 * Scan assets and server-rendered payloads that a browser can receive from a Next.js build.
 * @param {string} nextOutputDirectory
 * @param {Array<{ name: string, value: string }>} [forbiddenValues]
 */
export async function scanNextBrowserArtifacts(nextOutputDirectory, forbiddenValues = []) {
  const roots = [
    { directory: path.join(nextOutputDirectory, "static"), extensions: staticAssetExtensions },
    { directory: path.join(nextOutputDirectory, "server", "app"), extensions: renderedPayloadExtensions },
  ];
  const files = [];
  for (const root of roots) {
    for (const file of await listFiles(root.directory)) {
      if (root.extensions.has(path.extname(file))) {
        files.push(file);
      }
    }
  }
  return scanFiles(files, nextOutputDirectory, forbiddenValues);
}

/** @param {NodeJS.ProcessEnv} environment */
export function collectServerEnvironmentValues(environment) {
  return Object.entries(environment)
    .filter(([name, value]) => (
      !name.startsWith("NEXT_PUBLIC_")
      && secretEnvironmentName.test(name)
      && typeof value === "string"
      && value.length >= 12
    ))
    .map(([name, value]) => ({ name, value: /** @type {string} */ (value) }));
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const nextOutputDirectory = path.resolve(process.argv[2] ?? path.join(repositoryRoot, ".next"));
  try {
    const findings = await scanNextBrowserArtifacts(
      nextOutputDirectory,
      collectServerEnvironmentValues(process.env),
    );
    if (findings.length > 0) {
      for (const finding of findings) {
        console.error(`Browser artifact violation: ${finding.label} in ${finding.file}`);
      }
      process.exitCode = 1;
      return;
    }
    console.warn("Browser artifact secret scan passed.");
  } catch (error) {
    console.error(`Browser artifact scan could not run: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
