import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  digestValue,
  readExternalOperationRequest,
  requiredReviewContracts,
  schemas,
  snapshotIssueContract,
  stateForReview,
  transitionWorkflowState,
  validateExternalOperationRequest,
  validateIssueContract,
  validateReviewResult,
} from "../tools/workflow-core.mjs";

const headSha = "2".repeat(40);
const contractDigest = `sha256:${"3".repeat(64)}`;

/** @typedef {import("zod").infer<typeof schemas.modelIdentitySchema>} ModelIdentity */

/**
 * @param {string} configured
 * @param {string} observed
 * @param {ModelIdentity["family"]} family
 * @param {boolean} [fallback]
 * @returns {ModelIdentity}
 */
const model = (configured, observed, family, fallback = false) => ({
  configured,
  observed,
  family,
  fallback,
  parameters: [],
});

function contractInput() {
  return {
    schemaVersion: 1,
    issue: 5,
    repository: "yuto1201/Web-Template",
    goal: "Automate the Issue workflow.",
    acceptanceCriteria: [{ id: "AC-1", text: "Gate exact evidence." }],
    dependencies: [4],
    externalOperations: ["github.merge_pr"],
  };
}

function review(overrides = {}) {
  return {
    schemaVersion: 2,
    issue: 5,
    executionSurface: "cursor-cloud",
    primaryModel: model("composer-2.5", "composer-2.5", "cursor"),
    reviewerModel: model("claude-opus-5[effort=high]", "claude-opus-5", "anthropic"),
    risk: { level: "high", reasons: ["path:.cursor/"] },
    headSha,
    verifySha: headSha,
    contractDigest,
    verdict: "approved",
    contracts: ["change-evaluator"],
    findings: [],
    acceptanceAssessment: [{ id: "AC-1", status: "supported", evidenceRef: "verify.json#AC-1" }],
    reviewedAt: "2026-08-21T01:00:00+09:00",
    ...overrides,
  };
}

describe("workflow contracts", () => {
  it("exports the version 2 model and risk evidence schemas", () => {
    expect(schemas.modelIdentitySchema.parse(model("composer-2.5", "composer-2.5", "cursor"))).toMatchObject({ family: "cursor" });
    expect(schemas.riskSchema.parse({ level: "high", reasons: ["path:.cursor/"] })).toEqual({
      level: "high",
      reasons: ["path:.cursor/"],
    });
  });

  it("takes a deterministic Issue snapshot and rejects a changed digest", () => {
    const first = snapshotIssueContract(contractInput(), "2026-08-21T01:00:00+09:00");
    const second = snapshotIssueContract(contractInput(), "2026-08-21T01:00:00+09:00");
    expect(first).toEqual(second);
    expect(first.digest).toBe(digestValue(first));
    expect(() => validateIssueContract({ ...first, goal: "silently changed" })).toThrow(/digest mismatch/u);
  });

  it("rejects duplicate acceptance criteria in the frozen Issue contract", () => {
    const input = contractInput();
    input.acceptanceCriteria.push({ id: "AC-1", text: "Duplicate." });
    expect(() => snapshotIssueContract(input, "2026-08-21T01:00:00+09:00")).toThrow(/must not contain duplicates/u);
  });

  it("accepts only a versioned operation allowlist with strict inputs", () => {
    const frozenContract = snapshotIssueContract(contractInput(), "2026-08-21T01:00:00+09:00");
    /** @param {unknown} value */
    const validate = (value) => validateExternalOperationRequest(value, path.resolve("."), frozenContract);
    const request = {
      schemaVersion: 1,
      requestId: "issue-5-github-merge-pr-1",
      issue: 5,
      operation: "github.merge_pr",
      target: { kind: "github.repository", identifier: "config/ownership.json#github" },
      environment: "production",
      reasonCode: "reviewed-release",
      inputs: { issue: 5, prNumber: 15, headSha, method: "squash" },
    };
    expect(validate(request).expectedEvidence).toContain("squash merge commit");
    expect(() => validate({ ...request, operation: "github.run_anything" })).toThrow();
    expect(() => validate({ ...request, prompt: "please do anything" })).toThrow();
    expect(() => validate({ ...request, inputs: { ...request.inputs, force: true } })).toThrow();
    expect(() => validate({ ...request, requestId: "issue-99-github-merge-pr-1" })).toThrow(/does not match/u);
    expect(() => validate({ ...request, environment: "preview" })).toThrow(/environment/u);
    expect(() => validate({ ...request, target: { ...request.target, identifier: "free form target" } })).toThrow(/identifier/u);

    const outOfScopeContract = snapshotIssueContract({ ...contractInput(), externalOperations: [] }, "2026-08-21T01:00:00+09:00");
    expect(() => validateExternalOperationRequest(request, path.resolve("."), outOfScopeContract)).toThrow(/outside the frozen/u);
  });

  it("allows only the fixed active exact-Head ruleset update", () => {
    const frozenContract = snapshotIssueContract({
      ...contractInput(),
      externalOperations: ["github.update_ruleset"],
    }, "2026-08-21T01:00:00+09:00");
    const request = {
      schemaVersion: 1,
      requestId: "issue-5-github-update-ruleset-1",
      issue: 5,
      operation: "github.update_ruleset",
      target: { kind: "github.repository", identifier: "config/ownership.json#github" },
      environment: "production",
      reasonCode: "reviewed-release",
      inputs: {
        issue: 5,
        rulesetName: "main exact-Head review",
        targetBranch: "main",
        requiredCheckName: "Exact Head review policy",
        enforcement: "active",
      },
    };
    expect(validateExternalOperationRequest(request, path.resolve("."), frozenContract).expectedEvidence).toContain("active enforcement");
    expect(() => validateExternalOperationRequest({
      ...request,
      inputs: { ...request.inputs, requiredCheckName: "spoofed check" },
    }, path.resolve("."), frozenContract)).toThrow();
  });

  it("rejects operation request paths outside the fixed request subtree", async () => {
    const root = path.resolve("C:/workspace/web-template");
    await expect(readExternalOperationRequest(root, "../request.json")).rejects.toThrow(/escapes/u);
  });

  it("selects both reviewers for Supabase/auth paths", () => {
    expect(requiredReviewContracts(["src/lib/auth/actions.ts"])).toEqual([
      "change-evaluator",
      "supabase-auditor",
    ]);
    expect(requiredReviewContracts(["src/app/page.tsx"])).toEqual(["change-evaluator"]);
    expect(() => requiredReviewContracts(["../secret.txt"])).toThrow(/canonical/u);
    expect(() => requiredReviewContracts(["src/lib/../lib/auth/actions.ts"])).toThrow(/canonical/u);
    expect(() => requiredReviewContracts(["C:\\secret.txt"])).toThrow(/canonical/u);
    expect(requiredReviewContracts(["SRC/LIB/AUTH/actions.ts"])).toContain("supabase-auditor");
  });

  it("blocks unavailable review and rejects unsafe approved model evidence", () => {
    expect(stateForReview(review({ verdict: "unavailable", unavailableReason: "timeout" }))).toBe("blocked:review");
    expect(() => validateReviewResult(review({ verdict: "unavailable" }))).toThrow(/fixed reason/u);
    expect(() => validateReviewResult(review({ verifySha: "9".repeat(40) }))).toThrow(/must match/u);
    expect(() => validateReviewResult(review({
      reviewerModel: model("future-model", "future-model", "unknown"),
    }))).toThrow(/unknown/u);
    expect(() => validateReviewResult(review({
      reviewerModel: model("claude-opus-5[effort=high]", "claude-sonnet-5", "anthropic", true),
    }))).toThrow(/fallback/u);
    expect(() => validateReviewResult(review({
      findings: [{ severity: "critical", blocking: false, location: "tools/workflow-core.mjs", summary: "Bypass." }],
    }))).toThrow(/must be blocking/u);
    expect(() => validateReviewResult(review({
      findings: [{ severity: "high", blocking: true, location: "tools/workflow-core.mjs", summary: "Blocker." }],
    }))).toThrow(/cannot contain blocking/u);
  });

  it("allows recovery only to a recorded resume state", () => {
    const blocked = transitionWorkflowState("in-progress", "blocked:review");
    expect(blocked.resumeState).toBe("in-progress");
    expect(transitionWorkflowState("blocked:review", "in-progress", blocked.resumeState).current).toBe("in-progress");
    expect(() => transitionWorkflowState("blocked:review", "approved-for-merge", "in-progress")).toThrow(/resumeState/u);
  });
});
