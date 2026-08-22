import { Readable, Writable } from "node:stream";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadExecutionPolicy } from "../tools/execution-policy.mjs";
import { evaluateCursorHook, runCli } from "../tools/guard-cursor-hook.mjs";

const repositoryRoot = path.resolve(".");
const fixtureRoot = path.join(path.parse(repositoryRoot).root, "workspace", "web-template");
const executionPolicy = await loadExecutionPolicy(repositoryRoot);
const context = { root: fixtureRoot, executionPolicy };

/** @param {unknown} input @param {{ root: string, executionPolicy: unknown }} [evaluationContext] */
function decision(input, evaluationContext = context) {
  return evaluateCursorHook(input, evaluationContext).permission;
}

function writableCapture() {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    value: () => value,
  };
}

describe("Cursor Cloud hook guard", () => {
  it("allows only generated subagents on their configured model family", () => {
    expect(decision({
      hook_event_name: "subagentStart",
      subagent_type: "change-evaluator-anthropic",
      subagent_model: "claude-opus-5",
      task: "Review the exact packet",
    })).toBe("allow");
    expect(decision({
      hook_event_name: "subagentStart",
      subagent_type: "consultant-openai",
      subagent_model: "gpt-5.6-sol",
      task: "Assess one bounded question",
    })).toBe("allow");
    expect(decision({
      hook_event_name: "subagentStart",
      subagent_type: "change-evaluator-anthropic",
      subagent_model: "gpt-5.6-sol",
      task: "Review the exact packet",
    })).toBe("deny");
    expect(decision({
      hook_event_name: "subagentStart",
      subagent_type: "generalPurpose",
      subagent_model: "claude-opus-5",
      task: "Do unrestricted work",
    })).toBe("deny");
    expect(decision({
      hook_event_name: "subagentStart",
      subagent_type: "change-evaluator-anthropic",
      subagent_model: "claude-opus-unknown",
      task: "Review the exact packet",
    })).toBe("deny");
  });

  it("keeps generated subagents read-only through tool and completion checks", () => {
    expect(decision({
      hook_event_name: "preToolUse",
      subagent_type: "change-evaluator-openai",
      tool_name: "Write",
      tool_input: { path: path.join(fixtureRoot, "src", "app.ts") },
    })).toBe("deny");
    expect(decision({
      hook_event_name: "subagentStop",
      subagent_type: "change-evaluator-openai",
      status: "completed",
      modified_files: [],
    })).toBe("allow");
    expect(decision({
      hook_event_name: "subagentStop",
      subagent_type: "change-evaluator-openai",
      status: "completed",
      modified_files: ["src/app.ts"],
    })).toBe("deny");
    expect(decision({
      hook_event_name: "subagentStop",
      subagent_type: "unknown-agent",
      status: "completed",
      modified_files: [],
    })).toBe("deny");
    expect(decision({
      hook_event_name: "subagentStop",
      subagent_type: "change-evaluator-openai",
      status: "error",
      modified_files: [],
    })).toBe("deny");
  });

  it("allows ordinary parent app and test writes while denying escapes and protected surfaces", () => {
    expect(decision({
      hook_event_name: "preToolUse",
      tool_name: "Read",
      tool_input: { path: path.join(fixtureRoot, "src", "app.ts") },
    })).toBe("allow");
    expect(decision({
      hook_event_name: "preToolUse",
      tool_name: "Write",
      tool_input: { path: path.join(fixtureRoot, "src", "app.ts"), contents: "scoped" },
    })).toBe("allow");
    expect(decision({
      hook_event_name: "preToolUse",
      tool_name: "Edit",
      tool_input: { path: path.join(fixtureRoot, "tests", "app.test.ts") },
    })).toBe("allow");
    expect(decision({
      hook_event_name: "preToolUse",
      tool_name: "Write",
      tool_input: { path: path.join(fixtureRoot, "..", "escaped.ts"), contents: "escape" },
    })).toBe("deny");
    expect(decision({
      hook_event_name: "preToolUse",
      tool_name: "Write",
      tool_input: { path: ".env.local", contents: "secret" },
    })).toBe("deny");
    expect(decision({
      hook_event_name: "preToolUse",
      tool_name: "Write",
      tool_input: { path: ".cursor/hooks.json", contents: "disable guard" },
    })).toBe("deny");
    expect(decision({
      hook_event_name: "preToolUse",
      tool_name: "Write",
      tool_input: { path: ".artifacts/issues/29/deadbeef/reviews/openai.json", contents: "approved" },
    })).toBe("deny");
    expect(decision({
      hook_event_name: "afterFileEdit",
      file_path: path.join(fixtureRoot, ".artifacts", "issues", "29", "state.json"),
      edits: [],
    })).toBe("deny");
    expect(decision({
      hook_event_name: "afterFileEdit",
      file_path: path.join(fixtureRoot, "src", "app.ts"),
      edits: [],
    })).toBe("allow");
  });

  it("denies symlink aliases to protected, sensitive, and outside paths, including nonexistent descendants", async () => {
    const container = await mkdtemp(path.join(os.tmpdir(), "cursor-hook-symlink-"));
    const root = path.join(container, "repository");
    const outside = path.join(container, "outside");
    try {
      await mkdir(path.join(root, "src"), { recursive: true });
      await mkdir(path.join(root, "ordinary"), { recursive: true });
      await mkdir(path.join(root, ".cursor"), { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(root, ".cursor", "hooks.json"), "{}\n", "utf8");
      await writeFile(path.join(outside, "secret.txt"), "secret\n", "utf8");
      await symlink(path.join(root, ".cursor"), path.join(root, "src", "policy-alias"), process.platform === "win32" ? "junction" : "dir");
      await symlink(outside, path.join(root, "src", "outside-alias"), process.platform === "win32" ? "junction" : "dir");
      await symlink(path.join(root, "ordinary"), path.join(root, "src", "ordinary-alias"), process.platform === "win32" ? "junction" : "dir");
      const realContext = { root, executionPolicy };

      expect(decision({
        hook_event_name: "preToolUse",
        tool_name: "Write",
        tool_input: { path: path.join(root, "src", "policy-alias", "hooks.json") },
      }, realContext)).toBe("deny");
      expect(decision({
        hook_event_name: "preToolUse",
        tool_name: "Read",
        tool_input: { path: path.join(root, "src", "outside-alias", "secret.txt") },
      }, realContext)).toBe("deny");
      expect(decision({
        hook_event_name: "preToolUse",
        tool_name: "Write",
        tool_input: { path: path.join(root, "src", "outside-alias", "future", "file.ts") },
      }, realContext)).toBe("deny");
      expect(decision({
        hook_event_name: "afterFileEdit",
        file_path: path.join(root, "src", "policy-alias", "hooks.json"),
      }, realContext)).toBe("deny");
      expect(decision({
        hook_event_name: "preToolUse",
        tool_name: "Write",
        tool_input: { path: path.join(root, "src", "ordinary-alias", "file.ts") },
      }, realContext)).toBe("deny");
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  });

  it.each([
    "AGENTS.md",
    "package.json",
    "package-lock.json",
    ".cursor/environment.json",
    ".github/workflows/ci.yml",
    ".claude/settings.json",
    ".codex/agents/change-evaluator.toml",
    "config/agents.json",
    "config/acceptance.json",
    "config/execution.json",
    "config/github-ruleset.json",
    "config/ownership.json",
    "config/review-contract.schema.json",
    "config/template.json",
    "config/workflow.json",
    "docs/authority.md",
    "docs/security.md",
    "docs/workflow.md",
    "docs/activation.md",
    "docs/verification.md",
    "docs/onboarding-cursor-cloud.md",
    "specs/decisions.md",
    "specs/cursor-cloud.md",
    "tools/guard-claude-tool.mjs",
    "tools/guard-cursor-hook.mjs",
    "tools/github-review-gate.mjs",
    "tools/issue-workflow.mjs",
    "tools/repository-policy.mjs",
    "tools/template-core.mjs",
    "tools/verify-template-instantiation.mjs",
    "tools/verify-acceptance-trace.mjs",
    "tools/cursor-cloud-doctor.mjs",
    "tools/workflow-core.mjs",
    ".artifacts/issues/29/deadbeef/review-packet.json",
    ".artifacts/ops-results/issue-29.result.json",
  ])("denies direct parent edits to protected surface %s before and after edit", (relativePath) => {
    expect(decision({
      hook_event_name: "preToolUse",
      tool_name: "Write",
      tool_input: { path: path.join(fixtureRoot, relativePath), contents: "rewrite" },
    })).toBe("deny");
    expect(decision({
      hook_event_name: "afterFileEdit",
      file_path: path.join(fixtureRoot, relativePath),
      edits: [],
    })).toBe("deny");
  });

  it.each([
    ["acceptance policy", "specs/acceptance.md"],
    ["product policy", "specs/product.md"],
    ["architecture policy", "specs/architecture.md"],
    ["review packet contract", "docs/agent-contracts/review-packet.md"],
    ["change evaluator contract", "docs/agent-contracts/change-evaluator.md"],
    ["README onboarding", "README.md"],
    ["generated-agent policy generator", "tools/generate-agent-wrappers.mjs"],
    ["generated-agent execution policy helper", "tools/execution-policy.mjs"],
  ])("denies %s edits to %s before and after the file event", (_category, relativePath) => {
    expect(decision({
      hook_event_name: "preToolUse",
      tool_name: "Write",
      tool_input: { path: path.join(fixtureRoot, relativePath), contents: "rewrite" },
    })).toBe("deny");
    expect(decision({
      hook_event_name: "afterFileEdit",
      file_path: path.join(fixtureRoot, relativePath),
      edits: [],
    })).toBe("deny");
  });

  it.each([
    ["canonical config", "config/acceptance.json"],
    ["authority documentation", "docs/security.md"],
    ["accepted decisions", "specs/decisions.md"],
    ["verification tooling", "tools/verify-acceptance-trace.mjs"],
  ])("classifies %s path %s as protected without blocking ordinary source", (_category, relativePath) => {
    expect(decision({
      hook_event_name: "preToolUse",
      tool_name: "Write",
      tool_input: { path: path.join(fixtureRoot, relativePath), contents: "rewrite" },
    })).toBe("deny");
    expect(decision({
      hook_event_name: "preToolUse",
      tool_name: "Write",
      tool_input: { path: path.join(fixtureRoot, "src", "feature.ts"), contents: "ordinary" },
    })).toBe("allow");
  });

  it("denies credential and environment reads without returning the candidate value", () => {
    for (const candidate of [
      ".env.local",
      path.join(fixtureRoot, ".git", "config"),
      path.join(fixtureRoot, ".ssh", "id_ed25519"),
      path.join(fixtureRoot, ".aws", "credentials"),
      path.join(fixtureRoot, ".config", "gh", "hosts.yml"),
      path.join(fixtureRoot, ".config", "supabase", "access-token"),
    ]) {
      const result = evaluateCursorHook({
        hook_event_name: "preToolUse",
        tool_name: "Read",
        tool_input: { path: candidate },
      }, context);
      expect(result.permission).toBe("deny");
      expect(JSON.stringify(result)).not.toContain(candidate);
    }
    expect(decision({
      hook_event_name: "preToolUse",
      tool_name: "Grep",
      tool_input: { pattern: "TOKEN" },
    })).toBe("deny");
  });

  it("allows deterministic tests, builds, and non-destructive Git inspection", () => {
    for (const command of [
      "npm test -- guard-cursor-hook",
      "npm run build",
      "npm run lint",
      "npm run policy",
      "npm run check:generated",
      "git status --short --branch",
      "git diff --check",
      "git log -3 --oneline",
      "git show --stat HEAD",
      "git rev-parse HEAD",
      "rg -n hooks .cursor tools tests",
    ]) {
      expect(decision({
        hook_event_name: "beforeShellExecution",
        command,
        cwd: fixtureRoot,
        sandbox: false,
      }), command).toBe("allow");
    }
  });

  it("rejects Git output, external execution, config, pager, and noncanonical argv", () => {
    for (const command of [
      "git diff --output review.patch",
      "git diff --output=review.patch",
      "git diff --output .cursor/hooks.json",
      "git diff --output /tmp/review.patch",
      "git diff --ext-diff",
      "git diff --textconv",
      "git --paginate status",
      "git -c alias.inspect=status inspect",
      "git --config-env=credential.helper=HELPER status",
      "git status --output status.txt",
      "git show HEAD:.env.local",
      "git diff -- .cursor/hooks.json",
    ]) {
      expect(decision({
        hook_event_name: "beforeShellExecution",
        command,
        cwd: fixtureRoot,
        sandbox: false,
      }), command).toBe("deny");
    }
  });

  it("rejects npm passthrough, loaders, config, expansion, assignment, and noncanonical scripts", () => {
    for (const command of [
      "npm test -- --config malicious.mjs",
      "npm test -- --config=malicious.mjs",
      "npm test -- --loader malicious.mjs",
      "npm test -- $TEST_SELECTOR",
      "npm test -- SELECTOR=guard-cursor-hook",
      "npm test -- ~/malicious.test.mjs",
      "npm test -- /tmp/malicious.test.mjs",
      "npm run lint -- --config malicious.mjs",
      "npm run build -- --config malicious.mjs",
      "npm run db:stop",
      "npm run generate",
      "npm run unknown-script",
    ]) {
      expect(decision({
        hook_event_name: "beforeShellExecution",
        command,
        cwd: fixtureRoot,
        sandbox: false,
      }), command).toBe("deny");
    }
  });

  it("denies environment reads, destructive history, recursive deletion, cwd escapes, and compound shell", () => {
    for (const command of [
      "env",
      "printenv",
      "Get-ChildItem Env:",
      "cat ~/.ssh/id_ed25519",
      "rg token /Users/example/.ssh/id_ed25519",
      "rg token /Users/example/.config/gh/hosts.yml",
      "rg token /proc/self/environ",
      "rg root /etc/passwd",
      "npm test -- --config ../outside/vitest.config.mjs",
      "rg token ..\\outside\\credential.txt",
      "git reset --hard HEAD~1",
      "git rebase main",
      "git push --force origin main",
      "git clean -fdx",
      "rm -rf src",
      "Remove-Item -Recurse src",
      "npm test && env",
    ]) {
      expect(decision({
        hook_event_name: "beforeShellExecution",
        command,
        cwd: fixtureRoot,
        sandbox: false,
      }), command).toBe("deny");
    }
    expect(decision({
      hook_event_name: "beforeShellExecution",
      command: "npm test",
      cwd: path.join(fixtureRoot, ".."),
      sandbox: false,
    })).toBe("deny");
  });

  it("fails closed for malformed event shapes, unknown tools, and unknown hook events", () => {
    expect(decision(null)).toBe("deny");
    expect(decision({ hook_event_name: "preToolUse", tool_name: "Write", tool_input: {} })).toBe("deny");
    expect(decision({ hook_event_name: "preToolUse", tool_name: "UnknownTool", tool_input: {} })).toBe("deny");
    expect(decision({ hook_event_name: "beforeMCPExecution", tool_name: "provider.write" })).toBe("deny");
    expect(decision({ hook_event_name: "notARealHook" })).toBe("deny");
    expect(decision({ hook_event_name: "preToolUse" }, { root: fixtureRoot, executionPolicy: null })).toBe("deny");
  });

  it("returns one redacted deny object and nonzero status for malformed JSON", async () => {
    const stdout = writableCapture();
    const stderr = writableCapture();
    const secretBearingInput = "{\"token\":\"do-not-echo-this\"";
    const status = await runCli({
      stdin: Readable.from([secretBearingInput]),
      stdout: stdout.stream,
      stderr: stderr.stream,
      root: repositoryRoot,
    });
    expect(status).toBeGreaterThan(0);
    expect(stdout.value().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout.value())).toMatchObject({ permission: "deny" });
    expect(`${stdout.value()}${stderr.value()}`).not.toContain("do-not-echo-this");
  });

  it("fails closed without input disclosure when configuration loading crashes", async () => {
    const stdout = writableCapture();
    const stderr = writableCapture();
    const secretBearingInput = JSON.stringify({ hook_event_name: "preToolUse", token: "do-not-echo-this" });
    const status = await runCli({
      stdin: Readable.from([secretBearingInput]),
      stdout: stdout.stream,
      stderr: stderr.stream,
      root: path.join(repositoryRoot, "missing-root"),
    });
    expect(status).toBeGreaterThan(0);
    expect(JSON.parse(stdout.value())).toMatchObject({ permission: "deny" });
    expect(`${stdout.value()}${stderr.value()}`).not.toContain("do-not-echo-this");
  });
});
