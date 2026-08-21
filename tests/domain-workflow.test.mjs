import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createDomainPlan,
  validateDomainApplyPreflight,
  validateDomainPolicy,
  validateDomainRollbackPreflight,
  verifyDnsChange,
  verifyDomainRelease,
} from "../tools/domain-core.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repositoryRoot, "tools", "domain-workflow.mjs");
const planTime = new Date("2026-08-21T07:31:00.000Z");
const unrelatedRecords = [
  { id: "a".repeat(32), type: "CNAME", name: "app.yutodev.com", modifiedOn: "2026-05-19T15:43:41.711Z" },
  { id: "b".repeat(32), type: "AAAA", name: "test.yutodev.com", modifiedOn: "2026-04-27T05:40:28.511Z" },
];

/** @returns {any} */
function liveInput() {
  return {
    schemaVersion: 1,
    source: "codex-live-inspection",
    cloudflare: {
      observedAt: "2026-08-21T07:30:00.000Z",
      accountId: "7ea8e713d76506f9e303f58624829aa5",
      accountName: "Yuto Dev",
      zoneId: "df938e9c196edf952ff26e95f02edf49",
      zoneName: "yutodev.com",
      zoneStatus: "active",
      caaStatus: "absent",
      targetRecords: [],
      unrelatedRecords: [...unrelatedRecords],
    },
    vercel: {
      source: "vercel-api",
      observedAt: "2026-08-21T07:30:30.000Z",
      teamId: "team_ANEUn6gVL8dccPaY08wkvxFt",
      projectId: "prj_KCauT0Bgq4PBZjrxuA1PO3J0Q3Q8",
      hostname: "web-template.yutodev.com",
      ownershipVerified: true,
      configurationStatus: "pending",
      routing: { type: "CNAME", target: "cname.vercel-dns.com" },
    },
  };
}

/** @param {any} [input] @returns {any} */
function planFrom(input = liveInput()) {
  return createDomainPlan(input, planTime);
}

/** @param {any} plan @param {Record<string, any>} [overrides] @returns {any} */
function currentSnapshot(plan, overrides = {}) {
  return {
    ...plan.cloudflare,
    observedAt: "2026-08-21T07:32:00.000Z",
    ...overrides,
  };
}

/** @param {any} plan @param {Record<string, any>} [overrides] @returns {any} */
function changedSnapshot(plan, overrides = {}) {
  return currentSnapshot(plan, {
    targetRecords: [{
      id: "c".repeat(32),
      ...plan.desiredRecord,
      modifiedOn: "2026-08-21T07:31:30.000Z",
    }],
    ...overrides,
  });
}

describe("Cloudflare domain workflow", () => {
  it("derives one DNS-only record from recent live observations and stores rollback state", () => {
    const plan = planFrom();
    expect(plan).toMatchObject({
      action: "create",
      plannedAt: "2026-08-21T07:31:00.000Z",
      desiredRecord: {
        type: "CNAME",
        name: "web-template.yutodev.com",
        content: "cname.vercel-dns.com",
        proxied: false,
        ttl: 1,
      },
      rollback: { priorTargetRecords: [] },
    });
  });

  it("rejects wrong ownership, classification, routing, observation time, and secret-shaped extras", () => {
    const wrongZone = liveInput();
    wrongZone.cloudflare.zoneId = "c".repeat(32);
    expect(() => planFrom(wrongZone)).toThrow(/ownership/u);

    const wrongClassification = liveInput();
    wrongClassification.cloudflare.targetRecords = [{
      id: "c".repeat(32), type: "CNAME", name: "app.yutodev.com", content: "old.example.com", proxied: false, ttl: 1,
    }];
    expect(() => planFrom(wrongClassification)).toThrow(/classification/u);

    const unverified = /** @type {any} */ (liveInput());
    unverified.vercel.ownershipVerified = false;
    expect(() => planFrom(unverified)).toThrow(/Invalid input/u);

    const wrongTarget = liveInput();
    wrongTarget.vercel.routing.target = "attacker.example.com";
    expect(() => planFrom(wrongTarget)).toThrow(/unexpected shape/u);

    const disallowedA = /** @type {any} */ (liveInput());
    disallowedA.vercel.routing = { type: "A", target: "76.76.21.21" };
    expect(() => planFrom(disallowedA)).toThrow(/allowlist/u);

    const stale = liveInput();
    stale.cloudflare.observedAt = "2026-08-21T07:20:00.000Z";
    expect(() => planFrom(stale)).toThrow(/stale/u);

    const withSecret = /** @type {any} */ (liveInput());
    withSecret.cloudflare.apiToken = "must-not-be-serialized";
    expect(() => planFrom(withSecret)).toThrow(/Unrecognized key/u);
  });

  it("requires a fresh post-plan Cloudflare read and fixes the create API request", () => {
    const plan = planFrom();
    const current = currentSnapshot(plan, { unrelatedRecords: [...plan.cloudflare.unrelatedRecords].reverse() });
    expect(validateDomainApplyPreflight(current, plan, new Date("2026-08-21T07:32:30.000Z"))).toMatchObject({
      ok: true,
      action: "create",
      recordId: null,
      request: {
        method: "POST",
        path: "/zones/df938e9c196edf952ff26e95f02edf49/dns_records",
        body: plan.desiredRecord,
      },
    });
    expect(() => validateDomainApplyPreflight(current, plan, new Date("2026-08-21T07:42:00.000Z"))).toThrow(/stale/u);
    expect(() => validateDomainApplyPreflight({ ...current, observedAt: plan.plannedAt }, plan, new Date("2026-08-21T07:32:30.000Z"))).toThrow(/after planning/u);
    expect(() => validateDomainApplyPreflight({ ...current, unrelatedRecords: [] }, plan, new Date("2026-08-21T07:32:30.000Z"))).toThrow(/changed/u);
    const editedPlan = structuredClone(plan);
    editedPlan.desiredRecord.proxied = true;
    expect(() => validateDomainApplyPreflight(current, editedPlan, new Date("2026-08-21T07:32:30.000Z"))).toThrow(/canonical policy/u);
  });

  it("covers update planning, PATCH identity, DNS proof, and exact rollback", () => {
    const input = liveInput();
    input.cloudflare.targetRecords = [{
      id: "c".repeat(32),
      type: "CNAME",
      name: "web-template.yutodev.com",
      content: "old.example.com",
      proxied: false,
      ttl: 300,
      modifiedOn: "2026-08-20T07:00:00.000Z",
    }];
    const plan = planFrom(input);
    expect(plan.action).toBe("update");
    expect(plan.rollback.priorTargetRecords).toEqual(input.cloudflare.targetRecords);
    expect(validateDomainApplyPreflight(currentSnapshot(plan), plan, new Date("2026-08-21T07:32:30.000Z"))).toMatchObject({
      request: {
        method: "PATCH",
        path: `/zones/${input.cloudflare.zoneId}/dns_records/${"c".repeat(32)}`,
      },
    });
    const after = changedSnapshot(plan);
    expect(verifyDnsChange(after, plan)).toMatchObject({ recordId: "c".repeat(32), proxied: false });
    expect(validateDomainRollbackPreflight(after, plan, new Date("2026-08-21T07:32:30.000Z"))).toEqual({
      ok: true,
      action: "restore-updated-record",
      request: {
        method: "PATCH",
        path: `/zones/${input.cloudflare.zoneId}/dns_records/${"c".repeat(32)}`,
        body: {
          type: "CNAME",
          name: "web-template.yutodev.com",
          content: "old.example.com",
          proxied: false,
          ttl: 300,
        },
      },
    });
    expect(() => validateDomainRollbackPreflight(after, plan, new Date("2026-08-21T07:35:00.000Z"))).toThrow(/stale/u);

    const withoutId = liveInput();
    withoutId.cloudflare.targetRecords = [{
      type: "CNAME", name: "web-template.yutodev.com", content: "old.example.com", proxied: false, ttl: 1,
    }];
    expect(() => planFrom(withoutId)).toThrow(/exact ID/u);
  });

  it("covers no-op planning and emits no apply or rollback mutation", () => {
    const input = liveInput();
    input.cloudflare.targetRecords = [{
      id: "c".repeat(32),
      type: "CNAME",
      name: "web-template.yutodev.com",
      content: "cname.vercel-dns.com",
      proxied: false,
      ttl: 1,
    }];
    const plan = planFrom(input);
    const current = currentSnapshot(plan);
    expect(plan.action).toBe("noop");
    expect(validateDomainApplyPreflight(current, plan, new Date("2026-08-21T07:32:30.000Z")).request).toBeNull();
    expect(validateDomainRollbackPreflight(current, plan, new Date("2026-08-21T07:32:30.000Z"))).toEqual({ ok: true, action: "noop", request: null });
  });

  it("proves target identity, preserves unrelated records, and fixes create rollback", () => {
    const plan = planFrom();
    const after = changedSnapshot(plan);
    const dns = verifyDnsChange(after, plan);
    expect(dns).toMatchObject({
      schemaVersion: 1,
      source: "cloudflare-live-verification",
      ok: true,
      hostname: "web-template.yutodev.com",
      recordId: "c".repeat(32),
      proxied: false,
      unrelatedRecordsUnchanged: true,
    });
    expect(validateDomainRollbackPreflight(after, plan, new Date("2026-08-21T07:32:30.000Z"))).toEqual({
      ok: true,
      action: "delete-created-record",
      request: {
        method: "DELETE",
        path: `/zones/${plan.cloudflare.zoneId}/dns_records/${"c".repeat(32)}`,
        body: null,
      },
    });
    expect(() => verifyDnsChange({ ...after, targetRecords: [] }, plan)).toThrow(/exactly one/u);
    expect(() => verifyDnsChange({ ...after, targetRecords: [...after.targetRecords, { ...after.targetRecords[0], id: "d".repeat(32) }] }, plan)).toThrow();
    expect(() => verifyDnsChange({ ...after, unrelatedRecords: [] }, plan)).toThrow(/unrelated/u);
    expect(() => verifyDnsChange({ ...after, targetRecords: [{ ...after.targetRecords[0], proxied: true }] }, plan)).toThrow(/proxied/u);
    expect(() => verifyDnsChange({ ...after, targetRecords: [{ ...after.targetRecords[0], content: "other.vercel-dns.com" }] }, plan)).toThrow(/content/u);
  });

  it("binds Vercel configuration, TLS, and smoke evidence to the exact DNS plan", () => {
    const plan = planFrom();
    const dns = verifyDnsChange(changedSnapshot(plan), plan);
    const evidence = {
      schemaVersion: 1,
      source: "live-dns-tls-http",
      hostname: "web-template.yutodev.com",
      planSha256: dns.planSha256,
      dnsRecordId: dns.recordId,
      vercelOwnershipVerified: true,
      vercelConfigurationStatus: "configured",
      tls: {
        valid: true,
        hostname: "web-template.yutodev.com",
        notAfter: "2026-11-19T00:00:00.000Z",
      },
      smoke: [
        { path: "/", status: 200, contains: "Start with the boundaries already drawn." },
        { path: "/health", status: 200, jsonStatus: "ok" },
      ],
      verifiedAt: "2026-08-21T07:33:00.000Z",
    };
    expect(verifyDomainRelease(evidence, plan, dns, new Date("2026-08-21T07:34:00.000Z"))).toMatchObject({
      ok: true,
      hostname: "web-template.yutodev.com",
      tls: "valid",
      smokeChecks: 2,
      planSha256: dns.planSha256,
    });
    expect(() => verifyDomainRelease({ ...evidence, smoke: evidence.smoke.slice(1) }, plan, dns, new Date("2026-08-21T07:34:00.000Z"))).toThrow(/coverage/u);
    expect(() => verifyDomainRelease({ ...evidence, planSha256: "f".repeat(64) }, plan, dns, new Date("2026-08-21T07:34:00.000Z"))).toThrow(/not bound/u);
    expect(() => verifyDomainRelease({ ...evidence, tls: { ...evidence.tls, notAfter: "2026-08-21T07:32:00.000Z" } }, plan, dns, new Date("2026-08-21T07:34:00.000Z"))).toThrow(/TLS/u);
    expect(() => verifyDomainRelease({ ...evidence, tls: { ...evidence.tls, hostname: "other.yutodev.com" } }, plan, dns, new Date("2026-08-21T07:34:00.000Z"))).toThrow(/TLS/u);
    expect(() => verifyDomainRelease(evidence, plan, dns, new Date("2026-08-21T07:50:00.000Z"))).toThrow(/time/u);
  });

  it("keeps transfer, nameserver replacement, bulk replacement, and proxy enablement forbidden", () => {
    expect(validateDomainPolicy()).toMatchObject({
      ok: true,
      dnsOnly: true,
      forbiddenOperations: [
        "domain.transfer",
        "nameserver.replace",
        "dns.bulk_replace",
        "cloudflare.proxy.enable",
      ],
    });
  });

  it("enforces the CLI root and artifact-output boundaries", () => {
    const lint = spawnSync(process.execPath, [workflowPath, "lint"], { cwd: repositoryRoot, encoding: "utf8" });
    expect(lint.status).toBe(0);
    const rootOverride = spawnSync(process.execPath, [workflowPath, "lint", "--root", "."], { cwd: repositoryRoot, encoding: "utf8" });
    expect(rootOverride.status).not.toBe(0);
    expect(rootOverride.stderr).toMatch(/--root is not permitted/u);
    const outsideOutput = spawnSync(process.execPath, [workflowPath, "lint", "--output", "domain-evidence.json"], { cwd: repositoryRoot, encoding: "utf8" });
    expect(outsideOutput.status).not.toBe(0);
    expect(outsideOutput.stderr).toMatch(/\.artifacts/u);
    const malformed = spawnSync(process.execPath, [workflowPath, "lint", "--output"], { cwd: repositoryRoot, encoding: "utf8" });
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toMatch(/Expected --name value options/u);
  });
});
