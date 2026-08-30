import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readAuthority } from "./authority-core.mjs";
import { providerPlaceholders } from "./template-core.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDirectory, "..");
const hostnameSchema = z.string().min(1).max(253).regex(/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/u);
const idSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const pathSchema = z.string().min(1).max(128).regex(/^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]+\/?)*$/u);

const domainConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  hostname: hostnameSchema,
  zoneName: hostnameSchema,
  recordName: z.string().min(1).max(63).regex(/^[a-z0-9-]+$/u),
  allowedRecordTypes: z.array(z.enum(["A", "CNAME"])).min(1).max(2),
  requiredProxied: z.literal(false),
  defaultTtl: z.number().int().min(1).max(86_400),
  forbiddenOperations: z.array(z.enum([
    "domain.transfer",
    "nameserver.replace",
    "dns.bulk_replace",
    "cloudflare.proxy.enable",
  ])).length(4),
  smokeChecks: z.array(z.object({
    path: pathSchema,
    status: z.number().int().min(100).max(599),
    contains: z.string().min(1).max(256).optional(),
    jsonStatus: z.string().min(1).max(64).optional(),
  }).strict()).min(1).max(8),
}).strict().superRefine((value, context) => {
  if (value.hostname !== `${value.recordName}.${value.zoneName}`) {
    context.addIssue({ code: "custom", message: "Hostname must equal recordName.zoneName." });
  }
  if (new Set(value.forbiddenOperations).size !== 4) {
    context.addIssue({ code: "custom", message: "Forbidden operations must be unique." });
  }
  const paths = value.smokeChecks.map((check) => check.path);
  if (new Set(paths).size !== paths.length) context.addIssue({ code: "custom", message: "Smoke paths must be unique." });
});

/** @param {string} name @param {any} schema @returns {any} */
function readCanonicalConfiguration(name, schema) {
  try {
    return schema.parse(JSON.parse(readFileSync(path.join(repositoryRoot, "config", name), "utf8")));
  } catch (error) {
    throw new Error(`Invalid canonical configuration: ${name}.`, { cause: error });
  }
}

const domainConfiguration = readCanonicalConfiguration("domain.json", domainConfigurationSchema);
const authority = readAuthority(repositoryRoot);

const targetRecordSchema = z.object({
  id: idSchema.optional(),
  type: z.enum(["A", "CNAME"]),
  name: hostnameSchema,
  content: z.string().min(1).max(253),
  proxied: z.boolean(),
  ttl: z.number().int().min(1).max(86_400),
  modifiedOn: timestampSchema.optional(),
}).strict().superRefine((value, context) => {
  const content = value.content.replace(/\.$/u, "");
  if (value.type === "A" && isIP(content) !== 4) {
    context.addIssue({ code: "custom", message: "A record content must be an IPv4 address." });
  }
  if (value.type === "CNAME" && !hostnameSchema.safeParse(content).success) {
    context.addIssue({ code: "custom", message: "CNAME content must be a hostname." });
  }
});
const unrelatedRecordIdentitySchema = z.object({
  id: idSchema,
  type: z.string().min(1).max(16),
  name: z.string().min(1).max(253),
  modifiedOn: timestampSchema,
}).strict();
const cloudflareSnapshotSchema = z.object({
  observedAt: timestampSchema,
  accountId: idSchema,
  accountName: z.string().min(1),
  zoneId: idSchema,
  zoneName: hostnameSchema,
  zoneStatus: z.literal("active"),
  caaStatus: z.enum(["absent", "allows-vercel"]),
  targetRecords: z.array(targetRecordSchema).max(1),
  unrelatedRecords: z.array(unrelatedRecordIdentitySchema).max(10_000),
}).strict();
const vercelObservationSchema = z.object({
  source: z.literal("vercel-api"),
  observedAt: timestampSchema,
  teamId: z.string().regex(/^team_[A-Za-z0-9]+$/u),
  projectId: z.string().regex(/^prj_[A-Za-z0-9]+$/u),
  hostname: hostnameSchema,
  ownershipVerified: z.literal(true),
  configurationStatus: z.enum(["pending", "configured"]),
  routing: z.object({ type: z.enum(["A", "CNAME"]), target: z.string().min(1).max(253) }).strict(),
}).strict();
const liveInputSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("codex-live-inspection"),
  cloudflare: cloudflareSnapshotSchema,
  vercel: vercelObservationSchema,
}).strict();

const planSchema = z.object({
  schemaVersion: z.literal(1),
  hostname: hostnameSchema,
  cloudflare: cloudflareSnapshotSchema,
  vercel: vercelObservationSchema,
  plannedAt: timestampSchema,
  action: z.enum(["create", "update", "noop"]),
  desiredRecord: targetRecordSchema,
  rollback: z.object({ priorTargetRecords: z.array(targetRecordSchema).max(1) }).strict(),
  forbiddenOperations: domainConfigurationSchema.shape.forbiddenOperations,
}).strict();

const dnsVerificationSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("cloudflare-live-verification"),
  ok: z.literal(true),
  hostname: hostnameSchema,
  planSha256: sha256Schema,
  recordId: idSchema,
  proxied: z.literal(false),
  unrelatedRecordsUnchanged: z.literal(true),
  observedAt: timestampSchema,
}).strict();

const releaseEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("live-dns-tls-http"),
  hostname: hostnameSchema,
  planSha256: sha256Schema,
  dnsRecordId: idSchema,
  vercelOwnershipVerified: z.literal(true),
  vercelConfigurationStatus: z.literal("configured"),
  tls: z.object({
    valid: z.literal(true),
    hostname: hostnameSchema,
    notAfter: timestampSchema,
  }).strict(),
  smoke: z.array(z.object({
    path: pathSchema,
    status: z.number().int(),
    contains: z.string().optional(),
    jsonStatus: z.string().optional(),
  }).strict()).min(1).max(8),
  verifiedAt: timestampSchema,
}).strict();

/** @param {unknown} value */
function canonical(value) {
  return JSON.stringify(value);
}

/** @param {z.infer<typeof cloudflareSnapshotSchema>} snapshot */
function normalizeSnapshot(snapshot) {
  return {
    ...snapshot,
    unrelatedRecords: [...snapshot.unrelatedRecords].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/** @param {z.infer<typeof cloudflareSnapshotSchema>} snapshot */
function snapshotState(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  return {
    accountId: normalized.accountId,
    accountName: normalized.accountName,
    zoneId: normalized.zoneId,
    zoneName: normalized.zoneName,
    zoneStatus: normalized.zoneStatus,
    caaStatus: normalized.caaStatus,
    targetRecords: normalized.targetRecords,
    unrelatedRecords: normalized.unrelatedRecords,
  };
}

/** @param {z.infer<typeof cloudflareSnapshotSchema>} snapshot */
function validateSnapshotClassification(snapshot) {
  if (snapshot.targetRecords.some((record) => record.name !== domainConfiguration.hostname)) {
    throw new Error("[classification] A target record does not match the canonical hostname.");
  }
  if (snapshot.unrelatedRecords.some((record) => record.name.replace(/\.$/u, "").toLowerCase() === domainConfiguration.hostname)) {
    throw new Error("[classification] The canonical hostname was classified as unrelated.");
  }
  const ids = [...snapshot.targetRecords, ...snapshot.unrelatedRecords]
    .map((record) => record.id)
    .filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error("[classification] DNS record identities must be unique.");
}

/** @param {string} label @param {string} observedAt @param {Date} now @param {number} maxAgeMs @param {string} [after] */
function validateObservationTime(label, observedAt, now, maxAgeMs, after) {
  const nowTime = now.getTime();
  const observedTime = Date.parse(observedAt);
  if (!Number.isFinite(nowTime) || !Number.isFinite(observedTime) || observedTime > nowTime || nowTime - observedTime > maxAgeMs) {
    throw new Error(`[${label}] Observation is stale or from the future.`);
  }
  if (after && observedTime <= Date.parse(after)) {
    throw new Error(`[${label}] Observation was not taken after planning.`);
  }
}

/** @param {z.infer<typeof planSchema>} plan */
function planSha256(plan) {
  return createHash("sha256").update(canonical(plan)).digest("hex");
}

/** @param {z.infer<typeof targetRecordSchema>} record */
function recordBody(record) {
  return { type: record.type, name: record.name, content: record.content, proxied: record.proxied, ttl: record.ttl };
}

function requireActiveProviderAuthority() {
  if (
    authority.accounts.vercel.teamId === providerPlaceholders.vercelScope ||
    authority.resourceTargets.vercel.projectId === providerPlaceholders.vercelProjectId ||
    authority.accounts.cloudflare.accountId === providerPlaceholders.cloudflareAccountId ||
    authority.accounts.cloudflare.accountName === providerPlaceholders.cloudflareAccountName ||
    authority.resourceTargets.cloudflare.zoneId === providerPlaceholders.cloudflareZoneId
  ) throw new Error("[ownership] Canonical provider authority is inactive.");
}

/** @param {z.infer<typeof planSchema>} plan */
function validatePlanIntegrity(plan) {
  requireActiveProviderAuthority();
  validateSnapshotClassification(plan.cloudflare);
  if (
    plan.hostname !== domainConfiguration.hostname ||
    plan.cloudflare.accountId !== authority.accounts.cloudflare.accountId ||
    plan.cloudflare.accountName !== authority.accounts.cloudflare.accountName ||
    plan.cloudflare.zoneId !== authority.resourceTargets.cloudflare.zoneId ||
    plan.cloudflare.zoneName !== domainConfiguration.zoneName ||
    plan.vercel.teamId !== authority.accounts.vercel.teamId ||
    plan.vercel.projectId !== authority.resourceTargets.vercel.projectId ||
    plan.vercel.hostname !== domainConfiguration.hostname ||
    !authority.resourceTargets.cloudflare.domains.includes(plan.hostname)
  ) throw new Error("[plan-integrity] Provider ownership does not match canonical configuration.");
  if (!domainConfiguration.allowedRecordTypes.includes(plan.vercel.routing.type)) {
    throw new Error("[plan-integrity] Routing type is outside the canonical allowlist.");
  }
  if (plan.vercel.routing.type === "CNAME" && !/^(?:[a-z0-9-]+\.)*vercel-dns(?:-[0-9]+)?\.com\.?$/u.test(plan.vercel.routing.target)) {
    throw new Error("[plan-integrity] Vercel CNAME target has an unexpected shape.");
  }
  if (plan.vercel.routing.type === "A" && isIP(plan.vercel.routing.target) !== 4) {
    throw new Error("[plan-integrity] Vercel A target is not an IPv4 address.");
  }
  const expectedDesired = {
    type: plan.vercel.routing.type,
    name: domainConfiguration.hostname,
    content: plan.vercel.routing.target.replace(/\.$/u, ""),
    proxied: domainConfiguration.requiredProxied,
    ttl: domainConfiguration.defaultTtl,
  };
  if (canonical(plan.desiredRecord) !== canonical(expectedDesired)) {
    throw new Error("[plan-integrity] Desired DNS record was not derived from canonical policy.");
  }
  const prior = plan.cloudflare.targetRecords[0];
  if (prior && (!prior.id || prior.proxied)) throw new Error("[plan-integrity] Prior record is not safe for this workflow.");
  const expectedAction = prior
    ? canonical(recordBody(prior)) === canonical(expectedDesired) ? "noop" : "update"
    : "create";
  if (plan.action !== expectedAction || canonical(plan.rollback.priorTargetRecords) !== canonical(plan.cloudflare.targetRecords)) {
    throw new Error("[plan-integrity] Action or rollback state was edited after planning.");
  }
  if (canonical(plan.forbiddenOperations) !== canonical(domainConfiguration.forbiddenOperations)) {
    throw new Error("[plan-integrity] Forbidden operations were edited after planning.");
  }
}

/** @param {unknown} value @param {Date} [now] */
export function createDomainPlan(value, now = new Date()) {
  const input = liveInputSchema.parse(value);
  requireActiveProviderAuthority();
  validateObservationTime("cloudflare-observation", input.cloudflare.observedAt, now, 300_000);
  validateObservationTime("vercel-observation", input.vercel.observedAt, now, 300_000);
  validateSnapshotClassification(input.cloudflare);
  if (
    input.cloudflare.accountId !== authority.accounts.cloudflare.accountId ||
    input.cloudflare.accountName !== authority.accounts.cloudflare.accountName ||
    input.cloudflare.zoneId !== authority.resourceTargets.cloudflare.zoneId ||
    input.cloudflare.zoneName !== domainConfiguration.zoneName
  ) throw new Error("[ownership] Cloudflare account or zone does not match canonical ownership.");
  if (
    input.vercel.teamId !== authority.accounts.vercel.teamId ||
    input.vercel.projectId !== authority.resourceTargets.vercel.projectId ||
    input.vercel.hostname !== domainConfiguration.hostname ||
    !authority.resourceTargets.cloudflare.domains.includes(input.vercel.hostname)
  ) throw new Error("[ownership] Vercel project or domain does not match canonical ownership.");
  if (!domainConfiguration.allowedRecordTypes.includes(input.vercel.routing.type)) {
    throw new Error("[vercel-routing] Vercel returned a record type outside the reviewed allowlist.");
  }
  if (input.vercel.routing.type === "CNAME" && !/^(?:[a-z0-9-]+\.)*vercel-dns(?:-[0-9]+)?\.com\.?$/u.test(input.vercel.routing.target)) {
    throw new Error("[vercel-routing] Vercel CNAME target has an unexpected shape.");
  }
  if (input.vercel.routing.type === "A" && isIP(input.vercel.routing.target) !== 4) {
    throw new Error("[vercel-routing] Vercel A target is not an IPv4 address.");
  }
  const desiredRecord = {
    type: input.vercel.routing.type,
    name: input.vercel.hostname,
    content: input.vercel.routing.target.replace(/\.$/u, ""),
    proxied: false,
    ttl: domainConfiguration.defaultTtl,
  };
  const cloudflare = normalizeSnapshot(input.cloudflare);
  const prior = cloudflare.targetRecords[0];
  if (prior && !prior.id) throw new Error("[plan] An existing target record requires its exact ID.");
  if (prior?.proxied) throw new Error("[plan] An existing proxied record requires separate approval.");
  const same = prior && canonical(recordBody(prior)) === canonical(desiredRecord);
  const plan = planSchema.parse({
    schemaVersion: 1,
    hostname: domainConfiguration.hostname,
    cloudflare,
    vercel: input.vercel,
    plannedAt: now.toISOString(),
    action: same ? "noop" : prior ? "update" : "create",
    desiredRecord,
    rollback: { priorTargetRecords: cloudflare.targetRecords },
    forbiddenOperations: domainConfiguration.forbiddenOperations,
  });
  validatePlanIntegrity(plan);
  return plan;
}

/** @param {unknown} currentValue @param {unknown} planValue @param {Date} [now] */
export function validateDomainApplyPreflight(currentValue, planValue, now = new Date()) {
  const current = normalizeSnapshot(cloudflareSnapshotSchema.parse(currentValue));
  const plan = planSchema.parse(planValue);
  validatePlanIntegrity(plan);
  validateSnapshotClassification(current);
  const age = now.getTime() - Date.parse(plan.plannedAt);
  if (!Number.isFinite(now.getTime()) || age < 0 || age > 600_000) {
    throw new Error("[apply-preflight] Domain plan is stale or dated in the future.");
  }
  validateObservationTime("apply-preflight", current.observedAt, now, 120_000, plan.plannedAt);
  if (canonical(snapshotState(current)) !== canonical(snapshotState(plan.cloudflare))) {
    throw new Error("[apply-preflight] Cloudflare state changed after planning.");
  }
  const recordId = plan.action === "update" ? plan.cloudflare.targetRecords[0]?.id : null;
  if (plan.action === "update" && !recordId) throw new Error("[apply-preflight] Update requires the exact existing record ID.");
  const request = plan.action === "noop" ? null : {
    method: plan.action === "create" ? "POST" : "PATCH",
    path: plan.action === "create"
      ? `/zones/${current.zoneId}/dns_records`
      : `/zones/${current.zoneId}/dns_records/${recordId}`,
    body: recordBody(plan.desiredRecord),
  };
  return { ok: true, action: plan.action, zoneId: current.zoneId, recordId, desiredRecord: plan.desiredRecord, request };
}

/** @param {unknown} afterValue @param {unknown} planValue */
export function verifyDnsChange(afterValue, planValue) {
  const after = normalizeSnapshot(cloudflareSnapshotSchema.parse(afterValue));
  const plan = planSchema.parse(planValue);
  validatePlanIntegrity(plan);
  validateSnapshotClassification(after);
  if (Date.parse(after.observedAt) <= Date.parse(plan.plannedAt)) throw new Error("[dns-after] Snapshot predates the plan.");
  if (after.accountId !== plan.cloudflare.accountId || after.zoneId !== plan.cloudflare.zoneId) {
    throw new Error("[dns-after] Account or zone changed during verification.");
  }
  if (canonical(after.unrelatedRecords) !== canonical(normalizeSnapshot(plan.cloudflare).unrelatedRecords)) {
    throw new Error("[dns-after] An unrelated DNS record changed.");
  }
  if (after.targetRecords.length !== 1) throw new Error("[dns-after] Expected exactly one target record.");
  const actual = after.targetRecords[0];
  if (!actual.id) throw new Error("[dns-after] The target record must have a live Cloudflare ID.");
  if (plan.action === "update" && actual.id !== plan.cloudflare.targetRecords[0]?.id) {
    throw new Error("[dns-after] The updated record ID changed.");
  }
  const comparableKeys = /** @type {const} */ (["type", "name", "content", "proxied", "ttl"]);
  for (const key of comparableKeys) {
    if (actual[key] !== plan.desiredRecord[key]) throw new Error(`[dns-after] Target record ${key} mismatch.`);
  }
  return dnsVerificationSchema.parse({
    schemaVersion: 1,
    source: "cloudflare-live-verification",
    ok: true,
    hostname: plan.hostname,
    planSha256: planSha256(plan),
    recordId: actual.id,
    proxied: actual.proxied,
    unrelatedRecordsUnchanged: true,
    observedAt: after.observedAt,
  });
}

/** @param {unknown} currentValue @param {unknown} planValue @param {Date} [now] */
export function validateDomainRollbackPreflight(currentValue, planValue, now = new Date()) {
  const current = normalizeSnapshot(cloudflareSnapshotSchema.parse(currentValue));
  const plan = planSchema.parse(planValue);
  validatePlanIntegrity(plan);
  validateObservationTime("rollback-preflight", current.observedAt, now, 120_000, plan.plannedAt);
  const verified = verifyDnsChange(current, plan);
  if (plan.action === "noop") return { ok: true, action: "noop", request: null };
  if (plan.action === "create") {
    return {
      ok: true,
      action: "delete-created-record",
      request: { method: "DELETE", path: `/zones/${current.zoneId}/dns_records/${verified.recordId}`, body: null },
    };
  }
  const prior = plan.rollback.priorTargetRecords[0];
  if (!prior?.id || prior.id !== verified.recordId) throw new Error("[rollback-preflight] Prior record identity mismatch.");
  return {
    ok: true,
    action: "restore-updated-record",
    request: {
      method: "PATCH",
      path: `/zones/${current.zoneId}/dns_records/${prior.id}`,
      body: recordBody(prior),
    },
  };
}

/** @param {unknown} value @param {unknown} planValue @param {unknown} dnsValue @param {Date} [now] */
export function verifyDomainRelease(value, planValue, dnsValue, now = new Date()) {
  const evidence = releaseEvidenceSchema.parse(value);
  const plan = planSchema.parse(planValue);
  const dns = dnsVerificationSchema.parse(dnsValue);
  validatePlanIntegrity(plan);
  const digest = planSha256(plan);
  if (evidence.hostname !== domainConfiguration.hostname || dns.hostname !== evidence.hostname) {
    throw new Error("[domain-release] Hostname mismatch.");
  }
  if (evidence.planSha256 !== digest || dns.planSha256 !== digest || evidence.dnsRecordId !== dns.recordId) {
    throw new Error("[domain-release] DNS evidence is not bound to this plan.");
  }
  const verifiedAt = Date.parse(evidence.verifiedAt);
  if (!Number.isFinite(now.getTime()) || verifiedAt < Date.parse(dns.observedAt) || verifiedAt > now.getTime() || now.getTime() - verifiedAt > 600_000) {
    throw new Error("[domain-release] Verification time is invalid.");
  }
  if (evidence.tls.hostname !== evidence.hostname || Date.parse(evidence.tls.notAfter) <= verifiedAt) {
    throw new Error("[domain-release] TLS evidence is expired or for another hostname.");
  }
  if (evidence.smoke.length !== domainConfiguration.smokeChecks.length) throw new Error("[domain-release] Smoke coverage mismatch.");
  for (const expected of domainConfiguration.smokeChecks) {
    const matches = evidence.smoke.filter((item) => item.path === expected.path);
    if (matches.length !== 1) throw new Error(`[domain-release] Expected exactly one ${expected.path} check.`);
    const actual = matches[0];
    if (actual.status !== expected.status || (expected.contains && actual.contains !== expected.contains) ||
      (expected.jsonStatus && actual.jsonStatus !== expected.jsonStatus)) {
      throw new Error(`[domain-release] ${expected.path} failed.`);
    }
  }
  return { ok: true, hostname: evidence.hostname, tls: "valid", smokeChecks: evidence.smoke.length, planSha256: digest };
}

export function validateDomainPolicy() {
  if (!authority.resourceTargets.cloudflare.domains.includes(domainConfiguration.hostname) ||
    !domainConfiguration.hostname.endsWith(`.${domainConfiguration.zoneName}`)) {
    throw new Error("[domain-policy] Canonical ownership and domain configuration do not agree.");
  }
  return {
    ok: true,
    hostname: domainConfiguration.hostname,
    dnsOnly: domainConfiguration.requiredProxied === false,
    forbiddenOperations: domainConfiguration.forbiddenOperations,
  };
}

export const domainSchemas = {
  cloudflareSnapshotSchema,
  dnsVerificationSchema,
  liveInputSchema,
  planSchema,
  releaseEvidenceSchema,
};
