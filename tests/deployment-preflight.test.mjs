import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalVercelOwnership,
  DeploymentCheckpointError,
  validateDeploymentPreflight,
} from "../tools/deployment-core.mjs";
import { readAuthority } from "../tools/authority-core.mjs";
import { providerPlaceholders } from "../tools/template-core.mjs";

const canonicalAuthority = readAuthority();

const requiredKeys = [
  "APP_ORIGIN",
  "AUTH_SIGNUP_MODE",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
];

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    source: "vercel-key-names-only",
    environments: {
      development: requiredKeys,
      preview: requiredKeys,
      production: requiredKeys,
      ...overrides,
    },
  };
}

async function fixture({ link = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-template-deploy-"));
  if (link) {
    await mkdir(path.join(root, ".vercel"), { recursive: true });
    await writeFile(path.join(root, ".vercel", "project.json"), JSON.stringify({
      orgId: canonicalAuthority.accounts.vercel.teamId,
      projectId: canonicalAuthority.resourceTargets.vercel.projectId,
      settings: { framework: "nextjs" },
    }), "utf8");
  }
  return root;
}

async function placeholderModule() {
  await mkdir(path.resolve(".artifacts"), { recursive: true });
  const root = await mkdtemp(path.join(path.resolve(".artifacts"), "deployment-placeholder-"));
  await mkdir(path.join(root, "config"));
  await mkdir(path.join(root, "tools"));
  await copyFile(path.resolve("config/deployment.json"), path.join(root, "config", "deployment.json"));
  await copyFile(path.resolve("tools/authority-core.mjs"), path.join(root, "tools", "authority-core.mjs"));
  await copyFile(path.resolve("tools/deployment-core.mjs"), path.join(root, "tools", "deployment-core.mjs"));
  await copyFile(path.resolve("tools/template-core.mjs"), path.join(root, "tools", "template-core.mjs"));
  const placeholderAuthority = structuredClone(canonicalAuthority);
  placeholderAuthority.accounts.vercel.teamId = providerPlaceholders.vercelScope;
  placeholderAuthority.resourceTargets.vercel.projectId = providerPlaceholders.vercelProjectId;
  await writeFile(path.join(root, "config", "ownership.json"), JSON.stringify(placeholderAuthority), "utf8");
  const moduleUrl = `${pathToFileURL(path.join(root, "tools", "deployment-core.mjs")).href}?placeholder=${Date.now()}`;
  return { root, module: await import(moduleUrl) };
}

describe("Vercel deployment preflight", () => {
  it("keeps the compatibility export aligned with canonical authority paths", () => {
    expect(canonicalVercelOwnership).toEqual({
      scope: canonicalAuthority.accounts.vercel.teamId,
      projectId: canonicalAuthority.resourceTargets.vercel.projectId,
    });
  });
  it("accepts exact linkage and names-only environment coverage", async () => {
    const root = await fixture();
    await expect(validateDeploymentPreflight(snapshot(), root)).resolves.toMatchObject({
      ok: true,
      checkpoint: "preflight",
      environments: {
        development: { missing: 0, forbidden: 0 },
        preview: { missing: 0, forbidden: 0 },
        production: { missing: 0, forbidden: 0 },
      },
    });
  });

  it("blocks at the exact link checkpoint when linkage is missing", async () => {
    const root = await fixture({ link: false });
    await expect(validateDeploymentPreflight(snapshot(), root)).rejects.toMatchObject({
      name: "DeploymentCheckpointError",
      checkpoint: "link",
    });
  });

  it("rejects parser-valid inactive Vercel placeholder authority", async () => {
    const fixture = await placeholderModule();
    try {
      await mkdir(path.join(fixture.root, ".vercel"));
      await writeFile(path.join(fixture.root, ".vercel", "project.json"), JSON.stringify({
        orgId: providerPlaceholders.vercelScope,
        projectId: providerPlaceholders.vercelProjectId,
      }), "utf8");
      await expect(fixture.module.validateDeploymentPreflight(snapshot(), fixture.root)).rejects.toMatchObject({ checkpoint: "ownership" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("blocks missing environment keys without accepting values", async () => {
    const root = await fixture();
    const missing = snapshot({ preview: requiredKeys.filter((key) => key !== "APP_ORIGIN") });
    await expect(validateDeploymentPreflight(missing, root)).rejects.toMatchObject({ checkpoint: "environment:preview" });
    await expect(validateDeploymentPreflight({ ...snapshot(), values: { APP_ORIGIN: "secret-value" } }, root))
      .rejects.toBeInstanceOf(DeploymentCheckpointError);
  });

  it("rejects production-secret keys from Preview", async () => {
    const root = await fixture();
    const withSecret = snapshot({ preview: [...requiredKeys, "SUPABASE_SERVICE_ROLE_KEY"] });
    await expect(validateDeploymentPreflight(withSecret, root)).rejects.toMatchObject({
      checkpoint: "environment:preview",
      message: expect.stringContaining("Forbidden keys: SUPABASE_SERVICE_ROLE_KEY"),
    });
  });
});
