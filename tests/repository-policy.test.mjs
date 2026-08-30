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
    "Claude and Codex must delegate external operations to Codex.",
    "Claude and Codex may operate, but only Codex owns deployments.",
    "Claude and Codex may operate, while Claude cannot deploy production.",
    "Codex and Claude may operate, while Codex cannot deploy production.",
    "Claude and Codex share authority, although Codex is barred from DNS changes.",
    "Codex and Claude share authority, although Claude is barred from DNS changes.",
    "Claude and Codex may operate, Claude cannot change DNS.",
    "Codex and Claude may operate, Codex cannot change DNS.",
    "Claude and Codex may operate; Claude cannot change DNS.",
    "Codex and Claude may operate; Codex cannot change DNS.",
    "Claude and Codex may operate (although Claude cannot call provider APIs).",
    "Codex and Claude may operate (although Codex cannot call provider APIs).",
    "Claude (and Codex) may operate (although Codex cannot deploy production).",
    "Codex (and Claude) may operate (although Claude cannot deploy production).",
    "Claude and Codex share receipts, and Codex and Claude share targets, while Claude cannot deploy.",
    "Claude reviewer remains read-only, while Codex cannot deploy production.",
    "Claude reviewer remains read-only, while Codex cannot merge pull requests.",
    "Codex reviewer remains read-only, while Claude cannot merge pull requests.",
    "Codex auditor remains read-only, although Claude may not modify repository files.",
    "Claude auditor remains read-only, although Codex may not modify repository files.",
    "CLAUDE reviewer remains read-only, while codex cannot edit repository files!",
    "Codex evaluator remains read-only (although Claude cannot use the shell).",
    "Claude evaluator remains read-only, while Codex cannot use external tools.",
    "Claude reviewer remains read-only, Codex auditor remains read-only, while Claude cannot merge pull requests.",
    "Codex reviewer remains read-only, Claude auditor remains read-only, while Codex may not modify repository files.",
  ])("detects actor-asymmetric operator restriction: %s", (content) => {
    expect(detectActorAsymmetry(content)).toMatch(/actor-specific/iu);
  });

  it.each([
    "Claude reviewer cannot approve changes and Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes and Claude cannot merge pull requests.",
    "Claude auditor may not edit repository files and Codex cannot use external tools.",
    "Codex auditor may not edit repository files and Claude cannot use external tools.",
    "Claude reviewer may only review Codex-authored implementations and Codex cannot merge pull requests.",
    "Codex reviewer may only review Claude-authored implementations and Claude cannot merge pull requests.",
    "Claude reviewer cannot approve changes or Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes or Claude cannot merge pull requests.",
    "Claude reviewer cannot approve changes yet Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes yet Claude cannot merge pull requests.",
    "Claude reviewer cannot approve changes then Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes then Claude cannot merge pull requests.",
    "Claude reviewer cannot approve changes but Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes but Claude cannot merge pull requests.",
    "Claude reviewer cannot approve changes while Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes while Claude cannot merge pull requests.",
    "Claude reviewer cannot approve changes although Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes although Claude cannot merge pull requests.",
    "Claude reviewer cannot approve changes whereas Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes whereas Claude cannot merge pull requests.",
  ])("detects a no-punctuation actor restriction after reviewer coordination: %s", (content) => {
    expect(detectActorAsymmetry(content)).toMatch(/actor-specific/iu);
  });

  it.each([
    "Claude acting in implementer and external-operator roles has the same account-bound authority as Codex.",
    "Claude and Codex reviewers remain read-only.",
    "Claude reviews Codex implementations, and Codex reviews Claude implementations to preserve cross-model review independence.",
    "Generated evaluator and auditor roles remain read-only, and model family is used only for independent cross-model review.",
    "Claude and Codex must not switch authenticated accounts automatically.",
    "Only Claude and Codex in operator roles may use account-bound receipts.",
    "CLAUDE, and codex must not switch authenticated accounts automatically.",
    "Codex / Claude must not switch authenticated accounts automatically.",
    "Claude (and Codex) must not switch authenticated accounts automatically.",
    "Codex (and Claude) must not switch authenticated accounts automatically.",
    "Claude reviewer remains read-only.",
    "Codex auditor remains read-only.",
    "Claude reviewer and Codex auditor remain read-only.",
    "Claude reviewer must not self-approve changes.",
    "Codex auditor cannot approve Codex-authored changes.",
    "Claude reviewer cannot approve changes.",
    "Codex auditor may not edit repository files.",
    "Claude reviewer may only review Codex-authored changes.",
    "Codex evaluator may only evaluate Claude-authored implementations.",
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
    expect(detectActorAsymmetry(
      "Claude has the same account-bound authority as Codex and Codex cannot merge pull requests.",
    )).toMatch(/actor-specific/iu);
    expect(detectActorAsymmetry(
      "Claude has the same account-bound authority as Codex and Claude cannot use external tools.",
    )).toMatch(/actor-specific/iu);

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
