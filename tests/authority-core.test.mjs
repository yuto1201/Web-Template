import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorityDigest,
  authorizeServiceUse,
  evaluateAccountObservation,
  parseAuthority,
  readAuthority,
} from "../tools/authority-core.mjs";

const root = process.cwd();
const canonicalAuthority = JSON.parse(readFileSync(path.join(root, "config", "ownership.json"), "utf8"));

/** @template T @param {T} value @returns {T} */
function copy(value) {
  return /** @type {T} */ (JSON.parse(JSON.stringify(value)));
}

/** @param {string} value */
function fingerprint(value) {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
}

/** @param {Record<string, any>} [overrides] @returns {Record<string, any>} */
function githubObservation(overrides = {}) {
  return {
    service: "github",
    account: { ...canonicalAuthority.accounts.github, ...canonicalAuthority.observations.github, ...overrides },
    target: { ...canonicalAuthority.resourceTargets.github },
  };
}

/** @param {Record<string, any>} [overrides] @returns {Record<string, any>} */
function vercelObservation(overrides = {}) {
  return {
    service: "vercel",
    account: { ...canonicalAuthority.accounts.vercel, plan: canonicalAuthority.accounts.vercel.requiredPlan, ...overrides },
    target: { ...canonicalAuthority.resourceTargets.vercel },
  };
}

/** @param {Record<string, any>} [overrides] @returns {Record<string, any>} */
function cloudflareObservation(overrides = {}) {
  return {
    service: "cloudflare",
    account: {
      accountName: canonicalAuthority.accounts.cloudflare.accountName,
      accountId: canonicalAuthority.accounts.cloudflare.accountId,
      loginEmailSha256: canonicalAuthority.accounts.cloudflare.loginEmailSha256,
      role: canonicalAuthority.accounts.cloudflare.requiredRole,
      ...overrides,
    },
    target: { ...canonicalAuthority.resourceTargets.cloudflare, zonePlan: "Free" },
  };
}

/** @param {Record<string, any>} authority @param {Record<string, any>} [overrides] @returns {Record<string, any>} */
function linearObservation(authority, overrides = {}) {
  return {
    service: "linear",
    account: {
      workspaceName: authority.accounts.linear.workspaceName,
      workspaceSlug: authority.accounts.linear.workspaceSlug,
      workspaceUrl: authority.accounts.linear.workspaceUrl,
      workspaceId: authority.accounts.linear.workspaceId,
      userName: authority.accounts.linear.userName,
      userEmailSha256: authority.accounts.linear.userEmailSha256,
      userId: authority.accounts.linear.userId,
      role: authority.accounts.linear.requiredRole,
      ...overrides,
    },
    target: { ...authority.resourceTargets.linear },
  };
}

describe("canonical account authority", () => {
  it("parses the configured equal operator labels and produces a stable digest", () => {
    expect(parseAuthority(canonicalAuthority).authorization.operatorLabels).toEqual(["codex", "claude"]);
    expect(authorityDigest(canonicalAuthority)).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const reordered = {
      observations: canonicalAuthority.observations,
      resourceTargets: canonicalAuthority.resourceTargets,
      servicePolicies: canonicalAuthority.servicePolicies,
      accounts: canonicalAuthority.accounts,
      authorization: canonicalAuthority.authorization,
      schemaVersion: canonicalAuthority.schemaVersion,
    };
    expect(authorityDigest(reordered)).toBe(authorityDigest(canonicalAuthority));
  });

  it("reads and validates the repository authority", () => {
    expect(readAuthority(root)).toEqual(parseAuthority(canonicalAuthority));
  });

  it("rejects duplicate operator labels and automatic account switching", () => {
    const duplicateLabels = copy(canonicalAuthority);
    duplicateLabels.authorization.operatorLabels = ["codex", "codex"];
    expect(() => parseAuthority(duplicateLabels)).toThrow(/operator labels.*unique|duplicate/i);

    const automaticSwitching = copy(canonicalAuthority);
    automaticSwitching.authorization.allowAutomaticAccountSwitch = true;
    expect(() => parseAuthority(automaticSwitching)).toThrow(/automatic account switch/i);
  });

  it("rejects malformed email fingerprints and missing stable repository-active identities", () => {
    const malformedFingerprint = copy(canonicalAuthority);
    malformedFingerprint.accounts.cloudflare.loginEmailSha256 = "not-a-sha256";
    expect(() => parseAuthority(malformedFingerprint)).toThrow(/sha-256|invalid string/i);

    const missingStableIdentity = copy(canonicalAuthority);
    missingStableIdentity.accounts.github.nodeId = null;
    expect(() => parseAuthority(missingStableIdentity)).toThrow(/stable|invalid input/i);
  });

  it("rejects a GitHub account identity mismatch", () => {
    const authority = parseAuthority(canonicalAuthority);
    expect(() => evaluateAccountObservation(authority, {
      service: "github",
      account: { login: "company-user", userId: 1, nodeId: "wrong" },
      target: { repositoryId: 1340840341, repositoryNodeId: "R_kgDOT-uZlQ" },
    })).toThrow(/account identity/u);
  });

  it("reports GitHub audit-context drift as warnings without rejecting the stable identity", () => {
    const authority = parseAuthority(canonicalAuthority);
    const result = evaluateAccountObservation(authority, githubObservation({ publicRepositories: 10 }));

    expect(result).toMatchObject({ ok: true });
    expect(result.targetRef).toEqual(expect.any(String));
    expect(result.warnings).toContainEqual(expect.stringMatching(/public repository count/u));
  });

  it("merges unique GitHub warnings from previous and current observations deterministically", () => {
    const authority = parseAuthority(canonicalAuthority);
    const observation = githubObservation({ publicRepositories: 10 });
    observation.previousAccount = githubObservation({ displayName: "Previous display name", publicRepositories: 10 }).account;
    observation.previousTarget = { ...canonicalAuthority.resourceTargets.github };

    expect(evaluateAccountObservation(authority, observation).warnings).toEqual([
      "GitHub display name differs from the configured observation.",
      "GitHub public repository count differs from the configured observation.",
    ]);
  });

  it("rejects Cloudflare role and zone plan mismatches", () => {
    const authority = parseAuthority(canonicalAuthority);
    expect(() => evaluateAccountObservation(authority, cloudflareObservation({ role: "Administrator" }))).toThrow(/role/u);

    const wrongPlan = cloudflareObservation();
    wrongPlan.target.zonePlan = "Pro";
    expect(() => evaluateAccountObservation(authority, wrongPlan)).toThrow(/zone plan/u);
  });

  it("rejects contradictory Cloudflare raw email and supplied fingerprint", () => {
    const configured = copy(canonicalAuthority);
    configured.accounts.cloudflare.loginEmailSha256 = fingerprint("expected@example.test");
    const authority = parseAuthority(configured);

    expect(() => evaluateAccountObservation(authority, cloudflareObservation({
      loginEmail: "contradictory@example.test",
      loginEmailSha256: configured.accounts.cloudflare.loginEmailSha256,
    }))).toThrow(/email fingerprint/u);
  });

  it("rejects contradictory Linear raw email and supplied fingerprint", () => {
    const configured = copy(canonicalAuthority);
    configured.accounts.linear.workspaceId = "workspace_123";
    configured.accounts.linear.userId = "user_123";
    configured.resourceTargets.linear.teamId = "team_123";
    configured.accounts.linear.userEmailSha256 = fingerprint("expected@example.test");
    const authority = parseAuthority(configured);

    expect(() => evaluateAccountObservation(authority, linearObservation(configured, {
      userEmail: "contradictory@example.test",
      userEmailSha256: configured.accounts.linear.userEmailSha256,
    }))).toThrow(/email fingerprint/u);
  });

  it("rejects Vercel team and plan mismatches", () => {
    const authority = parseAuthority(canonicalAuthority);
    expect(() => evaluateAccountObservation(authority, vercelObservation({ teamId: "team_other" }))).toThrow(/account identity/u);
    expect(() => evaluateAccountObservation(authority, vercelObservation({ plan: "Pro" }))).toThrow(/plan/u);
  });

  it("rejects observations that switch account or target between preflight and result", () => {
    const authority = parseAuthority(canonicalAuthority);
    const switched = githubObservation();
    switched.previousAccount = { ...githubObservation().account, login: "company-user" };
    switched.previousTarget = { ...canonicalAuthority.resourceTargets.github };

    expect(() => evaluateAccountObservation(authority, switched)).toThrow(/account switch/u);
  });

  it("rejects a target-only switch between preflight and result", () => {
    const authority = parseAuthority(canonicalAuthority);
    const switched = githubObservation();
    switched.previousAccount = githubObservation().account;
    switched.previousTarget = { ...canonicalAuthority.resourceTargets.github, repositoryId: 1340840342 };

    expect(() => evaluateAccountObservation(authority, switched)).toThrow(/target switch/u);
  });

  it("requires an explicit single-line purpose and stable Linear IDs", () => {
    const authority = parseAuthority(canonicalAuthority);
    const input = {
      service: "linear",
      operation: "linear.read_issue",
      purposeCode: "issue-contract",
      explicitUserPurpose: null,
    };
    expect(() => authorizeServiceUse(authority, input)).toThrow(/user-directed|explicit user purpose/u);

    expect(() => authorizeServiceUse(authority, {
      ...input,
      purposeCode: "user-directed",
      explicitUserPurpose: "Read the Issue contract",
    })).toThrow(/stable.*id|identity|target/i);
  });

  it("keeps Linear denied for repository purposes and requires user-directed purpose even after stable IDs are recorded", () => {
    const configured = copy(canonicalAuthority);
    configured.accounts.linear.workspaceId = "workspace_123";
    configured.accounts.linear.userId = "user_123";
    configured.resourceTargets.linear.teamId = "team_123";
    const authority = parseAuthority(configured);

    expect(() => authorizeServiceUse(authority, {
      service: "linear",
      operation: "linear.read_issue",
      purposeCode: "issue-contract",
      explicitUserPurpose: "Read the Issue contract",
    })).toThrow(/user-directed|unsupported Linear operation/iu);

    expect(() => authorizeServiceUse(authority, {
      service: "linear",
      operation: "linear.read_issue",
      purposeCode: "user-directed",
      explicitUserPurpose: "Read the user-requested Linear issue",
    })).toThrow(/unsupported Linear operation/iu);
  });
});
