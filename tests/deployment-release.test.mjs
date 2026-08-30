import { describe, expect, it } from "vitest";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateReleaseEvidence,
  validateRemoteSchemaOrder,
} from "../tools/deployment-core.mjs";
import { readAuthority } from "../tools/authority-core.mjs";
import { providerPlaceholders } from "../tools/template-core.mjs";

const canonicalAuthority = readAuthority();

const commitSha = "a".repeat(40);
const verificationTime = new Date("2026-08-21T02:10:00+09:00");

function evidence(overrides = {}) {
  return {
    schemaVersion: 1,
    source: "vercel-api",
    environment: "production",
    teamId: canonicalAuthority.accounts.vercel.teamId,
    projectId: canonicalAuthority.resourceTargets.vercel.projectId,
    deploymentId: "dpl_WEBTEMPLATE123",
    url: "https://web-template-yuto16.vercel.app",
    status: "READY",
    commitSha,
    smoke: [
      { path: "/", status: 200, contains: "Start with the boundaries already drawn." },
      { path: "/health", status: 200, jsonStatus: "ok" },
    ],
    verifiedAt: "2026-08-21T02:00:00+09:00",
    ...overrides,
  };
}

async function placeholderModule() {
  await mkdir(path.resolve(".artifacts"), { recursive: true });
  const root = await mkdtemp(path.join(path.resolve(".artifacts"), "release-placeholder-"));
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

describe("Vercel release evidence", () => {
  it("binds a READY production deployment and smoke results to the verified commit", () => {
    expect(validateReleaseEvidence(evidence(), commitSha, verificationTime)).toMatchObject({
      ok: true,
      commitSha,
      teamId: canonicalAuthority.accounts.vercel.teamId,
      projectId: canonicalAuthority.resourceTargets.vercel.projectId,
    });
  });

  it("rejects a stale deployment SHA and the first failing smoke checkpoint", () => {
    expect(() => validateReleaseEvidence(evidence(), "b".repeat(40), verificationTime)).toThrow(/release-sha/u);
    expect(() => validateReleaseEvidence(evidence({
      smoke: [
        { path: "/", status: 500, contains: "Start with the boundaries already drawn." },
        { path: "/health", status: 200, jsonStatus: "ok" },
      ],
    }), commitSha, verificationTime)).toThrow(/\/ returned 500/u);
  });

  it("rejects release evidence bound to inactive Vercel placeholder authority", async () => {
    const fixture = await placeholderModule();
    try {
      expect(() => fixture.module.validateReleaseEvidence(evidence({
        teamId: providerPlaceholders.vercelScope,
        projectId: providerPlaceholders.vercelProjectId,
      }), commitSha, verificationTime)).toThrow(/ownership/u);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects stale, wrong-project, incomplete, and credential-bearing evidence", () => {
    expect(() => validateReleaseEvidence(evidence(), commitSha, new Date("2026-08-21T04:00:00+09:00"))).toThrow(/release-time/u);
    expect(() => validateReleaseEvidence(evidence({ projectId: "prj_DIFFERENT123" }), commitSha, verificationTime)).toThrow(/release-project/u);
    expect(() => validateReleaseEvidence(evidence({ smoke: [{ path: "/health", status: 200, jsonStatus: "ok" }] }), commitSha, verificationTime)).toThrow(/exactly cover/u);
    expect(() => validateReleaseEvidence(evidence({ url: "https://user:password@web-template-yuto16.vercel.app" }), commitSha, verificationTime)).toThrow();
  });

  it("keeps remote schema changes in expand, deploy, explicit-contract order", () => {
    expect(validateRemoteSchemaOrder()).toEqual({
      ok: true,
      stages: ["expand", "deploy", "contract"],
      contractRequiresExplicitApproval: true,
      productionReset: "forbidden",
    });
  });
});
