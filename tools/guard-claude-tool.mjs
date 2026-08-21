import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const readTools = new Set(["Glob", "Grep", "LS", "NotebookRead", "Read"]);
const editTools = new Set(["Edit", "MultiEdit", "NotebookEdit", "Write"]);
const passiveTools = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TodoWrite",
]);
const allowedAgents = new Set(["change-evaluator", "supabase-auditor"]);
const protectedFiles = new Set([
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".mcp.json",
  ".gitattributes",
  ".gitignore",
  ".node-version",
  ".npmrc",
  ".nvmrc",
  "AGENTS.md",
  "CLAUDE.md",
  "eslint.config.mjs",
  "package-lock.json",
  "package.json",
  "config/ownership.json",
  "tsconfig.json",
  "vitest.config.mjs",
  "tools/guard-claude-tool.mjs",
].map((value) => value.toLowerCase()));
const protectedPrefixes = [
  ".claude",
  ".codex",
  ".git",
  ".github",
  "config",
  "docs",
  "specs",
  "tools",
];

/**
 * @typedef ToolEvent
 * @property {string} [tool_name]
 * @property {Record<string, unknown>} [tool_input]
 * @property {string} [cwd]
 */

/** @param {string} reason */
function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function allow() {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
}

/** @param {string} projectRoot @param {string} candidate */
function normalizeRelative(projectRoot, candidate) {
  const resolved = path.resolve(projectRoot, candidate || ".");
  const relative = path.relative(projectRoot, resolved).replaceAll("\\", "/");
  const outside = relative === ".." || relative.startsWith("../") || path.isAbsolute(relative);
  return { outside, relative: relative || "." };
}

/** @param {Record<string, unknown>} input @returns {string[]} */
function candidatePaths(input) {
  /** @type {string[]} */
  const paths = [];
  for (const value of [input.file_path, input.notebook_path, input.path]) {
    if (typeof value === "string" && value.length > 0) {
      paths.push(value);
    }
  }
  return paths;
}

/** @param {string} relative */
function isSensitivePath(relative) {
  const normalized = relative.toLowerCase();
  const segments = normalized.split("/");
  const filename = segments.at(-1) ?? "";

  if (segments.includes(".git") || segments.includes(".ssh") || segments.includes(".aws")) {
    return true;
  }
  if (normalized.includes("/.config/gh/") || normalized.includes("/.config/supabase/")) {
    return true;
  }
  if (filename === ".env.example") {
    return false;
  }
  return (
    filename === ".env" ||
    filename.startsWith(".env.") ||
    filename.endsWith(".pem") ||
    filename.endsWith(".key") ||
    filename === "credentials" ||
    filename === "credentials.json"
  );
}

/** @param {string} relative */
function isProtectedPath(relative) {
  const normalized = relative.toLowerCase();
  return protectedFiles.has(normalized) || protectedPrefixes.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

/**
 * @param {string} toolName
 * @param {Record<string, unknown>} input
 * @param {string} projectRoot
 */
function inspectPaths(toolName, input, projectRoot) {
  const paths = candidatePaths(input);
  if ((editTools.has(toolName) || toolName === "Read" || toolName === "NotebookRead") && paths.length === 0) {
    return deny(`${toolName} requires an explicit repository path.`);
  }
  for (const candidate of paths) {
    const { outside, relative } = normalizeRelative(projectRoot, candidate);
    if (outside) {
      return deny(`${toolName} is limited to files inside the repository.`);
    }
    if (isSensitivePath(relative)) {
      return deny(`${toolName} cannot access credential or secret path: ${relative}.`);
    }
    if (editTools.has(toolName) && isProtectedPath(relative)) {
      return deny(`${relative} is Codex-owned policy and cannot be changed by Claude.`);
    }
  }
  return null;
}

/** @param {ToolEvent} event @param {{ projectRoot?: string }} [options] */
export function evaluateToolUse(event, options = {}) {
  const projectRoot = path.resolve(
    options.projectRoot ?? process.env.CLAUDE_PROJECT_DIR ?? event.cwd ?? process.cwd(),
  );
  const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
  const input = event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};

  if (toolName.startsWith("mcp__")) {
    return deny("All MCP tools are reserved for Codex to protect the personal-account boundary.");
  }

  if (readTools.has(toolName) || editTools.has(toolName)) {
    return inspectPaths(toolName, input, projectRoot) ?? allow();
  }

  if (passiveTools.has(toolName)) {
    return allow();
  }

  if (toolName === "Agent" || toolName === "Task") {
    const agentName = input.subagent_type ?? input.agent ?? input.name;
    if (typeof agentName === "string" && allowedAgents.has(agentName)) {
      return allow();
    }
    return deny("Only generated read-only evaluator agents may be spawned from this repository.");
  }

  if (toolName === "Bash") {
    return deny("Claude shell execution is disabled. Codex runs all local validation and external operations.");
  }

  return deny(`Tool ${toolName || "<unknown>"} is not in the repository allowlist.`);
}

export async function runCli() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  try {
    const event = JSON.parse(raw);
    process.stdout.write(`${JSON.stringify(evaluateToolUse(event))}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify(deny("Invalid hook input; failing closed."))}\n`);
  }
}

if (path.resolve(process.argv[1] ?? "") === modulePath) {
  runCli().catch(() => {
    process.stdout.write(`${JSON.stringify(deny("Guard failure; failing closed."))}\n`);
  });
}
