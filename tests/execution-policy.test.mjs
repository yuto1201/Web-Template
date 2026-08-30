import path from "node:path";
import { describe, expect, it } from "vitest";
import { operationNames as workflowOperationNames } from "../tools/workflow-core.mjs";
import * as executionPolicyModule from "../tools/execution-policy.mjs";
import {
  classifyRisk,
  executionOperationNames,
  loadExecutionPolicy,
  normalizeModelIdentity,
  operationModelFamily,
  parseProtectedExecutionPolicy,
  requiredReviewerFamilies,
  validateBranchForSurface,
  validateReviewerFamilies,
} from "../tools/execution-policy.mjs";

const policy = await loadExecutionPolicy(path.resolve("."));
const lowDoc = "docs/superpowers/plans/2026-08-22-cursor-cloud-development-mode.md";

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
    expect(() => classifyRisk({ changedPaths: ["src/app/page.tsx"], externalOperations: ["github.run_anything"] }, policy)).toThrow(/operation/u);
  });

  it("grants low risk only when every changed path is allowlisted and no external operation exists", () => {
    expect(classifyRisk({ changedPaths: [lowDoc], externalOperations: [] }, policy)).toEqual({
      level: "low",
      reasons: [`path:${lowDoc}`],
    });
    expect(classifyRisk({ changedPaths: ["README.md", "src/app/page.tsx"], externalOperations: [] }, policy)).toEqual({
      level: "normal",
      reasons: [],
    });
    expect(classifyRisk({ changedPaths: ["README.md"], externalOperations: ["github.push_branch"] }, policy)).toEqual({
      level: "normal",
      reasons: [],
    });
    expect(() => classifyRisk({ changedPaths: [], externalOperations: [] }, policy)).toThrow(/changed path/iu);
  });

  it("treats the pre-migration protected policy as never low risk", () => {
    const legacyPolicy = /** @type {Record<string, any>} */ (structuredClone(policy));
    delete legacyPolicy.lowRiskPathRules;
    delete legacyPolicy.verificationPathRules;
    const parsed = parseProtectedExecutionPolicy(legacyPolicy);
    expect(parsed.lowRiskPathRules).toEqual([]);
    expect(classifyRisk({ changedPaths: ["README.md"], externalOperations: [] }, parsed))
      .toEqual({ level: "normal", reasons: [] });
  });

  it("keeps normative specifications and new documentation out of the no-review tier", () => {
    for (const changedPath of ["specs/account-bound-authority.md", "specs/architecture.md", "specs/acceptance.md", "specs/risk-tiered-verification.md", "specs/new-security-contract.md"]) {
      expect(classifyRisk({ changedPaths: [changedPath], externalOperations: [] }, policy), changedPath)
        .toEqual({ level: "high", reasons: ["path:specs/"] });
    }
    for (const changedPath of ["README.md", "docs/new-guide.md", "docs/new-script.mjs"]) {
      expect(classifyRisk({ changedPaths: [changedPath], externalOperations: [] }, policy), changedPath)
        .toEqual({ level: "normal", reasons: [] });
    }
  });

  it.each(["package.json", "package-lock.json"])("runs database/Auth integration when %s can change Supabase dependencies", (changedPath) => {
    expect(executionPolicyModule.deriveVerificationPlan({ changedPaths: [changedPath], externalOperations: [] }, policy))
      .toMatchObject({ databaseAuth: true });
  });

  it.each([
    ["docs/authority.md", "docs/authority.md"],
    ["docs/security.md", "docs/security.md"],
    ["docs/workflow.md", "docs/workflow.md"],
    ["docs/activation.md", "docs/activation.md"],
    ["docs/verification.md", "docs/verification.md"],
    ["docs/onboarding-cursor-cloud.md", "docs/onboarding-cursor-cloud.md"],
    ["specs/decisions.md", "specs/"],
    ["specs/cursor-cloud.md", "specs/"],
    ["docs/agent-contracts/change-evaluator.md", "docs/agent-contracts/"],
    ["docs/authentication.md", "docs/authentication.md"],
    ["docs/database.md", "docs/database.md"],
    ["docs/deployment.md", "docs/deployment.md"],
    ["docs/domain.md", "docs/domain.md"],
    ["docs/onboarding-macos.md", "docs/onboarding-macos.md"],
  ])("classifies canonical authority path %s as high risk", (changedPath, rulePath) => {
    expect(classifyRisk({ changedPaths: [changedPath], externalOperations: [] }, policy)).toEqual({
      level: "high",
      reasons: [`path:${rulePath}`],
    });
  });

  it("requires observed reviewer families that satisfy risk-specific diversity", () => {
    expect(requiredReviewerFamilies({ risk: "low", primaryFamily: "openai" })).toEqual([]);
    expect(requiredReviewerFamilies({ risk: "high", primaryFamily: "openai" })).toEqual(["anthropic", "openai"]);
    expect(requiredReviewerFamilies({ risk: "normal", primaryFamily: "anthropic" })).toEqual(["openai"]);
    expect(validateReviewerFamilies({
      risk: "low",
      primaryFamily: "openai",
      reviewerFamilies: [],
    })).toEqual([]);
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

  it("routes expensive verification from derived risk and relevant paths", () => {
    expect(executionPolicyModule.deriveVerificationPlan({ changedPaths: [lowDoc], externalOperations: [] }, policy)).toEqual({
      risk: { level: "low", reasons: [`path:${lowDoc}`] },
      repository: "docs",
      databaseAuth: false,
      browser: false,
      macos: false,
      template: false,
    });
    expect(executionPolicyModule.deriveVerificationPlan({ changedPaths: ["src/app/page.tsx"], externalOperations: [] }, policy)).toEqual({
      risk: { level: "normal", reasons: [] },
      repository: "full",
      databaseAuth: false,
      browser: true,
      macos: false,
      template: false,
    });
    expect(executionPolicyModule.deriveVerificationPlan({ changedPaths: ["package-lock.json"], externalOperations: [] }, policy)).toEqual({
      risk: { level: "normal", reasons: [] },
      repository: "full",
      databaseAuth: true,
      browser: true,
      macos: true,
      template: true,
    });
    expect(executionPolicyModule.deriveVerificationPlan({ changedPaths: ["next.config.mjs"], externalOperations: [] }, policy)).toEqual({
      risk: { level: "high", reasons: ["path:next.config.mjs"] },
      repository: "full",
      databaseAuth: true,
      browser: true,
      macos: true,
      template: true,
    });
    expect(executionPolicyModule.deriveVerificationPlan({
      changedPaths: ["evidence/external-operations/issue-35-provider/result.json"],
      externalOperations: [],
    }, policy)).toEqual({
      risk: { level: "high", reasons: ["path:evidence/external-operations/"] },
      repository: "full",
      databaseAuth: true,
      browser: true,
      macos: true,
      template: true,
    });
    expect(executionPolicyModule.deriveVerificationPlan({ changedPaths: ["config/execution.json"], externalOperations: [] }, policy)).toEqual({
      risk: { level: "high", reasons: ["path:config/"] },
      repository: "full",
      databaseAuth: true,
      browser: true,
      macos: true,
      template: true,
    });
  });

  it("keeps the temporary operation-name copy exactly aligned with workflow core", () => {
    expect(executionOperationNames).toEqual(workflowOperationNames);
  });
});
