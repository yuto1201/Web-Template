import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateToolUse } from "../tools/guard-claude-tool.mjs";

const root = path.resolve("C:/workspace/web-template");

/** @param {string} tool_name @param {Record<string, unknown>} [tool_input] */
function decision(tool_name, tool_input = {}) {
  return evaluateToolUse({ tool_name, tool_input }, { projectRoot: root })
    .hookSpecificOutput.permissionDecision;
}

describe("Claude tool guard", () => {
  it("allows local reads and ordinary source edits", () => {
    expect(decision("Read", { file_path: path.join(root, "src", "app.ts") })).toBe("allow");
    expect(decision("Edit", { file_path: path.join(root, "src", "app.ts") })).toBe("allow");
    expect(decision("Write", { file_path: path.join(root, ".artifacts", "ops-requests", "request.json") })).toBe("allow");
  });

  it("allows only the fixed external-request artifact write surface", () => {
    const requestRoot = path.join(root, ".artifacts", "ops-requests");
    expect(decision("Write", { file_path: path.join(requestRoot, "request.json") })).toBe("allow");
    expect(decision("Write", { file_path: path.join(requestRoot, "request.txt") })).toBe("deny");
    expect(decision("Write", { file_path: path.join(requestRoot, "nested", "request.json") })).toBe("deny");
    expect(decision("Write", { file_path: path.join(root, ".artifacts", "issues", "5", "review.json") })).toBe("deny");
    expect(decision("Write", { file_path: path.join(root, ".artifacts", "ops-results", "result.json") })).toBe("deny");
    expect(decision("Write", { file_path: path.join(requestRoot, "..", "issues", "5", "review.json") })).toBe("deny");
    expect(decision("Write", { file_path: path.join(root, ".ARTIFACTS", "issues", "5", "review.json") })).toBe("deny");
    expect(decision("Write", { file_path: path.join(root, ".Artifacts", "ops-requests", "request.JSON") })).toBe("allow");
  });

  it("denies secret, external, and protected paths", () => {
    expect(decision("Read", { file_path: path.join(root, ".env.local") })).toBe("deny");
    expect(decision("Read", { file_path: "C:/Users/example/.ssh/id_ed25519" })).toBe("deny");
    expect(decision("Write", { file_path: path.join(root, ".git", "hooks", "pre-commit") })).toBe("deny");
    expect(decision("Edit", { file_path: path.join(root, ".claude", "settings.json") })).toBe("deny");
    expect(decision("Edit", { file_path: path.join(root, ".Claude", "Settings.json") })).toBe("deny");
    expect(decision("Edit", { file_path: path.join(root, "tools", "guard-claude-tool.mjs") })).toBe("deny");
    expect(decision("Write", { file_path: path.join(root, "package.json") })).toBe("deny");
    expect(decision("Write", { file_path: path.join(root, ".npmrc") })).toBe("deny");
    expect(decision("Write", { file_path: path.join(root, ".github", "dependabot.yml") })).toBe("deny");
    expect(decision("Write", { file_path: path.join(root, "docs", "authority.md") })).toBe("deny");
  });

  it("denies all MCP tools", () => {
    expect(decision("mcp__supabase__list_projects")).toBe("deny");
    expect(decision("mcp__github__get_me")).toBe("deny");
  });

  it("allows only the two read-only evaluator agents", () => {
    expect(decision("Agent", { subagent_type: "change-evaluator" })).toBe("allow");
    expect(decision("Task", { subagent_type: "supabase-auditor" })).toBe("allow");
    expect(decision("Agent", { subagent_type: "general-purpose" })).toBe("deny");
  });

  it("denies all shell commands, including local-looking validation", () => {
    expect(decision("Bash", { command: "git status --short --branch" })).toBe("deny");
    expect(decision("Bash", { command: "rg RLS supabase" })).toBe("deny");
    expect(decision("Bash", { command: "npm run check" })).toBe("deny");
    expect(decision("Bash", { command: "gh issue list" })).toBe("deny");
    expect(decision("Bash", { command: "git push origin main" })).toBe("deny");
    expect(decision("Bash", { command: "supabase projects list" })).toBe("deny");
    expect(decision("Bash", { command: "npx vercel" })).toBe("deny");
    expect(decision("Bash", { command: "npm run check && git push" })).toBe("deny");
    expect(decision("PowerShell", { command: "Get-ChildItem Env:" })).toBe("deny");
    expect(decision("Monitor", { command: "npm test" })).toBe("deny");
  });

  it("denies network tools", () => {
    expect(decision("WebFetch", { url: "https://api.github.com" })).toBe("deny");
    expect(decision("WebSearch", { query: "Supabase project" })).toBe("deny");
    expect(decision("ToolSearch", { query: "provider" })).toBe("deny");
  });

  it("fails closed for unknown tools", () => {
    expect(decision("Skill", { skill: "anything" })).toBe("deny");
    expect(decision("UnknownTool")).toBe("deny");
  });
});
