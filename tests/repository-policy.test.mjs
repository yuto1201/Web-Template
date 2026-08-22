import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  containsPotentialSecret,
  validateCursorHookPolicy,
  validateRepository,
} from "../tools/repository-policy.mjs";

const validHookConfig = {
  version: 1,
  hooks: Object.fromEntries([
    "preToolUse",
    "beforeShellExecution",
    "subagentStart",
    "subagentStop",
    "afterFileEdit",
  ].map((event) => [event, [{
    type: "command",
    command: "node tools/guard-cursor-hook.mjs",
    timeout: 10,
    failClosed: true,
  }]])),
};

const validAgentsConfig = {
  cursor: {
    families: ["openai", "anthropic"],
    roles: [
      { slug: "consultant" },
      { slug: "change-evaluator" },
      { slug: "supabase-auditor" },
    ],
  },
};

const validExecutionPolicy = {
  modelFamilies: {
    openai: ["^gpt-5\\.6-(?:sol|terra|luna)$"],
    anthropic: ["^claude-(?:opus|sonnet|fable)-5$"],
  },
  cursorModels: {
    openai: "gpt-5.6-sol[effort=high]",
    anthropic: "claude-opus-5[effort=high]",
  },
};

const validCursorAgents = [
  "change-evaluator-anthropic.md",
  "change-evaluator-openai.md",
  "consultant-anthropic.md",
  "consultant-openai.md",
  "supabase-auditor-anthropic.md",
  "supabase-auditor-openai.md",
];

const validCursorAgentContents = Object.fromEntries(validCursorAgents.map((filename) => {
  const name = filename.replace(/\.md$/u, "");
  const family = name.endsWith("-openai") ? "openai" : "anthropic";
  const model = family === "openai" ? "gpt-5.6-sol[effort=high]" : "claude-opus-5[effort=high]";
  return [filename, `---\nname: ${name}\nmodel: ${model}\nreadonly: true\nis_background: false\n---\n\nCanonical contract.\n`];
}));

function cursorPolicyErrors(overrides = {}) {
  return validateCursorHookPolicy({
    hooksConfig: structuredClone(validHookConfig),
    packageJson: { scripts: { "cursor:hook-check": "node tools/guard-cursor-hook.mjs --check" } },
    agentsConfig: structuredClone(validAgentsConfig),
    executionPolicy: structuredClone(validExecutionPolicy),
    cursorAgentFiles: [...validCursorAgents],
    cursorAgentContents: structuredClone(validCursorAgentContents),
    ...overrides,
  });
}

describe("repository policy", () => {
  it("keeps required policy, ownership, agent, and secret boundaries valid", async () => {
    await expect(validateRepository(path.resolve("."))).resolves.toEqual([]);
  });

  it("detects representative provider credentials without flagging placeholders", () => {
    expect(containsPotentialSecret(["AK", "IA1234567890ABCDEF"].join(""))).toBe(true);
    expect(containsPotentialSecret(["sb", "p_12345678901234567890"].join(""))).toBe(true);
    expect(containsPotentialSecret(["-----BEGIN PRIVATE", " KEY-----"].join(""))).toBe(true);
    expect(containsPotentialSecret("SUPABASE_SERVICE_ROLE_KEY=replace-me")).toBe(false);
  });

  it("accepts only the five finite fail-closed Cursor Cloud command hooks", () => {
    expect(cursorPolicyErrors()).toEqual([]);

    const notFailClosed = structuredClone(validHookConfig);
    notFailClosed.hooks.preToolUse[0].failClosed = false;
    expect(cursorPolicyErrors({ hooksConfig: notFailClosed })).toContain(
      "Cursor hook preToolUse must be a finite fail-closed project command.",
    );

    const noTimeout = structuredClone(validHookConfig);
    delete noTimeout.hooks.beforeShellExecution[0].timeout;
    expect(cursorPolicyErrors({ hooksConfig: noTimeout })).toContain(
      "Cursor hook beforeShellExecution must be a finite fail-closed project command.",
    );

    const promptHook = structuredClone(validHookConfig);
    promptHook.hooks.subagentStart[0].type = "prompt";
    expect(cursorPolicyErrors({ hooksConfig: promptHook })).toContain(
      "Cursor hook subagentStart must be a finite fail-closed project command.",
    );
  });

  it("rejects non-root commands, unsupported Cloud MCP hooks, and credential values", () => {
    const absoluteCommand = structuredClone(validHookConfig);
    absoluteCommand.hooks.afterFileEdit[0].command = "/tmp/guard-cursor-hook.mjs";
    expect(cursorPolicyErrors({ hooksConfig: absoluteCommand })).toContain(
      "Cursor hook afterFileEdit must be a finite fail-closed project command.",
    );

    const unsupportedMcpHook = structuredClone(validHookConfig);
    unsupportedMcpHook.hooks.beforeMCPExecution = structuredClone(validHookConfig.hooks.preToolUse);
    expect(cursorPolicyErrors({ hooksConfig: unsupportedMcpHook })).toContain(
      "Cursor Cloud project hooks must not claim unsupported hook coverage.",
    );

    const credentialConfig = structuredClone(validHookConfig);
    credentialConfig.hooks.preToolUse[0].command += ` ${["ghp", "_123456789012345678901234567890"].join("")}`;
    expect(cursorPolicyErrors({ hooksConfig: credentialConfig })).toContain(
      "Cursor hook configuration must not contain credential values.",
    );
  });

  it("requires generated Cursor agent parity and the deterministic hook check", () => {
    expect(cursorPolicyErrors({ cursorAgentFiles: validCursorAgents.slice(1) })).toContain(
      ".cursor/agents must contain exactly the generated Cursor agent set.",
    );
    expect(cursorPolicyErrors({
      packageJson: { scripts: { "cursor:hook-check": "node tools/guard-cursor-hook.mjs" } },
    })).toContain("package.json must expose the deterministic Cursor hook check.");
    expect(cursorPolicyErrors({
      packageJson: { scripts: { "cursor:hook-check": "echo $TOKEN | node tools/guard-cursor-hook.mjs" } },
    })).toContain("package.json must expose the deterministic Cursor hook check.");
  });

  it("rejects empty, missing, extra, and noncanonical Cursor role or family policy", () => {
    for (const cursor of [
      { families: [], roles: [] },
      { families: ["openai"], roles: structuredClone(validAgentsConfig.cursor.roles) },
      { families: ["openai", "anthropic", "cursor"], roles: structuredClone(validAgentsConfig.cursor.roles) },
      { families: ["openai", "anthropic"], roles: [] },
      { families: ["openai", "anthropic"], roles: [{ slug: "consultant" }, { slug: "change-evaluator" }] },
      { families: ["openai", "anthropic"], roles: [...structuredClone(validAgentsConfig.cursor.roles), { slug: "general-purpose" }] },
    ]) {
      expect(cursorPolicyErrors({ agentsConfig: { cursor } })).toContain(
        "Cursor agent roles and families must match the canonical nonempty sets.",
      );
    }
    expect(cursorPolicyErrors({
      agentsConfig: { cursor: { families: [], roles: [] } },
      cursorAgentFiles: [],
      cursorAgentContents: {},
    })).toContain(".cursor/agents must contain exactly the generated Cursor agent set.");
  });

  it("rejects configured model family mismatch and generated frontmatter drift", () => {
    const mismatchedModels = structuredClone(validExecutionPolicy);
    mismatchedModels.cursorModels.openai = "claude-opus-5[effort=high]";
    expect(cursorPolicyErrors({ executionPolicy: mismatchedModels })).toContain(
      "Cursor configured models must match their canonical families.",
    );

    const writableAgent = structuredClone(validCursorAgentContents);
    writableAgent["change-evaluator-openai.md"] = writableAgent["change-evaluator-openai.md"].replace(
      "readonly: true",
      "readonly: false",
    );
    expect(cursorPolicyErrors({ cursorAgentContents: writableAgent })).toContain(
      ".cursor/agents content must preserve canonical name, model, and readonly frontmatter.",
    );

    const wrongModelAgent = structuredClone(validCursorAgentContents);
    wrongModelAgent["consultant-anthropic.md"] = wrongModelAgent["consultant-anthropic.md"].replace(
      "claude-opus-5[effort=high]",
      "gpt-5.6-sol[effort=high]",
    );
    expect(cursorPolicyErrors({ cursorAgentContents: wrongModelAgent })).toContain(
      ".cursor/agents content must preserve canonical name, model, and readonly frontmatter.",
    );
  });
});
