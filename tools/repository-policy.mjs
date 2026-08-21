import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(modulePath), "..");
const requiredFiles = [
  ".claude/settings.json",
  ".codex/agents/change-evaluator.toml",
  ".codex/agents/supabase-auditor.toml",
  ".gitattributes",
  "AGENTS.md",
  "CLAUDE.md",
  "config/agents.json",
  "config/ownership.json",
  "docs/authority.md",
  "specs/acceptance.md",
];
const secretPatterns = [
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/u,
  /\bsbp_[A-Za-z0-9]{20,}\b/u,
  /\bsb_secret_[A-Za-z0-9_-]{20,}\b/u,
  /\bsk_live_[A-Za-z0-9]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /(?:SERVICE_ROLE|SUPABASE_SERVICE_ROLE_KEY)\s*[:=]\s*["']?eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/iu,
  /\bv1\.0-[A-Za-z0-9_-]{40,}\b/u,
];

/** @param {string} root @returns {string[]} */
function collectTrackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("Unable to enumerate tracked files with git ls-files.");
  }
  return result.stdout.split("\0").filter(Boolean);
}

/** @param {string} content */
export function containsPotentialSecret(content) {
  return secretPatterns.some((pattern) => pattern.test(content));
}

/** @param {string} [root] */
export async function validateRepository(root = defaultRoot) {
  const errors = [];

  for (const relative of requiredFiles) {
    try {
      const metadata = await lstat(path.join(root, relative));
      if (!metadata.isFile()) {
        errors.push(`${relative} must be a regular file.`);
      }
    } catch {
      errors.push(`Missing required file: ${relative}.`);
    }
  }

  const ownership = JSON.parse(await readFile(path.join(root, "config", "ownership.json"), "utf8"));
  if (ownership.github?.owner !== "yuto1201" || ownership.github?.repository !== "Web-Template") {
    errors.push("config/ownership.json does not identify yuto1201/Web-Template.");
  }
  if (ownership.supabase?.organizationName !== "yuto1201's Org") {
    errors.push("config/ownership.json has an unexpected Supabase organization.");
  }
  if (ownership.cloudflare?.accountName !== "Yuto Dev") {
    errors.push("config/ownership.json has an unexpected Cloudflare account.");
  }

  const agents = /** @type {{ agents?: Array<{ slug: string }> }} */ (
    JSON.parse(await readFile(path.join(root, "config", "agents.json"), "utf8"))
  );
  const slugs = agents.agents?.map((agent) => agent.slug) ?? [];
  if (slugs.join(",") !== "change-evaluator,supabase-auditor") {
    errors.push("The initial evaluator set must contain only change-evaluator and supabase-auditor.");
  }

  const expectedClaudeAgents = slugs.map((slug) => `${slug}.md`).sort();
  const expectedCodexAgents = slugs.map((slug) => `${slug}.toml`).sort();
  const actualClaudeAgents = (await readdir(path.join(root, ".claude", "agents"))).sort();
  const actualCodexAgents = (await readdir(path.join(root, ".codex", "agents"))).sort();
  if (actualClaudeAgents.join(",") !== expectedClaudeAgents.join(",")) {
    errors.push(".claude/agents must contain exactly the generated evaluator set.");
  }
  if (actualCodexAgents.join(",") !== expectedCodexAgents.join(",")) {
    errors.push(".codex/agents must contain exactly the generated evaluator set.");
  }

  const nodeVersion = (await readFile(path.join(root, ".node-version"), "utf8")).trim();
  const nvmVersion = (await readFile(path.join(root, ".nvmrc"), "utf8")).trim();
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (nodeVersion !== nvmVersion || !packageJson.engines?.node?.includes(nodeVersion)) {
    errors.push(".node-version, .nvmrc, and package.json engines.node must agree.");
  }
  if (packageJson.packageManager !== "npm@11.6.2") {
    errors.push("package.json must pin npm@11.6.2.");
  }
  const attributes = await readFile(path.join(root, ".gitattributes"), "utf8");
  if (!attributes.includes("* text=auto eol=lf")) {
    errors.push(".gitattributes must establish LF as the default text line ending.");
  }
  const ignore = await readFile(path.join(root, ".gitignore"), "utf8");
  if (!ignore.split(/\r?\n/u).includes(".env")) {
    errors.push(".gitignore must ignore .env.");
  }

  const claudeSettings = JSON.parse(
    await readFile(path.join(root, ".claude", "settings.json"), "utf8"),
  );
  if (!claudeSettings.permissions?.deny?.includes("Bash")) {
    errors.push("Claude project settings must deny Bash.");
  }
  const hookCommand = claudeSettings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
  if (
    typeof hookCommand !== "string" ||
    !hookCommand.includes("CLAUDE_PROJECT_DIR") ||
    !hookCommand.includes("tools','guard-claude-tool.mjs") ||
    !hookCommand.includes("process.exit(2)") ||
    !hookCommand.includes("module.runCli()")
  ) {
    errors.push("Claude PreToolUse must locate the guard from the project root and fail closed.");
  }

  for (const relative of collectTrackedFiles(root)) {
    const normalized = relative.toLowerCase();
    if ((normalized === ".env" || normalized.startsWith(".env.")) && normalized !== ".env.example") {
      errors.push(`Secret environment file must not be tracked: ${relative}.`);
      continue;
    }
    if (/\.(?:gif|ico|jpe?g|pdf|png|webp)$/u.test(normalized)) {
      continue;
    }
    let content;
    try {
      content = await readFile(path.join(root, relative), "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (containsPotentialSecret(content)) {
      errors.push(`Possible committed secret in ${relative}.`);
    }
  }

  return errors;
}

if (path.resolve(process.argv[1] ?? "") === modulePath) {
  validateRepository().then((errors) => {
    if (errors.length > 0) {
      for (const error of errors) {
        console.error(error);
      }
      process.exitCode = 1;
    }
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
