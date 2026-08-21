import { describe, expect, it } from "vitest";
import {
  canonicalVercelOwnership,
  validateReleaseEvidence,
  validateRemoteSchemaOrder,
} from "../tools/deployment-core.mjs";

const commitSha = "a".repeat(40);
const verificationTime = new Date("2026-08-21T02:10:00+09:00");

function evidence(overrides = {}) {
  return {
    schemaVersion: 1,
    source: "vercel-api",
    environment: "production",
    teamId: canonicalVercelOwnership.scope,
    projectId: canonicalVercelOwnership.projectId,
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

describe("Vercel release evidence", () => {
  it("binds a READY production deployment and smoke results to the verified commit", () => {
    expect(validateReleaseEvidence(evidence(), commitSha, verificationTime)).toMatchObject({
      ok: true,
      commitSha,
      teamId: canonicalVercelOwnership.scope,
      projectId: canonicalVercelOwnership.projectId,
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
