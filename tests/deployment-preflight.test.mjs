import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalVercelOwnership,
  DeploymentCheckpointError,
  validateDeploymentPreflight,
} from "../tools/deployment-core.mjs";
import { readAuthority } from "../tools/authority-core.mjs";

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
