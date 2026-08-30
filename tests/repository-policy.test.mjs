import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  containsPotentialSecret,
  detectActorAsymmetry,
  hasCanonicalOperatorParityStatement,
  operatorParityErrors,
  validateRepository,
} from "../tools/repository-policy.mjs";

describe("repository policy", () => {
  it("keeps required policy, ownership, agent, and secret boundaries valid", async () => {
    const authority = JSON.parse(await readFile(path.resolve("config/ownership.json"), "utf8"));
    const template = JSON.parse(await readFile(path.resolve("config/template.json"), "utf8"));
    expect(template.project.observations.github.observedAt).not.toBe(authority.observations.github.observedAt);
    await expect(validateRepository(path.resolve("."))).resolves.toEqual([]);
  });

  it("detects representative provider credentials without flagging placeholders", () => {
    expect(containsPotentialSecret(["AK", "IA1234567890ABCDEF"].join(""))).toBe(true);
    expect(containsPotentialSecret(["sb", "p_12345678901234567890"].join(""))).toBe(true);
    expect(containsPotentialSecret(["-----BEGIN PRIVATE", " KEY-----"].join(""))).toBe(true);
    expect(containsPotentialSecret("SUPABASE_SERVICE_ROLE_KEY=replace-me")).toBe(false);
  });

  it("rejects residual actor-specific deny, guard, and delegation policy", () => {
    expect(operatorParityErrors({
      claudeSettings: {
        permissions: { deny: ["Bash"] },
        hooks: { PreToolUse: [{ hooks: [{ command: "node tools/guard-claude-tool.mjs" }] }] },
      },
      generatorSource: "All authenticated external operations must be delegated to Codex.",
      generatedAssets: new Map([
        ["CLAUDE.md", "Claude may perform local implementation only."],
      ]),
    })).toEqual(expect.arrayContaining([
      expect.stringMatching(/deny rules/u),
      expect.stringMatching(/PreToolUse/u),
      expect.stringMatching(/guard/u),
      expect.stringMatching(/delegation/u),
    ]));

    expect(operatorParityErrors({
      claudeSettings: { $schema: "https://json.schemastore.org/claude-code-settings.json" },
      generatorSource: "Claude has the same account-bound authority as Codex.",
      generatedAssets: new Map([
        ["CLAUDE.md", "Claude has the same account-bound authority as Codex."],
      ]),
    })).toEqual([]);
  });

  it.each([
    "Claude must delegate all external operations to Codex.",
    "codex MUST DELEGATE every provider operation to Claude!",
    "Only Codex may perform authenticated operations.",
    "CLAUDE-only external operations are prohibited.",
    "Provider ownership belongs only to Codex.",
    "Claude owns external service operations.",
    "Codex cannot use provider APIs.",
    "Claude must not operate deployments.",
    "Codex mustn't change DNS.",
    "External operations are forbidden for Claude.",
    "Authenticated provider work stays with Codex.",
    "External merge remains a Codex operation.",
    "Provider work belongs to Claude.",
    "Claude is not allowed to call provider APIs.",
    "Codex may not deploy production.",
    "Claude shall not change DNS.",
    "Codex is barred from external operations.",
  ])("detects actor-asymmetric operator restriction: %s", (content) => {
    expect(detectActorAsymmetry(content)).toMatch(/actor-specific/iu);
  });

  it.each([
    "Claude acting in implementer and external-operator roles has the same account-bound authority as Codex.",
    "Claude and Codex reviewers remain read-only.",
    "Claude reviews Codex implementations, and Codex reviews Claude implementations to preserve cross-model review independence.",
    "Generated evaluator and auditor roles remain read-only, and model family is used only for independent cross-model review.",
  ])("allows shared authority and read-only independent review policy: %s", (content) => {
    expect(detectActorAsymmetry(content)).toBeNull();
  });

  it("requires the canonical operator equality statement on authority entrypoints", () => {
    expect(hasCanonicalOperatorParityStatement(
      "Claude acting in implementer and external-operator roles has the same account-bound authority as Codex.",
    )).toBe(true);
    expect(hasCanonicalOperatorParityStatement(
      "Claude and Codex may both perform some work.",
    )).toBe(false);

    expect(operatorParityErrors({
      claudeSettings: { $schema: "https://json.schemastore.org/claude-code-settings.json" },
      generatorSource: "Claude and Codex may both perform some work.",
      generatedAssets: new Map([
        ["CLAUDE.md", "Claude and Codex may both perform some work."],
      ]),
    })).toEqual(expect.arrayContaining([
      expect.stringMatching(/canonical operator equality.+generator/iu),
      expect.stringMatching(/canonical operator equality.+CLAUDE\.md/iu),
    ]));
  });

  it("applies the shared detector to settings, generator, and generated entrypoint content", () => {
    const equality = "Claude acting in implementer and external-operator roles has the same account-bound authority as Codex.";
    const errors = operatorParityErrors({
      claudeSettings: {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        note: "Claude must delegate all external operations to Codex.",
      },
      generatorSource: `${equality}\nOnly CODEX may own provider operations.`,
      generatedAssets: new Map([
        ["CLAUDE.md", `${equality}\nClaude cannot operate deployments; Codex owns deployment operations.`],
      ]),
      canonicalSurfaces: new Map([
        ["tools/completion-audit.mjs", "Only Claude may own completion operations."],
      ]),
    });

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/\.claude\/settings\.json/iu),
      expect.stringMatching(/generate-agent-wrappers\.mjs/iu),
      expect.stringMatching(/CLAUDE\.md/iu),
      expect.stringMatching(/completion-audit\.mjs/iu),
    ]));
  });
});
