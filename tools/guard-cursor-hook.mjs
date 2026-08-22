import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadExecutionPolicy } from "./execution-policy.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(modulePath), "..");
const readTools = new Set(["Glob", "Grep", "LS", "Read", "Search"]);
const pathRequiredReadTools = new Set(["Glob", "Grep", "Read", "Search"]);
const editTools = new Set(["Delete", "Edit", "MultiEdit", "NotebookEdit", "Write"]);
const passiveTools = new Set([
  "AskQuestion",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TodoWrite",
]);
const protectedFiles = new Set([
  "agents.md",
  "claude.md",
  "readme.md",
  ".cursor/hooks.json",
  "package-lock.json",
  "package.json",
  "config/agents.json",
  "config/acceptance.json",
  "config/execution.json",
  "config/github-ruleset.json",
  "config/ownership.json",
  "config/review-contract.schema.json",
  "config/template.json",
  "config/workflow.json",
  "docs/activation.md",
  "docs/authority.md",
  "docs/onboarding-cursor-cloud.md",
  "docs/security.md",
  "docs/verification.md",
  "docs/workflow.md",
  "specs/decisions.md",
  "specs/cursor-cloud.md",
  "tools/cursor-cloud-doctor.mjs",
  "tools/execution-policy.mjs",
  "tools/generate-agent-wrappers.mjs",
  "tools/guard-claude-tool.mjs",
  "tools/guard-cursor-hook.mjs",
  "tools/github-review-gate.mjs",
  "tools/issue-workflow.mjs",
  "tools/repository-policy.mjs",
  "tools/template-core.mjs",
  "tools/verify-acceptance-trace.mjs",
  "tools/verify-template-instantiation.mjs",
  "tools/workflow-core.mjs",
]);
const protectedPrefixes = [
  ".claude/",
  ".codex/",
  ".cursor/",
  ".github/",
  ".artifacts/issues/",
  ".artifacts/ops-results/",
  "docs/agent-contracts/",
  "specs/",
];
const safePackageScripts = new Set([
  "audit:completion",
  "audit:trace",
  "auth:verify",
  "build",
  "build:ci",
  "check",
  "check:generated",
  "check:links",
  "cursor:hook-check",
  "deployment:lint",
  "domain:lint",
  "lint",
  "policy",
  "scan:client",
  "template:readiness",
  "template:source-check",
  "test:boundary",
  "test:client-scan",
  "test:e2e",
  "typecheck",
  "typegen",
  "workstation:doctor",
]);
const focusedTestSelectors = [
  ["guard-cursor-hook"],
  ["repository-policy"],
  ["generated-assets"],
  ["guard-cursor-hook", "repository-policy", "generated-assets"],
];

function allow() {
  return { permission: "allow" };
}

function deny() {
  return {
    permission: "deny",
    user_message: "Repository guard denied this action.",
    agent_message: "Use a repository-scoped, non-sensitive, non-destructive action allowed by policy.",
  };
}

/** @param {string} configured */
function configuredBaseModel(configured) {
  const match = /^(.*)\[[^\[\]]+\]$/u.exec(configured);
  return match ? match[1] : configured;
}

/** @param {unknown} executionPolicy */
function cursorAgentModels(executionPolicy) {
  if (!executionPolicy || typeof executionPolicy !== "object") throw new Error("Invalid execution policy.");
  const policy = /** @type {{ cursorModels?: Record<string, unknown> }} */ (executionPolicy);
  if (typeof policy.cursorModels?.openai !== "string" || typeof policy.cursorModels?.anthropic !== "string") {
    throw new Error("Invalid Cursor model policy.");
  }
  const models = {
    openai: configuredBaseModel(policy.cursorModels.openai),
    anthropic: configuredBaseModel(policy.cursorModels.anthropic),
  };
  if (!models.openai || !models.anthropic) throw new Error("Invalid Cursor model policy.");
  return models;
}

/** @param {unknown} executionPolicy */
function allowedSubagents(executionPolicy) {
  const models = cursorAgentModels(executionPolicy);
  return new Map(
    ["change-evaluator", "consultant", "supabase-auditor"].flatMap((role) => (
      Object.entries(models).map(([family, model]) => [`${role}-${family}`, model])
    )),
  );
}

/** @param {string} root @param {string} candidate */
function repositoryPath(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const relative = path.relative(resolvedRoot, resolved).replaceAll("\\", "/");
  const outside = relative === ".." || relative.startsWith("../") || path.isAbsolute(relative);
  return { outside, relative: relative || "." };
}

/** @param {string} relative */
function isSensitivePath(relative) {
  const normalized = relative.toLowerCase();
  const segments = normalized.split("/");
  const filename = segments.at(-1) ?? "";
  if ([".git", ".ssh", ".aws"].some((segment) => segments.includes(segment))) return true;
  if (normalized.includes("/.config/gh/") || normalized.startsWith(".config/gh/")) return true;
  if (normalized.includes("/.config/supabase/") || normalized.startsWith(".config/supabase/")) return true;
  if (filename === ".env.example") return false;
  return filename === ".env" || filename.startsWith(".env.") || filename.endsWith(".pem") ||
    filename.endsWith(".key") || filename === "credentials" || filename === "credentials.json";
}

/** @param {string} relative */
function isProtectedWrite(relative) {
  const normalized = relative.toLowerCase();
  return protectedFiles.has(normalized) || protectedPrefixes.some((prefix) => normalized.startsWith(prefix));
}

/** @param {Record<string, unknown>} input */
function candidatePaths(input) {
  return [input.file_path, input.notebook_path, input.path, input.target_file]
    .filter((value) => typeof value === "string" && value.length > 0);
}

/** @param {string} toolName @param {Record<string, unknown>} input @param {string} root @param {boolean} readonly */
function evaluatePathTool(toolName, input, root, readonly) {
  const paths = candidatePaths(input);
  const isEdit = editTools.has(toolName);
  if ((isEdit || pathRequiredReadTools.has(toolName)) && paths.length === 0) return deny();
  if (isEdit && readonly) return deny();
  for (const candidate of paths) {
    const { outside, relative } = repositoryPath(root, candidate);
    if (outside || isSensitivePath(relative) || (isEdit && isProtectedWrite(relative))) return deny();
  }
  return allow();
}

/** @param {string[]} left @param {string[]} right */
function argvEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** @param {string} command */
function parseCommandArgv(command) {
  const trimmed = command.trim();
  if (!trimmed || /[\0\r\n;&|`<>$(){}!#*?\[\]'"\\]/u.test(trimmed)) return null;
  const argv = trimmed.split(/\s+/u);
  for (const argument of argv) {
    if (
      argument.startsWith("~") ||
      argument.startsWith("/") ||
      /^[A-Za-z]:[\\/]/u.test(argument) ||
      argument.split(/[\\/]/u).includes("..")
    ) {
      return null;
    }
  }
  return argv;
}

/** @param {string[]} argv */
function isAllowedNpmArgv(argv) {
  if (!new Set(["npm", "npm.cmd"]).has(argv[0])) return false;
  if (argv.some((argument) => argument.includes("=") || argument.includes("$"))) return false;
  if (argvEqual(argv, [argv[0], "test"])) return true;
  if (argv[1] === "test" && argv[2] === "--") {
    const selectors = argv.slice(3);
    return focusedTestSelectors.some((allowed) => argvEqual(selectors, allowed));
  }
  return argv.length === 3 && argv[1] === "run" && safePackageScripts.has(argv[2]);
}

/** @param {string[]} argv */
function isAllowedGitArgv(argv) {
  if (argv[0] !== "git" || argv.some((argument) => argument.includes("="))) return false;
  const exactCommands = [
    ["git", "status"],
    ["git", "status", "--short"],
    ["git", "status", "--short", "--branch"],
    ["git", "diff"],
    ["git", "diff", "--check"],
    ["git", "diff", "--cached"],
    ["git", "diff", "--stat"],
    ["git", "diff", "--name-only"],
    ["git", "log"],
    ["git", "show", "HEAD"],
    ["git", "show", "--stat", "HEAD"],
    ["git", "rev-parse", "HEAD"],
    ["git", "rev-parse", "--show-toplevel"],
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    ["git", "ls-files"],
    ["git", "merge-base", "main", "HEAD"],
    ["git", "merge-base", "origin/main", "HEAD"],
    ["git", "branch", "--show-current"],
  ];
  if (exactCommands.some((allowed) => argvEqual(argv, allowed))) return true;
  return argv.length === 4 && argv[1] === "log" && /^-[1-9][0-9]?$/u.test(argv[2]) && argv[3] === "--oneline";
}

/** @param {string[]} argv */
function isAllowedReadCommandArgv(argv) {
  if (argvEqual(argv, ["pwd"]) || argvEqual(argv, ["ls"]) || argvEqual(argv, ["ls", "-la"])) return true;
  if (argv[0] !== "rg" || argv.length < 2) return false;
  let index = argv[1] === "-n" ? 2 : 1;
  if (index >= argv.length || argv[index].startsWith("-")) return false;
  index += 1;
  return argv.slice(index).every((candidate) => !isSensitivePath(candidate));
}

/** @param {string[]} argv */
function isAllowedNodeArgv(argv) {
  return [
    ["node", "tools/guard-cursor-hook.mjs", "--check"],
    ["node", "tools/repository-policy.mjs"],
    ["node", "tools/generate-agent-wrappers.mjs", "--check"],
  ].some((allowed) => argvEqual(argv, allowed));
}

/** @param {string} command */
function isAllowedShellCommand(command) {
  const argv = parseCommandArgv(command);
  if (!argv) return false;
  return isAllowedNpmArgv(argv) || isAllowedGitArgv(argv) || isAllowedReadCommandArgv(argv) || isAllowedNodeArgv(argv);
}

/** @param {Record<string, unknown>} event @param {string} root */
function evaluateShell(event, root) {
  if (typeof event.command !== "string" || typeof event.cwd !== "string") return deny();
  if (repositoryPath(root, event.cwd).outside || !isAllowedShellCommand(event.command)) return deny();
  return allow();
}

/** @param {Record<string, unknown>} event @param {string} root @param {Map<string, string>} subagents */
function evaluatePreToolUse(event, root, subagents) {
  const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
  const input = event.tool_input && typeof event.tool_input === "object" && !Array.isArray(event.tool_input)
    ? /** @type {Record<string, unknown>} */ (event.tool_input)
    : {};
  const subagentType = typeof event.subagent_type === "string" ? event.subagent_type : "";
  const readonly = subagentType.length > 0;
  if (readonly && !subagents.has(subagentType)) return deny();
  if (readTools.has(toolName) || editTools.has(toolName)) return evaluatePathTool(toolName, input, root, readonly);
  if (passiveTools.has(toolName)) return allow();
  if (toolName === "Shell") {
    if (readonly) return deny();
    return evaluateShell({ command: input.command, cwd: input.cwd ?? event.cwd }, root);
  }
  if (toolName === "Task" || toolName === "Agent") {
    const candidate = input.subagent_type ?? input.agent ?? input.name;
    return typeof candidate === "string" && subagents.has(candidate) ? allow() : deny();
  }
  if (!readonly && (toolName.startsWith("MCP:") || toolName.startsWith("mcp__"))) return allow();
  return deny();
}

/**
 * @param {unknown} input
 * @param {{ root: string, executionPolicy: unknown }} context
 * @returns {{ permission: "allow" | "deny", user_message?: string, agent_message?: string }}
 */
export function evaluateCursorHook(input, context) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return deny();
    if (!context || typeof context.root !== "string") return deny();
    const event = /** @type {Record<string, unknown>} */ (input);
    const root = path.resolve(context.root);
    const subagents = allowedSubagents(context.executionPolicy);

    if (event.hook_event_name === "preToolUse") return evaluatePreToolUse(event, root, subagents);
    if (event.hook_event_name === "beforeShellExecution") return evaluateShell(event, root);
    if (event.hook_event_name === "subagentStart") {
      if (typeof event.task !== "string" || event.task.trim().length === 0) return deny();
      if (typeof event.subagent_type !== "string" || typeof event.subagent_model !== "string") return deny();
      return subagents.get(event.subagent_type) === event.subagent_model ? allow() : deny();
    }
    if (event.hook_event_name === "subagentStop") {
      if (typeof event.subagent_type !== "string" || !subagents.has(event.subagent_type)) return deny();
      if (event.status !== "completed" || !Array.isArray(event.modified_files) || event.modified_files.length > 0) return deny();
      return allow();
    }
    if (event.hook_event_name === "afterFileEdit") {
      if (typeof event.file_path !== "string") return deny();
      const { outside, relative } = repositoryPath(root, event.file_path);
      return outside || isSensitivePath(relative) || isProtectedWrite(relative) ? deny() : allow();
    }
    return deny();
  } catch {
    return deny();
  }
}

/**
 * @param {{ stdin?: AsyncIterable<unknown>, stdout?: { write(value: string): unknown }, stderr?: { write(value: string): unknown }, root?: string }} [options]
 */
export async function runCli(options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const root = path.resolve(options.root ?? defaultRoot);
  let raw = "";
  try {
    for await (const chunk of stdin) raw += String(chunk);
    const input = JSON.parse(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid hook input.");
    const executionPolicy = await loadExecutionPolicy(root);
    stdout.write(`${JSON.stringify(evaluateCursorHook(input, { root, executionPolicy }))}\n`);
    return 0;
  } catch {
    stdout.write(`${JSON.stringify(deny())}\n`);
    stderr.write("Cursor hook input or configuration was rejected.\n");
    return 2;
  }
}

export async function runDeterministicCheck(root = defaultRoot) {
  const executionPolicy = await loadExecutionPolicy(root);
  const fixtures = [
    [{ hook_event_name: "subagentStart", subagent_type: "change-evaluator-anthropic", subagent_model: "claude-opus-5", task: "Review the exact packet" }, "allow"],
    [{ hook_event_name: "subagentStart", subagent_type: "change-evaluator-anthropic", subagent_model: "gpt-5.6-sol", task: "Review the exact packet" }, "deny"],
    [{ hook_event_name: "preToolUse", tool_name: "Write", tool_input: { path: ".env.local", contents: "redacted fixture" } }, "deny"],
    [{ hook_event_name: "beforeShellExecution", command: "env", cwd: root, sandbox: false }, "deny"],
    [{ hook_event_name: "beforeShellExecution", command: "npm test -- guard-cursor-hook", cwd: root, sandbox: false }, "allow"],
  ];
  for (const [input, expected] of fixtures) {
    if (evaluateCursorHook(input, { root, executionPolicy }).permission !== expected) return false;
  }
  return true;
}

if (path.resolve(process.argv[1] ?? "") === modulePath) {
  if (process.argv.slice(2).includes("--check")) {
    runDeterministicCheck().then((valid) => {
      if (!valid) process.exitCode = 1;
    }).catch(() => {
      process.stderr.write("Cursor hook deterministic check failed.\n");
      process.exitCode = 1;
    });
  } else {
    runCli().then((status) => {
      process.exitCode = status;
    }).catch(() => {
      process.stdout.write(`${JSON.stringify(deny())}\n`);
      process.exitCode = 2;
    });
  }
}
