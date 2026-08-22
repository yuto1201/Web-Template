import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const providerPlaceholders = Object.freeze({
  supabaseOrganizationName: "REPLACE WITH CODEX",
  vercelScope: "team_REPLACEWITHCODEX",
  vercelProjectId: "prj_REPLACEWITHCODEX",
  cloudflareAccountId: "00000000000000000000000000000000",
  cloudflareAccountName: "REPLACE WITH CODEX",
  cloudflareZoneId: "11111111111111111111111111111111",
});

export const cursorTemplateGuardrailPaths = Object.freeze([
  ".cursor/Dockerfile",
  ".cursor/environment.json",
  ".cursor/hooks.json",
  ".cursor/agents/change-evaluator-anthropic.md",
  ".cursor/agents/change-evaluator-openai.md",
  ".cursor/agents/consultant-anthropic.md",
  ".cursor/agents/consultant-openai.md",
  ".cursor/agents/supabase-auditor-anthropic.md",
  ".cursor/agents/supabase-auditor-openai.md",
  "config/execution.json",
  "docs/onboarding-cursor-cloud.md",
]);

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const ignoredDirectories = new Set([
  ".artifacts", ".git", ".next", ".supabase", ".vercel", ".worktrees",
  "coverage", "node_modules", "out", "playwright-report", "test-results",
]);
const ignoredFileExtensions = new Set([
  ".gif", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".tsbuildinfo", ".webp", ".zip",
]);
const credentialEvidencePatterns = Object.freeze([
  {
    kind: "supabase-service-role-assignment",
    source: `["']?(?:SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|SERVICE_ROLE_KEY)["']?\\s*[:=]\\s*["']?(?:eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}|sb_(?:secret|p)_[A-Za-z0-9_-]{20,})`,
    flags: "giu",
  },
  {
    kind: "vercel-token-assignment",
    source: `["']?(?:VERCEL_TOKEN|VERCEL_ACCESS_TOKEN)["']?\\s*[:=]\\s*["']?[A-Za-z0-9_-]{20,}`,
    flags: "giu",
  },
  {
    kind: "cloudflare-credential-assignment",
    source: `["']?(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CLOUDFLARE_GLOBAL_API_KEY|CF_API_KEY)["']?\\s*[:=]\\s*["']?[A-Za-z0-9_-]{20,}`,
    flags: "giu",
  },
  {
    kind: "aws-secret-assignment",
    source: `["']?(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)["']?\\s*[:=]\\s*["']?[A-Za-z0-9/+=_-]{32,}`,
    flags: "giu",
  },
  { kind: "private-key", source: "-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----", flags: "gu" },
  { kind: "github-fine-grained-token", source: "\\bgithub_pat_[A-Za-z0-9_]{20,}\\b", flags: "gu" },
  { kind: "github-classic-token", source: "\\bgh[pousr]_[A-Za-z0-9_]{30,}\\b", flags: "gu" },
  { kind: "aws-access-key", source: "\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b", flags: "gu" },
  { kind: "supabase-access-token", source: "\\bsbp_[A-Za-z0-9]{20,}\\b", flags: "gu" },
  { kind: "supabase-secret-key", source: "\\bsb_secret_[A-Za-z0-9_-]{20,}\\b", flags: "gu" },
  { kind: "stripe-live-key", source: "\\bsk_live_[A-Za-z0-9]{20,}\\b", flags: "gu" },
  { kind: "cloudflare-legacy-key", source: "\\bv1\\.0-[A-Za-z0-9_-]{40,}\\b", flags: "gu" },
]);

/**
 * Return only fixed credential categories and offsets; never return candidate values.
 * Overlapping raw-token and assignment matches represent one credential finding.
 * @param {string} content
 */
export function findCredentialEvidence(content) {
  /** @type {Array<{ kind: string, index: number, end: number }>} */
  const findings = [];
  for (const definition of credentialEvidencePatterns) {
    const pattern = new RegExp(definition.source, definition.flags);
    for (const match of content.matchAll(pattern)) {
      const index = match.index ?? 0;
      const end = index + match[0].length;
      if (findings.some((finding) => index < finding.end && end > finding.index)) continue;
      findings.push({ kind: definition.kind, index, end });
    }
  }
  return findings
    .toSorted((left, right) => left.index - right.index || left.kind.localeCompare(right.kind))
    .map(({ kind, index }) => ({ kind, index }));
}
const portOffsets = Object.freeze({
  supabaseBase: 0,
  supabaseApi: 1,
  supabaseDb: 2,
  supabaseStudio: 3,
  supabaseMail: 4,
  supabaseAnalytics: 7,
  supabasePooler: 9,
  supabaseInspector: 63,
});

/** @param {string} root @param {string} relative */
async function isIgnoredSddControllerDirectory(root, relative) {
  if (relative.split(path.sep).join("/") !== ".superpowers/sdd") return false;
  try {
    const ignore = await readFile(path.join(root, relative, ".gitignore"), "utf8");
    const rules = ignore.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    return rules.length === 1 && rules[0] === "*";
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** @param {unknown} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {unknown} value @param {string} label */
function object(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  return /** @type {Record<string, any>} */ (value);
}

/** @param {Record<string, any>} value @param {string[]} allowed @param {string} label */
function exactKeys(value, allowed, label) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  assert(extras.length === 0, `${label} contains unsupported keys: ${extras.join(", ")}.`);
}

/** @param {unknown} value @param {string} label @param {RegExp} pattern */
function string(value, label, pattern) {
  assert(typeof value === "string" && pattern.test(value), `${label} is invalid.`);
  return value;
}

/** @param {unknown} value @param {string} label */
function nullableString(value, label) {
  assert(value === null || typeof value === "string", `${label} must be a string or null.`);
  return value;
}

/** @param {unknown} value @param {string} label */
function port(value, label) {
  assert(Number.isInteger(value) && Number(value) >= 1024 && Number(value) <= 65535, `${label} must be an unprivileged TCP port.`);
  return Number(value);
}

/** @param {unknown} value */
function normalizeHttpsOrigin(value) {
  assert(typeof value === "string", "publicUrls.production must be an HTTPS origin.");
  const url = new URL(/** @type {string} */ (value));
  assert(
    url.protocol === "https:" && !url.username && !url.password && !url.port &&
      url.pathname === "/" && !url.search && !url.hash,
    "publicUrls.production must be a credential-free HTTPS origin without a path, query, or fragment.",
  );
  return url.origin;
}

/** @param {unknown} value */
export function normalizeInitializationConfig(value) {
  const input = object(value, "Initialization config");
  exactKeys(input, ["schemaVersion", "appName", "slug", "github", "localPorts", "publicUrls", "ownership"], "Initialization config");
  assert(input.schemaVersion === 1, "Initialization config schemaVersion must be 1.");
  const appName = string(input.appName, "appName", /^(?=.{2,64}$)[^\r\n\t"\\]+$/u);
  const slug = string(input.slug, "slug", /^(?=.{2,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/u);

  const github = object(input.github, "github");
  exactKeys(github, ["owner", "repository"], "github");
  const githubOwner = string(github.owner, "github.owner", /^(?=.{1,39}$)(?!-)[A-Za-z0-9-]+(?<!-)$/u);
  const githubRepository = string(github.repository, "github.repository", /^(?=.{1,100}$)[A-Za-z0-9._-]+$/u);

  const localPorts = object(input.localPorts, "localPorts");
  exactKeys(localPorts, ["app", "supabaseBase"], "localPorts");
  const appPort = port(localPorts.app, "localPorts.app");
  const supabaseBase = port(localPorts.supabaseBase, "localPorts.supabaseBase");
  const derivedPorts = Object.fromEntries(Object.entries(portOffsets).map(([key, offset]) => [key, supabaseBase + offset]));
  for (const [key, valueAtPort] of Object.entries(derivedPorts)) port(valueAtPort, `derived localPorts.${key}`);
  const uniquePorts = [appPort, ...Object.values(derivedPorts)];
  assert(new Set(uniquePorts).size === uniquePorts.length, "Local application and Supabase ports must not overlap.");

  const publicUrls = object(input.publicUrls, "publicUrls");
  exactKeys(publicUrls, ["production"], "publicUrls");
  const production = normalizeHttpsOrigin(publicUrls.production);

  const ownership = object(input.ownership, "ownership");
  exactKeys(ownership, ["supabase", "vercel", "cloudflare"], "ownership");
  const supabase = object(ownership.supabase, "ownership.supabase");
  exactKeys(supabase, ["organizationName", "projectRef"], "ownership.supabase");
  const supabaseOrganization = nullableString(supabase.organizationName, "ownership.supabase.organizationName") ?? providerPlaceholders.supabaseOrganizationName;
  string(supabaseOrganization, "ownership.supabase.organizationName", /^(?=.{1,128}$)[^\r\n"\\]+$/u);
  const supabaseProjectRef = nullableString(supabase.projectRef, "ownership.supabase.projectRef");
  if (supabaseProjectRef !== null) string(supabaseProjectRef, "ownership.supabase.projectRef", /^[a-z0-9]{20}$/u);

  const vercel = object(ownership.vercel, "ownership.vercel");
  exactKeys(vercel, ["scope", "projectId"], "ownership.vercel");
  const vercelScope = nullableString(vercel.scope, "ownership.vercel.scope") ?? providerPlaceholders.vercelScope;
  const vercelProjectId = nullableString(vercel.projectId, "ownership.vercel.projectId") ?? providerPlaceholders.vercelProjectId;
  string(vercelScope, "ownership.vercel.scope", /^team_[A-Za-z0-9]+$/u);
  string(vercelProjectId, "ownership.vercel.projectId", /^prj_[A-Za-z0-9]+$/u);

  const cloudflare = object(ownership.cloudflare, "ownership.cloudflare");
  exactKeys(cloudflare, ["accountId", "accountName", "zoneId", "zoneName"], "ownership.cloudflare");
  const cloudflareAccountId = nullableString(cloudflare.accountId, "ownership.cloudflare.accountId") ?? providerPlaceholders.cloudflareAccountId;
  const cloudflareAccountName = nullableString(cloudflare.accountName, "ownership.cloudflare.accountName") ?? providerPlaceholders.cloudflareAccountName;
  const cloudflareZoneId = nullableString(cloudflare.zoneId, "ownership.cloudflare.zoneId") ?? providerPlaceholders.cloudflareZoneId;
  const cloudflareZoneName = string(cloudflare.zoneName, "ownership.cloudflare.zoneName", /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/u);
  string(cloudflareAccountId, "ownership.cloudflare.accountId", /^[0-9a-f]{32}$/u);
  string(cloudflareZoneId, "ownership.cloudflare.zoneId", /^[0-9a-f]{32}$/u);
  string(cloudflareAccountName, "ownership.cloudflare.accountName", /^(?=.{1,128}$)[^\r\n"\\]+$/u);

  const hostname = new URL(production).hostname;
  assert(hostname === `${slug}.${cloudflareZoneName}`, "The production hostname must be slug.cloudflareZoneName for the DNS-only starter policy.");

  return {
    schemaVersion: 1,
    appName,
    slug,
    github: { owner: githubOwner, repository: githubRepository },
    localPorts: { app: appPort, ...derivedPorts },
    publicUrls: {
      localhost: `http://localhost:${appPort}`,
      loopback: `http://127.0.0.1:${appPort}`,
      production,
    },
    ownership: {
      supabase: { organizationName: supabaseOrganization, projectRef: supabaseProjectRef },
      vercel: { scope: vercelScope, projectId: vercelProjectId },
      cloudflare: {
        accountId: cloudflareAccountId,
        accountName: cloudflareAccountName,
        zoneId: cloudflareZoneId,
        zoneName: cloudflareZoneName,
      },
    },
  };
}

/** @param {Record<string, any>} project @returns {Record<string, string>} */
export function projectTokens(project) {
  return {
    productionUrl: project.publicUrls.production,
    productionHostname: new URL(project.publicUrls.production).hostname,
    localhostOrigin: project.publicUrls.localhost,
    loopbackOrigin: project.publicUrls.loopback,
    supabaseOrganizationName: project.ownership.supabase.organizationName,
    vercelProjectId: project.ownership.vercel.projectId,
    vercelScope: project.ownership.vercel.scope,
    cloudflareAccountId: project.ownership.cloudflare.accountId,
    cloudflareAccountName: project.ownership.cloudflare.accountName,
    cloudflareZoneId: project.ownership.cloudflare.zoneId,
    cloudflareZoneName: project.ownership.cloudflare.zoneName,
    githubRepository: project.github.repository,
    githubOwner: project.github.owner,
    appName: project.appName,
    slug: project.slug,
    supabaseBasePort: String(project.localPorts.supabaseBase),
    supabaseApiPort: String(project.localPorts.supabaseApi),
    supabaseDbPort: String(project.localPorts.supabaseDb),
    supabaseStudioPort: String(project.localPorts.supabaseStudio),
    supabaseMailPort: String(project.localPorts.supabaseMail),
    supabaseAnalyticsPort: String(project.localPorts.supabaseAnalytics),
    supabasePoolerPort: String(project.localPorts.supabasePooler),
    supabaseInspectorPort: String(project.localPorts.supabaseInspector),
  };
}

/** @param {string} root @param {string} [relative] @returns {Promise<string[]>} */
async function textFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name) && !(await isIgnoredSddControllerDirectory(root, child))) {
        files.push(...await textFiles(root, child));
      }
      continue;
    }
    if (entry.name === ".git") continue;
    if (!entry.isFile() || ignoredFileExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    if ((entry.name === ".env" || entry.name.startsWith(".env.")) && entry.name !== ".env.example") continue;
    const content = await readFile(path.join(root, child));
    if (content.includes(0)) continue;
    files.push(child.split(path.sep).join("/"));
  }
  return files.toSorted();
}

/** @param {string} content @param {string} token */
function count(content, token) {
  let matches = 0;
  let position = 0;
  while ((position = content.indexOf(token, position)) !== -1) {
    matches += 1;
    position += token.length;
  }
  return matches;
}

/** @param {string} root @param {Record<string, string>} tokens */
export async function discoverOccurrences(root, tokens) {
  /** @type {Record<string, Record<string, number>>} */
  const result = Object.fromEntries(Object.keys(tokens).map((key) => [key, {}]));
  for (const relative of await textFiles(root)) {
    const content = await readFile(path.join(root, relative), "utf8");
    for (const [key, token] of Object.entries(tokens)) {
      const occurrences = count(content, token);
      if (occurrences > 0) result[key][relative] = occurrences;
    }
  }
  return result;
}

/** @param {string} root */
export async function verifyCursorTemplateRetention(root) {
  let sourceAccountCredentials = 0;
  const credentialPaths = [];
  for (const relative of cursorTemplateGuardrailPaths) {
    const content = await readFile(path.join(root, relative), "utf8");
    assert(content.length > 0, `Retained Cursor guardrail is empty: ${relative}.`);
    const findings = findCredentialEvidence(content);
    sourceAccountCredentials += findings.length;
    if (findings.length > 0) credentialPaths.push(relative);
  }
  assert(
    sourceAccountCredentials === 0,
    `Retained Cursor guardrail contains a provider credential: ${credentialPaths.join(", ")}.`,
  );
  const expectedAgents = cursorTemplateGuardrailPaths
    .filter((relative) => relative.startsWith(".cursor/agents/"))
    .map((relative) => path.basename(relative))
    .toSorted();
  const actualAgents = (await readdir(path.join(root, ".cursor", "agents"))).toSorted();
  assert(
    JSON.stringify(actualAgents) === JSON.stringify(expectedAgents),
    "Generated repository must retain exactly the six canonical Cursor agents.",
  );
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const readmeCredentialFindings = findCredentialEvidence(readme);
  sourceAccountCredentials += readmeCredentialFindings.length;
  assert(sourceAccountCredentials === 0, "Retained Cursor onboarding link contains a provider credential.");
  assert(
    readme.includes("[Cursor Cloud onboarding](docs/onboarding-cursor-cloud.md)"),
    "Generated repository must link to Cursor Cloud onboarding.",
  );
  return {
    files: [...cursorTemplateGuardrailPaths],
    cursorAgents: actualAgents.length,
    onboarding: "docs/onboarding-cursor-cloud.md",
    sourceAccountCredentials,
  };
}

/** @param {unknown} value */
export function validateTemplateState(value) {
  const state = object(value, "config/template.json");
  exactKeys(state, ["schemaVersion", "status", "project", "occurrences", "initializationFingerprint", "managedHashes"], "config/template.json");
  assert(state.schemaVersion === 1, "config/template.json schemaVersion must be 1.");
  assert(state.status === "template-source" || state.status === "initialized", "config/template.json status is invalid.");
  object(state.project, "config/template.json project");
  object(state.occurrences, "config/template.json occurrences");
  if (state.status === "initialized") {
    string(state.initializationFingerprint, "config/template.json initializationFingerprint", /^[0-9a-f]{64}$/u);
    const managedHashes = object(state.managedHashes, "config/template.json managedHashes");
    assert(Object.keys(managedHashes).length > 0, "Initialized template state needs managed file hashes.");
    for (const [relative, digest] of Object.entries(managedHashes)) {
      assert(!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith("../"), "A managed hash path escapes the repository.");
      string(digest, `managedHashes.${relative}`, /^[0-9a-f]{64}$/u);
    }
  } else {
    assert(state.initializationFingerprint === undefined, "The template source must not have an initialization fingerprint.");
    assert(state.managedHashes === undefined, "The template source must not have managed file hashes.");
  }
  return state;
}

/** @param {string} root */
export async function readTemplateState(root) {
  return validateTemplateState(JSON.parse(await readFile(path.join(root, "config", "template.json"), "utf8")));
}

/** @param {string} root @param {Record<string, any>} state */
export async function verifyTemplateSource(root, state) {
  assert(state.status === "template-source", "Source occurrence verification applies only to the template source.");
  const tokens = projectTokens(state.project);
  const values = Object.values(tokens);
  assert(values.every((value) => typeof value === "string" && value.length > 0), "Template source tokens must be non-empty strings.");
  assert(new Set(values).size === values.length, "Template source tokens must be unique.");
  const actual = await discoverOccurrences(root, tokens);
  if (JSON.stringify(actual) !== JSON.stringify(state.occurrences)) {
    throw new Error("Template-managed values no longer match their reviewed source occurrences; refusing to overwrite edited values.");
  }
  return { ok: true, tokenCount: values.length, fileCount: new Set(Object.values(actual).flatMap((files) => Object.keys(files))).size };
}

/** @param {unknown} value */
function fingerprint(value) {
  return sha256(JSON.stringify(value));
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** @param {string} root @param {unknown} configValue */
export async function initializeTemplate(root, configValue) {
  const state = await readTemplateState(root);
  const project = normalizeInitializationConfig(configValue);
  const desiredFingerprint = fingerprint(project);
  if (state.status === "initialized") {
    if (state.initializationFingerprint !== desiredFingerprint) {
      throw new Error("This repository is already initialized with different values.");
    }
    for (const [relative, expected] of Object.entries(state.managedHashes)) {
      const actual = sha256(await readFile(path.join(root, relative), "utf8"));
      if (actual !== expected) throw new Error(`Initialized managed file changed: ${relative}; refusing to report idempotence.`);
    }
    return { ok: true, status: "idempotent", changedFiles: [] };
  }

  await verifyTemplateSource(root, state);
  assert(project.appName !== state.project.appName, "appName must replace the template source name.");
  assert(project.slug !== state.project.slug, "slug must replace the template source slug.");
  assert(project.github.repository !== state.project.github.repository, "github.repository must replace the template source repository name.");

  const sourceTokens = projectTokens(state.project);
  const targetTokens = projectTokens(project);
  const sourceToTarget = new Map(Object.keys(sourceTokens).map((key) => [sourceTokens[key], targetTokens[key]]));
  const expression = new RegExp([...sourceToTarget.keys()].toSorted((left, right) => right.length - left.length).map(escapeRegExp).join("|"), "gu");
  const managedFiles = new Set(Object.values(state.occurrences).flatMap((files) => Object.keys(files)));
  const outputs = new Map();
  for (const relative of managedFiles) {
    const input = await readFile(path.join(root, relative), "utf8");
    outputs.set(relative, input.replace(expression, (match) => sourceToTarget.get(match) ?? match));
  }

  const ownershipPath = "config/ownership.json";
  const ownership = JSON.parse(outputs.get(ownershipPath) ?? await readFile(path.join(root, ownershipPath), "utf8"));
  ownership.github = project.github;
  ownership.supabase = project.ownership.supabase;
  ownership.vercel = project.ownership.vercel;
  ownership.cloudflare = {
    accountId: project.ownership.cloudflare.accountId,
    accountName: project.ownership.cloudflare.accountName,
    zoneId: project.ownership.cloudflare.zoneId,
    domains: [new URL(project.publicUrls.production).hostname],
  };
  outputs.set(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);

  const domainPath = "config/domain.json";
  const domain = JSON.parse(outputs.get(domainPath) ?? await readFile(path.join(root, domainPath), "utf8"));
  domain.hostname = new URL(project.publicUrls.production).hostname;
  domain.zoneName = project.ownership.cloudflare.zoneName;
  domain.recordName = project.slug;
  outputs.set(domainPath, `${JSON.stringify(domain, null, 2)}\n`);

  const statePath = "config/template.json";
  const managedHashes = Object.fromEntries([...outputs.entries()]
    .filter(([relative]) => relative !== statePath)
    .map(([relative, output]) => [relative, sha256(output)]));
  const initializedState = {
    schemaVersion: 1,
    status: "initialized",
    project,
    occurrences: {},
    initializationFingerprint: desiredFingerprint,
    managedHashes,
  };
  outputs.set(statePath, `${JSON.stringify(initializedState, null, 2)}\n`);

  const changedFiles = [];
  for (const [relative, output] of outputs) {
    if (output !== await readFile(path.join(root, relative), "utf8")) changedFiles.push(relative);
  }
  changedFiles.sort();
  for (const [relative, output] of outputs) {
    if (relative === statePath) continue;
    await writeFile(path.join(root, relative), output, "utf8");
  }
  await writeFile(path.join(root, statePath), outputs.get(statePath), "utf8");
  return { ok: true, status: "initialized", changedFiles };
}
