import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const providerPlaceholders = Object.freeze({
  githubUserId: 1,
  githubNodeId: "REPLACEWITHCODEX",
  githubRepositoryId: 1,
  githubRepositoryNodeId: "REPLACEWITHCODEX_REPOSITORY",
  supabaseOrganizationName: "REPLACE WITH CODEX",
  supabaseOrganizationId: "replacewithcodex0000",
  vercelTeamName: "REPLACE WITH CODEX",
  vercelTeamSlug: "replace-with-codex",
  vercelScope: "team_REPLACEWITHCODEX",
  vercelProjectId: "prj_REPLACEWITHCODEX",
  cloudflareAccountId: "00000000000000000000000000000000",
  cloudflareAccountName: "REPLACE WITH CODEX",
  cloudflareLoginEmailHint: "not configured",
  cloudflareLoginEmailSha256: "0".repeat(64),
  cloudflareRequiredRole: "REPLACE WITH CODEX",
  cloudflareZoneId: "11111111111111111111111111111111",
  linearWorkspaceName: "REPLACE WITH CODEX",
  linearWorkspaceSlug: "replace-with-codex",
  linearWorkspaceUrl: "https://linear.app/replace-with-codex",
  linearUserName: "REPLACE WITH CODEX",
  linearUserEmailHint: "not configured",
  linearUserEmailSha256: "0".repeat(64),
  linearRequiredRole: "REPLACE WITH CODEX",
  linearTeamKey: "TBD",
});

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const ignoredDirectories = new Set([
  ".artifacts", ".git", ".next", ".supabase", ".superpowers", ".vercel", ".worktrees",
  "coverage", "node_modules", "out", "playwright-report", "test-results",
]);
const ignoredFileExtensions = new Set([
  ".gif", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".tsbuildinfo", ".webp", ".zip",
]);
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
function nullablePositiveInteger(value, label) {
  assert(value === null || (Number.isInteger(value) && Number(value) > 0), `${label} must be a positive integer or null.`);
  return value === null ? null : Number(value);
}

/** @param {unknown[]} values @param {string} label */
function rejectPartialAuthority(values, label) {
  const configured = values.filter((value) => value !== null).length;
  assert(configured === 0 || configured === values.length, `${label} contains partial authority; provide every field or null placeholders.`);
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
  exactKeys(input, ["schemaVersion", "appName", "slug", "localPorts", "publicUrls", "accounts", "servicePolicies", "resourceTargets"], "Initialization config");
  assert(input.schemaVersion === 2, "Initialization config schemaVersion must be 2.");
  const appName = string(input.appName, "appName", /^(?=.{2,64}$)[^\r\n\t"\\]+$/u);
  const slug = string(input.slug, "slug", /^(?=.{2,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/u);

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

  const hostname = new URL(production).hostname;
  assert(hostname.startsWith(`${slug}.`), "The production hostname must be slug.cloudflareZoneName for the DNS-only starter policy.");
  const cloudflareZoneName = hostname.slice(slug.length + 1);
  string(cloudflareZoneName, "cloudflareZoneName", /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/u);
  assert(hostname === `${slug}.${cloudflareZoneName}`, "The production hostname must be slug.cloudflareZoneName for the DNS-only starter policy.");

  const accounts = object(input.accounts, "accounts");
  exactKeys(accounts, ["github", "supabase", "vercel", "cloudflare", "linear"], "accounts");
  const githubAccount = object(accounts.github, "accounts.github");
  exactKeys(githubAccount, ["login", "userId", "nodeId"], "accounts.github");
  const githubLogin = string(githubAccount.login, "accounts.github.login", /^(?=.{1,39}$)(?!-)[A-Za-z0-9-]+(?<!-)$/u);
  const githubUserId = nullablePositiveInteger(githubAccount.userId, "accounts.github.userId");
  const githubNodeId = nullableString(githubAccount.nodeId, "accounts.github.nodeId");
  rejectPartialAuthority([githubUserId, githubNodeId], "accounts.github");
  if (githubNodeId !== null) string(githubNodeId, "accounts.github.nodeId", /^.{1,256}$/u);

  const supabaseAccount = object(accounts.supabase, "accounts.supabase");
  exactKeys(supabaseAccount, ["organizationName", "organizationId"], "accounts.supabase");
  const supabaseOrganizationName = nullableString(supabaseAccount.organizationName, "accounts.supabase.organizationName");
  const supabaseOrganizationId = nullableString(supabaseAccount.organizationId, "accounts.supabase.organizationId");
  if (supabaseOrganizationName !== null) string(supabaseOrganizationName, "accounts.supabase.organizationName", /^(?=.{1,128}$)[^\r\n"\\]+$/u);
  if (supabaseOrganizationId !== null) string(supabaseOrganizationId, "accounts.supabase.organizationId", /^[a-z0-9]{20}$/u);
  rejectPartialAuthority([supabaseOrganizationName, supabaseOrganizationId], "accounts.supabase");

  const vercelAccount = object(accounts.vercel, "accounts.vercel");
  exactKeys(vercelAccount, ["teamName", "teamSlug", "teamId", "requiredPlan"], "accounts.vercel");
  const vercelTeamName = nullableString(vercelAccount.teamName, "accounts.vercel.teamName");
  const vercelTeamSlug = nullableString(vercelAccount.teamSlug, "accounts.vercel.teamSlug");
  const vercelTeamId = nullableString(vercelAccount.teamId, "accounts.vercel.teamId");
  const vercelRequiredPlan = nullableString(vercelAccount.requiredPlan, "accounts.vercel.requiredPlan");
  rejectPartialAuthority([vercelTeamName, vercelTeamSlug, vercelTeamId, vercelRequiredPlan], "accounts.vercel");
  if (vercelTeamName !== null) string(vercelTeamName, "accounts.vercel.teamName", /^(?=.{1,128}$)[^\r\n"\\]+$/u);
  if (vercelTeamSlug !== null) string(vercelTeamSlug, "accounts.vercel.teamSlug", /^[a-z0-9-]+$/u);
  if (vercelTeamId !== null) string(vercelTeamId, "accounts.vercel.teamId", /^team_[A-Za-z0-9]+$/u);
  if (vercelRequiredPlan !== null) string(vercelRequiredPlan, "accounts.vercel.requiredPlan", /^(?:Hobby|Pro|Enterprise)$/u);

  const cloudflareAccount = object(accounts.cloudflare, "accounts.cloudflare");
  exactKeys(cloudflareAccount, ["accountId", "accountName", "loginEmailHint", "loginEmailSha256", "requiredRole", "allowedZonePlans"], "accounts.cloudflare");
  const cloudflareAccountId = nullableString(cloudflareAccount.accountId, "accounts.cloudflare.accountId");
  const cloudflareAccountName = nullableString(cloudflareAccount.accountName, "accounts.cloudflare.accountName");
  const cloudflareLoginEmailHint = nullableString(cloudflareAccount.loginEmailHint, "accounts.cloudflare.loginEmailHint");
  const cloudflareLoginEmailSha256 = nullableString(cloudflareAccount.loginEmailSha256, "accounts.cloudflare.loginEmailSha256");
  const cloudflareRequiredRole = nullableString(cloudflareAccount.requiredRole, "accounts.cloudflare.requiredRole");
  assert(cloudflareAccount.allowedZonePlans === null || Array.isArray(cloudflareAccount.allowedZonePlans), "accounts.cloudflare.allowedZonePlans must be an array or null.");
  const cloudflareAllowedZonePlans = cloudflareAccount.allowedZonePlans;
  if (cloudflareAccountId !== null) string(cloudflareAccountId, "accounts.cloudflare.accountId", /^[0-9a-f]{32}$/u);
  if (cloudflareAccountName !== null) string(cloudflareAccountName, "accounts.cloudflare.accountName", /^(?=.{1,128}$)[^\r\n"\\]+$/u);
  if (cloudflareLoginEmailSha256 !== null) string(cloudflareLoginEmailSha256, "accounts.cloudflare.loginEmailSha256", /^[0-9a-f]{64}$/u);
  if (cloudflareAllowedZonePlans !== null) assert(cloudflareAllowedZonePlans.length > 0 && cloudflareAllowedZonePlans.every((plan) => ["Free", "Pro", "Business", "Enterprise"].includes(plan)), "accounts.cloudflare.allowedZonePlans is invalid.");
  rejectPartialAuthority([cloudflareAccountId, cloudflareAccountName, cloudflareLoginEmailHint, cloudflareLoginEmailSha256, cloudflareRequiredRole, cloudflareAllowedZonePlans], "accounts.cloudflare");

  const linearAccount = object(accounts.linear, "accounts.linear");
  const linearKeys = ["workspaceName", "workspaceSlug", "workspaceUrl", "workspaceId", "userName", "userEmailHint", "userEmailSha256", "userId", "requiredRole"];
  exactKeys(linearAccount, linearKeys, "accounts.linear");
  const linearValues = Object.fromEntries(linearKeys.map((key) => [key, nullableString(linearAccount[key], `accounts.linear.${key}`)]));
  if (linearValues.workspaceName !== null) string(linearValues.workspaceName, "accounts.linear.workspaceName", /^.{1,256}$/u);
  if (linearValues.workspaceSlug !== null) string(linearValues.workspaceSlug, "accounts.linear.workspaceSlug", /^[a-z0-9-]+$/u);
  if (linearValues.workspaceUrl !== null) string(linearValues.workspaceUrl, "accounts.linear.workspaceUrl", /^https:\/\/linear\.app\/[a-z0-9-]+$/u);
  if (linearValues.workspaceId !== null) string(linearValues.workspaceId, "accounts.linear.workspaceId", /^.{1,256}$/u);
  if (linearValues.userName !== null) string(linearValues.userName, "accounts.linear.userName", /^.{1,256}$/u);
  if (linearValues.userEmailHint !== null) string(linearValues.userEmailHint, "accounts.linear.userEmailHint", /^.{1,128}$/u);
  if (linearValues.userEmailSha256 !== null) string(linearValues.userEmailSha256, "accounts.linear.userEmailSha256", /^[0-9a-f]{64}$/u);
  if (linearValues.userId !== null) string(linearValues.userId, "accounts.linear.userId", /^.{1,256}$/u);
  if (linearValues.requiredRole !== null) string(linearValues.requiredRole, "accounts.linear.requiredRole", /^.{1,256}$/u);

  const servicePolicies = object(input.servicePolicies, "servicePolicies");
  exactKeys(servicePolicies, ["github", "supabase", "vercel", "cloudflare", "linear"], "servicePolicies");
  for (const service of ["github", "supabase", "vercel", "cloudflare"]) {
    const policy = object(servicePolicies[service], `servicePolicies.${service}`);
    exactKeys(policy, ["mode"], `servicePolicies.${service}`);
    assert(policy.mode === "repository-active", `servicePolicies.${service}.mode must be repository-active.`);
  }
  const linearPolicy = object(servicePolicies.linear, "servicePolicies.linear");
  exactKeys(linearPolicy, ["mode"], "servicePolicies.linear");
  assert(linearPolicy.mode === "explicit-user-purpose-only", "servicePolicies.linear.mode must be explicit-user-purpose-only.");

  const resourceTargets = object(input.resourceTargets, "resourceTargets");
  exactKeys(resourceTargets, ["github", "supabase", "vercel", "cloudflare", "linear"], "resourceTargets");
  const githubTarget = object(resourceTargets.github, "resourceTargets.github");
  exactKeys(githubTarget, ["owner", "repository", "repositoryId", "repositoryNodeId"], "resourceTargets.github");
  const githubOwner = string(githubTarget.owner, "resourceTargets.github.owner", /^(?=.{1,39}$)(?!-)[A-Za-z0-9-]+(?<!-)$/u);
  const githubRepository = string(githubTarget.repository, "resourceTargets.github.repository", /^(?=.{1,100}$)[A-Za-z0-9._-]+$/u);
  const githubRepositoryId = nullablePositiveInteger(githubTarget.repositoryId, "resourceTargets.github.repositoryId");
  const githubRepositoryNodeId = nullableString(githubTarget.repositoryNodeId, "resourceTargets.github.repositoryNodeId");
  rejectPartialAuthority([githubRepositoryId, githubRepositoryNodeId], "resourceTargets.github");
  assert(githubLogin === githubOwner, "GitHub account login and repository owner must agree.");

  const supabaseTarget = object(resourceTargets.supabase, "resourceTargets.supabase");
  exactKeys(supabaseTarget, ["projectRef"], "resourceTargets.supabase");
  const supabaseProjectRef = nullableString(supabaseTarget.projectRef, "resourceTargets.supabase.projectRef");
  if (supabaseProjectRef !== null) string(supabaseProjectRef, "resourceTargets.supabase.projectRef", /^[a-z0-9]{20}$/u);

  const vercelTarget = object(resourceTargets.vercel, "resourceTargets.vercel");
  exactKeys(vercelTarget, ["projectId"], "resourceTargets.vercel");
  const vercelProjectId = nullableString(vercelTarget.projectId, "resourceTargets.vercel.projectId");
  if (vercelProjectId !== null) string(vercelProjectId, "resourceTargets.vercel.projectId", /^prj_[A-Za-z0-9]+$/u);

  const cloudflareTarget = object(resourceTargets.cloudflare, "resourceTargets.cloudflare");
  exactKeys(cloudflareTarget, ["zoneId", "domains"], "resourceTargets.cloudflare");
  const cloudflareZoneId = nullableString(cloudflareTarget.zoneId, "resourceTargets.cloudflare.zoneId");
  if (cloudflareZoneId !== null) string(cloudflareZoneId, "resourceTargets.cloudflare.zoneId", /^[0-9a-f]{32}$/u);
  assert(Array.isArray(cloudflareTarget.domains) && cloudflareTarget.domains.length === 1 && cloudflareTarget.domains[0] === hostname, "resourceTargets.cloudflare.domains must contain only the production hostname.");

  const linearTarget = object(resourceTargets.linear, "resourceTargets.linear");
  exactKeys(linearTarget, ["teamKey", "teamId"], "resourceTargets.linear");
  const linearTeamKey = nullableString(linearTarget.teamKey, "resourceTargets.linear.teamKey");
  const linearTeamId = nullableString(linearTarget.teamId, "resourceTargets.linear.teamId");
  if (linearTeamKey !== null) string(linearTeamKey, "resourceTargets.linear.teamKey", /^[A-Z][A-Z0-9]{1,15}$/u);
  if (linearTeamId !== null) string(linearTeamId, "resourceTargets.linear.teamId", /^.{1,256}$/u);
  const linearReadableIdentity = [
    linearValues.workspaceName,
    linearValues.workspaceSlug,
    linearValues.workspaceUrl,
    linearValues.userName,
    linearValues.userEmailHint,
    linearValues.userEmailSha256,
    linearValues.requiredRole,
    linearTeamKey,
  ];
  const linearStableIdentity = [linearValues.workspaceId, linearValues.userId, linearTeamId];
  rejectPartialAuthority(linearReadableIdentity, "Linear readable identity");
  rejectPartialAuthority(linearStableIdentity, "Linear stable identity");
  assert(linearStableIdentity.every((item) => item === null) || linearReadableIdentity.every((item) => item !== null), "Linear identity contains partial authority.");

  const project = {
    schemaVersion: 2,
    appName,
    slug,
    localPorts: { app: appPort, ...derivedPorts },
    publicUrls: {
      localhost: `http://localhost:${appPort}`,
      loopback: `http://127.0.0.1:${appPort}`,
      production,
    },
    authorization: {
      operatorLabels: ["codex", "claude"],
      externalOperatorRoles: ["implementer", "external-operator"],
      allowAutomaticAccountSwitch: false,
    },
    accounts: {
      github: { login: githubLogin, userId: githubUserId ?? providerPlaceholders.githubUserId, nodeId: githubNodeId ?? providerPlaceholders.githubNodeId },
      supabase: {
        organizationName: supabaseOrganizationName ?? providerPlaceholders.supabaseOrganizationName,
        organizationId: supabaseOrganizationId ?? providerPlaceholders.supabaseOrganizationId,
      },
      vercel: {
        teamName: vercelTeamName ?? providerPlaceholders.vercelTeamName,
        teamSlug: vercelTeamSlug ?? providerPlaceholders.vercelTeamSlug,
        teamId: vercelTeamId ?? providerPlaceholders.vercelScope,
        requiredPlan: vercelRequiredPlan ?? "Hobby",
      },
      cloudflare: {
        accountId: cloudflareAccountId ?? providerPlaceholders.cloudflareAccountId,
        accountName: cloudflareAccountName ?? providerPlaceholders.cloudflareAccountName,
        loginEmailHint: cloudflareLoginEmailHint ?? providerPlaceholders.cloudflareLoginEmailHint,
        loginEmailSha256: cloudflareLoginEmailSha256 ?? providerPlaceholders.cloudflareLoginEmailSha256,
        requiredRole: cloudflareRequiredRole ?? providerPlaceholders.cloudflareRequiredRole,
        allowedZonePlans: cloudflareAllowedZonePlans ?? ["Free"],
      },
      linear: {
        workspaceName: linearValues.workspaceName ?? providerPlaceholders.linearWorkspaceName,
        workspaceSlug: linearValues.workspaceSlug ?? providerPlaceholders.linearWorkspaceSlug,
        workspaceUrl: linearValues.workspaceUrl ?? providerPlaceholders.linearWorkspaceUrl,
        workspaceId: linearValues.workspaceId,
        userName: linearValues.userName ?? providerPlaceholders.linearUserName,
        userEmailHint: linearValues.userEmailHint ?? providerPlaceholders.linearUserEmailHint,
        userEmailSha256: linearValues.userEmailSha256 ?? providerPlaceholders.linearUserEmailSha256,
        userId: linearValues.userId,
        requiredRole: linearValues.requiredRole ?? providerPlaceholders.linearRequiredRole,
      },
    },
    servicePolicies: structuredClone(servicePolicies),
    resourceTargets: {
      github: {
        owner: githubOwner,
        repository: githubRepository,
        repositoryId: githubRepositoryId ?? providerPlaceholders.githubRepositoryId,
        repositoryNodeId: githubRepositoryNodeId ?? providerPlaceholders.githubRepositoryNodeId,
      },
      supabase: { projectRef: supabaseProjectRef },
      vercel: { projectId: vercelProjectId ?? providerPlaceholders.vercelProjectId },
      cloudflare: { zoneId: cloudflareZoneId ?? providerPlaceholders.cloudflareZoneId, domains: [hostname] },
      linear: { teamKey: linearTeamKey ?? providerPlaceholders.linearTeamKey, teamId: linearTeamId },
    },
    observations: {
      github: {
        displayName: "Not observed",
        createdAt: "1970-01-01T00:00:00.000Z",
        publicRepositories: 0,
        observedAt: "1970-01-01T00:00:00.000Z",
      },
    },
  };
  return project;
}

/** @param {Record<string, any>} project @returns {Record<string, string>} */
export function projectTokens(project) {
  const tokens = {
    productionUrl: project.publicUrls.production,
    productionHostname: new URL(project.publicUrls.production).hostname,
    localhostOrigin: project.publicUrls.localhost,
    loopbackOrigin: project.publicUrls.loopback,
    supabaseOrganizationName: project.accounts.supabase.organizationName,
    supabaseOrganizationId: project.accounts.supabase.organizationId,
    vercelTeamName: project.accounts.vercel.teamName,
    vercelTeamSlug: project.accounts.vercel.teamSlug,
    vercelTeamId: project.accounts.vercel.teamId,
    vercelProjectId: project.resourceTargets.vercel.projectId,
    cloudflareAccountId: project.accounts.cloudflare.accountId,
    cloudflareAccountName: project.accounts.cloudflare.accountName,
    cloudflareLoginEmailHint: project.accounts.cloudflare.loginEmailHint,
    cloudflareLoginEmailSha256: project.accounts.cloudflare.loginEmailSha256,
    cloudflareZoneId: project.resourceTargets.cloudflare.zoneId,
    cloudflareZoneName: new URL(project.publicUrls.production).hostname.slice(project.slug.length + 1),
    linearWorkspaceName: project.accounts.linear.workspaceName,
    linearWorkspaceSlug: project.accounts.linear.workspaceSlug,
    linearWorkspaceUrl: project.accounts.linear.workspaceUrl,
    linearWorkspaceId: project.accounts.linear.workspaceId,
    linearUserName: project.accounts.linear.userName,
    linearUserEmailHint: project.accounts.linear.userEmailHint,
    linearUserEmailSha256: project.accounts.linear.userEmailSha256,
    linearUserId: project.accounts.linear.userId,
    linearTeamKey: project.resourceTargets.linear.teamKey,
    linearTeamId: project.resourceTargets.linear.teamId,
    githubUserId: String(project.accounts.github.userId),
    githubNodeId: project.accounts.github.nodeId,
    githubRepositoryId: String(project.resourceTargets.github.repositoryId),
    githubRepositoryNodeId: project.resourceTargets.github.repositoryNodeId,
    githubRepository: project.resourceTargets.github.repository,
    githubOwner: project.resourceTargets.github.owner,
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
  return Object.fromEntries(Object.entries(tokens).filter(([, token]) => typeof token === "string" && token.length > 0));
}

/** @param {string} root @param {string} [relative] @returns {Promise<string[]>} */
async function textFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...await textFiles(root, child));
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

/** @param {unknown} value */
export function validateTemplateState(value) {
  const state = object(value, "config/template.json");
  exactKeys(state, ["schemaVersion", "status", "project", "occurrences", "initializationFingerprint", "managedHashes"], "config/template.json");
  assert(state.schemaVersion === 2, "config/template.json schemaVersion must be 2.");
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
  assert(project.resourceTargets.github.repository !== state.project.resourceTargets.github.repository, "resourceTargets.github.repository must replace the template source repository name.");

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
  ownership.schemaVersion = 2;
  ownership.authorization = project.authorization;
  ownership.accounts = project.accounts;
  ownership.servicePolicies = project.servicePolicies;
  ownership.resourceTargets = project.resourceTargets;
  ownership.observations = project.observations;
  for (const key of ["github", "supabase", "vercel", "cloudflare"]) delete ownership[key];
  const { parseAuthority } = await import("./authority-core.mjs");
  parseAuthority(ownership);
  outputs.set(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);

  const domainPath = "config/domain.json";
  const domain = JSON.parse(outputs.get(domainPath) ?? await readFile(path.join(root, domainPath), "utf8"));
  domain.hostname = new URL(project.publicUrls.production).hostname;
  domain.zoneName = new URL(project.publicUrls.production).hostname.slice(project.slug.length + 1);
  domain.recordName = project.slug;
  outputs.set(domainPath, `${JSON.stringify(domain, null, 2)}\n`);

  const statePath = "config/template.json";
  const managedHashes = Object.fromEntries([...outputs.entries()]
    .filter(([relative]) => relative !== statePath)
    .map(([relative, output]) => [relative, sha256(output)]));
  const initializedState = {
    schemaVersion: 2,
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
