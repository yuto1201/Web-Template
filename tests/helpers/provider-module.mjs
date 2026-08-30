import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readAuthority } from "../../tools/authority-core.mjs";

/** @param {string} [root] */
export function activeProviderAuthority(root = path.resolve(".")) {
  const authority = structuredClone(readAuthority(root));
  authority.accounts.vercel.teamId = "team_TESTACCOUNT";
  authority.resourceTargets.vercel.projectId = "prj_TESTPROJECT";
  authority.accounts.cloudflare.accountId = "2".repeat(32);
  authority.accounts.cloudflare.accountName = "Test Cloudflare Account";
  authority.resourceTargets.cloudflare.zoneId = "3".repeat(32);
  return authority;
}

/**
 * Loads a provider core against an isolated, explicit authority fixture rather than the
 * source repository's personal authority or an initialized repository's placeholders.
 * @param {{ authority: Record<string, any>, core: string, configuration: string, prefix: string }} input
 */
export async function providerCoreModule({ authority, core, configuration, prefix }) {
  const artifacts = path.resolve(".artifacts");
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, prefix));
  await mkdir(path.join(root, "config"));
  await mkdir(path.join(root, "tools"));
  await copyFile(path.resolve("config", configuration), path.join(root, "config", configuration));
  await copyFile(path.resolve("tools", "authority-core.mjs"), path.join(root, "tools", "authority-core.mjs"));
  await copyFile(path.resolve("tools", core), path.join(root, "tools", core));
  await copyFile(path.resolve("tools", "template-core.mjs"), path.join(root, "tools", "template-core.mjs"));
  await writeFile(path.join(root, "config", "ownership.json"), `${JSON.stringify(authority, null, 2)}\n`, "utf8");
  const moduleUrl = `${pathToFileURL(path.join(root, "tools", core)).href}?fixture=${Date.now()}-${Math.random()}`;
  return { root, module: await import(moduleUrl) };
}
