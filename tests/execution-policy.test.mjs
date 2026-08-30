import path from "node:path";
import { describe, expect, it } from "vitest";
import { operationNames as workflowOperationNames } from "../tools/workflow-core.mjs";
import {
  classifyRisk,
  executionOperationNames,
  loadExecutionPolicy,
  normalizeModelIdentity,
  operationModelFamily,
  requiredReviewerFamilies,
  validateBranchForSurface,
  validateReviewerFamilies,
} from "../tools/execution-policy.mjs";

const policy = await loadExecutionPolicy(path.resolve("."));

describe("execution policy", () => {
  it("maps every executable review family to operation evidence metadata", () => {
    expect(["openai", "anthropic", "cursor", "xai"].map(operationModelFamily)).toEqual(["gpt", "claude", "cursor", "xai"]);
    expect(operationModelFamily("unknown")).toBeNull();
  });
  it("keeps execution surface separate from observed model family", () => {
    expect(normalizeModelIdentity(
      "claude-opus-5[effort=high]",
      "claude-opus-5",
      [{ id: "effort", value: "high" }],
      policy,
    )).toEqual({
      configured: "claude-opus-5[effort=high]",
      observed: "claude-opus-5",
      family: "anthropic",
      fallback: false,
      parameters: [{ id: "effort", value: "high" }],
    });
    expect(normalizeModelIdentity(
      "gpt-5.6-sol[effort=high]",
      "claude-opus-5",
      [],
      policy,
    )).toMatchObject({ family: "anthropic", fallback: true });
    expect(normalizeModelIdentity("future-model", "future-model-v2", [], policy).family).toBe("unknown");
  });

  it("orders canonical parameter output by Unicode code point, not locale", () => {
    expect(normalizeModelIdentity(
      "claude-opus-5",
      "claude-opus-5",
      [{ id: "ordering", value: "💡" }, { id: "ordering", value: "a" }],
      policy,
    ).parameters).toEqual([
      { id: "ordering", value: "a" },
      { id: "ordering", value: "💡" },
    ]);
  });

  it("accepts only the issue branch owned by the selected surface", () => {
    expect(validateBranchForSurface("cursor/29-cloud-mode", 29, "cursor-cloud", policy)).toBe("cursor/29-cloud-mode");
    expect(() => validateBranchForSurface("codex/29-cloud-mode", 29, "cursor-cloud", policy)).toThrow(/surface/u);
    expect(() => validateBranchForSurface("cursor/30-cloud-mode", 29, "cursor-cloud", policy)).toThrow(/issue/u);
    expect(() => validateBranchForSurface("cursor/29-Cloud-mode", 29, "cursor-cloud", policy)).toThrow(/branch/u);
  });

  it("derives deterministic high risk from canonical paths and frozen operations", () => {
    expect(classifyRisk({ changedPaths: ["src/app/page.tsx"], externalOperations: ["github.push_branch"] }, policy)).toEqual({
      level: "normal",
      reasons: [],
    });
    expect(classifyRisk({ changedPaths: [".cursor/hooks.json"], externalOperations: [] }, policy)).toEqual({
      level: "high",
      reasons: ["path:.cursor/"],
    });
    expect(classifyRisk({ changedPaths: ["src/app/page.tsx"], externalOperations: ["cloudflare.upsert_dns"] }, policy)).toEqual({
      level: "high",
      reasons: ["operation:cloudflare.upsert_dns"],
    });
    expect(() => classifyRisk({ changedPaths: ["src/app/../proxy.ts"], externalOperations: [] }, policy)).toThrow(/canonical/u);
    expect(() => classifyRisk({ changedPaths: [], externalOperations: ["github.run_anything"] }, policy)).toThrow(/operation/u);
  });

  it.each([
    "docs/authority.md",
    "docs/security.md",
    "docs/workflow.md",
    "docs/activation.md",
    "docs/verification.md",
    "docs/onboarding-cursor-cloud.md",
    "specs/decisions.md",
    "specs/cursor-cloud.md",
  ])("classifies canonical authority path %s as high risk", (changedPath) => {
    expect(classifyRisk({ changedPaths: [changedPath], externalOperations: [] }, policy)).toEqual({
      level: "high",
      reasons: [`path:${changedPath}`],
    });
  });

  it("requires observed reviewer families that satisfy risk-specific diversity", () => {
    expect(requiredReviewerFamilies({ risk: "high", primaryFamily: "openai" })).toEqual(["anthropic", "openai"]);
    expect(requiredReviewerFamilies({ risk: "normal", primaryFamily: "anthropic" })).toEqual(["openai"]);
    expect(validateReviewerFamilies({
      risk: "high",
      primaryFamily: "cursor",
      reviewerFamilies: ["openai", "anthropic"],
    })).toEqual(["anthropic", "openai"]);
    expect(() => validateReviewerFamilies({
      risk: "normal",
      primaryFamily: "anthropic",
      reviewerFamilies: ["anthropic"],
    })).toThrow(/different/u);
    expect(() => validateReviewerFamilies({
      risk: "high",
      primaryFamily: "openai",
      reviewerFamilies: ["anthropic"],
    })).toThrow(/openai/u);
    expect(() => requiredReviewerFamilies({ risk: "normal", primaryFamily: "unknown" })).toThrow(/unknown/u);
  });

  it("keeps the temporary operation-name copy exactly aligned with workflow core", () => {
    expect(executionOperationNames).toEqual(workflowOperationNames);
  });
});
