import { readFile } from "node:fs/promises";
import path from "node:path";
import { readAuthority } from "./authority-core.mjs";
import { providerPlaceholders, readTemplateState } from "./template-core.mjs";

/** @param {string} value */
function configured(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("REPLACEWITHOPERATOR") && value !== "REPLACE WITH OPERATOR";
}

/** @param {unknown} value @returns {unknown} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

/** @param {unknown} left @param {unknown} right */
function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

try {
  const root = process.cwd();
  const state = await readTemplateState(root);
  const ownership = readAuthority(root);
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const domain = JSON.parse(await readFile(path.join(root, "config", "domain.json"), "utf8"));
  const expectedHostname = new URL(state.project.publicUrls.production).hostname;
  const localChecks = {
    packageSlug: packageJson.name === state.project.slug,
    githubOwnership: equal(ownership.accounts.github, state.project.accounts.github) && equal(ownership.resourceTargets.github, state.project.resourceTargets.github),
    productionHostname: domain.hostname === expectedHostname && ownership.resourceTargets.cloudflare.domains?.[0] === expectedHostname,
    localPorts: new Set(Object.values(state.project.localPorts)).size === Object.values(state.project.localPorts).length,
  };
  const providers = {
    github: {
      status: configured(ownership.accounts.github.login) && configured(ownership.resourceTargets.github.owner) && configured(ownership.resourceTargets.github.repository) ? "identity-recorded" : "needs-codex",
      reason: "Repository existence and permissions require a live external-operator check.",
    },
    supabase: {
      status: configured(ownership.accounts.supabase.organizationName) && Boolean(ownership.resourceTargets.supabase.projectRef) ? "configured" : "needs-codex",
      reason: ownership.resourceTargets.supabase.projectRef ? null : "No hosted projectRef is recorded.",
    },
    vercel: {
      status: ownership.accounts.vercel.teamId !== providerPlaceholders.vercelScope && ownership.resourceTargets.vercel.projectId !== providerPlaceholders.vercelProjectId ? "configured" : "needs-codex",
    },
    cloudflare: {
      status: ownership.accounts.cloudflare.accountId !== providerPlaceholders.cloudflareAccountId && ownership.resourceTargets.cloudflare.zoneId !== providerPlaceholders.cloudflareZoneId ? "configured" : "needs-codex",
    },
  };
  const result = {
    ok: Object.values(localChecks).every(Boolean),
    initialization: state.status,
    local: { status: Object.values(localChecks).every(Boolean) ? "ready" : "blocked", checks: localChecks },
    liveProviders: providers,
    distinction: "Local readiness does not imply hosted provider readiness.",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
