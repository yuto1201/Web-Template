import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  containsPotentialSecret,
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
});
