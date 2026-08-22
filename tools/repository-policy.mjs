import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCredentialEvidence } from "./template-core.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(modulePath), "..");
const requiredFiles = [
  ".claude/settings.json",
  ".codex/agents/change-evaluator.toml",
  ".codex/agents/supabase-auditor.toml",
  ".cursor/hooks.json",
  ".cursor/environment.json",
  ".cursor/Dockerfile",
  ".gitattributes",
  ".github/pull_request_template.md",
  ".github/workflows/review-gate.yml",
  "AGENTS.md",
  "CLAUDE.md",
  "config/agents.json",
  "config/execution.json",
  "config/deployment.json",
  "config/domain.json",
  "config/github-ruleset.json",
  "config/ownership.json",
  "config/review-contract.schema.json",
  "config/template.json",
  "config/workflow.json",
  "docs/agent-contracts/review-packet.md",
  "docs/authority.md",
  "docs/deployment.md",
  "docs/domain.md",
  "docs/activation.md",
  "docs/onboarding-cursor-cloud.md",
  "docs/onboarding-macos.md",
  "docs/workflow.md",
  "tools/issue-workflow.mjs",
  "tools/github-review-gate.mjs",
  "tools/guard-cursor-hook.mjs",
  "tools/cursor-cloud-doctor.mjs",
  "tools/workstation-doctor.mjs",
  "tools/run-next-dev.mjs",
  "tools/run-next-start.mjs",
  "tools/deployment-core.mjs",
  "tools/deployment-workflow.mjs",
  "tools/domain-core.mjs",
  "tools/domain-workflow.mjs",
  "tools/workflow-core.mjs",
  "specs/acceptance.md",
  "tests/domain-workflow.test.mjs",
  "tests/workstation-doctor.test.mjs",
];
/** @param {unknown} value @returns {unknown} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

/** @param {unknown} left @param {unknown} right */
function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** @param {string} root @returns {string[]} */
function collectTrackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
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
  return findCredentialEvidence(content).length > 0;
}

/** @param {{ authority: string, decisions: string }} input */
export function validateCursorAuthorityDocumentation(input) {
  const errors = [];
  if (!/^\| `cursor-cloud` \| approved provider operator only after live owner-authenticated activation \|$/mu.test(input.authority)) {
    errors.push("docs/authority.md must name cursor-cloud as an approved operator only after live owner-authenticated activation.");
  }
  if (!/^\| `claude-local` \| denied \|$/mu.test(input.authority)) {
    errors.push("docs/authority.md must keep claude-local denied provider authority.");
  }
  const decision = /^## D-007:[^\n]*\n([\s\S]*?)(?=^## D-|(?![\s\S]))/mu.exec(input.decisions)?.[1] ?? "";
  if (
    !decision.includes("- Status: accepted") ||
    !decision.includes("- Supersedes: D-003 only for an activated, owner-authenticated `cursor-cloud` execution surface.") ||
    !decision.includes("`codex-local` authority and `claude-local` denial remain unchanged.")
  ) {
    errors.push("specs/decisions.md must accept a narrow D-003 supersession for activated owner-authenticated Cursor Cloud.");
  }
  return errors;
}

const requiredCursorHookEvents = [
  "preToolUse",
  "beforeShellExecution",
  "subagentStart",
  "subagentStop",
  "afterFileEdit",
];
const canonicalCursorFamilies = ["anthropic", "openai"];
const canonicalCursorRoles = ["change-evaluator", "consultant", "supabase-auditor"];
const canonicalCursorEnvironment = {
  build: { dockerfile: "Dockerfile", context: ".." },
  install: "npm ci && npm exec -- playwright install --with-deps chromium && npm run cursor:doctor -- --build",
  start: "sudo service docker start",
};
const canonicalCursorDockerfile = `FROM node:24.13.0-bookworm

RUN apt-get update \\
    && apt-get install -y --no-install-recommends \\
      ca-certificates \\
      curl \\
      docker.io \\
      git \\
      ripgrep \\
    && npm install --global npm@11.6.2 \\
    && rm -rf /var/lib/apt/lists/*`;

/** @param {unknown} value */
function containsSecretShape(value) {
  if (Array.isArray(value)) return value.some(containsSecretShape);
  if (!value || typeof value !== "object") {
    return typeof value === "string" && containsPotentialSecret(value);
  }
  return Object.entries(value).some(([key, child]) => (
    /(?:token|secret|password|credential|api[_-]?key|private[_-]?key|cookie|auth)/iu.test(key) ||
    containsSecretShape(child)
  ));
}

/**
 * @param {{ environmentConfig: unknown, dockerfile: unknown, packageJson: unknown }} input
 */
export function validateCursorEnvironmentPolicy(input) {
  const errors = [];
  const environmentConfig = input.environmentConfig;
  if (!equal(environmentConfig, canonicalCursorEnvironment)) {
    errors.push(".cursor/environment.json must contain only the exact build, install, and start contract.");
  }
  if (containsSecretShape(environmentConfig)) {
    errors.push(".cursor/environment.json must not contain secret-shaped fields or values.");
  }

  const dockerfile = typeof input.dockerfile === "string" ? input.dockerfile : "";
  const logicalDockerfile = dockerfile.endsWith("\n") ? dockerfile.slice(0, -1) : dockerfile;
  if (logicalDockerfile !== canonicalCursorDockerfile) {
    errors.push(".cursor/Dockerfile must exactly match the canonical public toolchain definition.");
  }

  const packageJson = input.packageJson && typeof input.packageJson === "object"
    ? /** @type {{ scripts?: Record<string, unknown> }} */ (input.packageJson)
    : {};
  if (
    packageJson.scripts?.["cursor:doctor"] !== "node tools/cursor-cloud-doctor.mjs" ||
    Object.values(packageJson.scripts ?? {}).some(
      (script) => typeof script === "string" && script.includes("--activation-input") && script !== packageJson.scripts?.["cursor:doctor"],
    )
  ) {
    errors.push("package.json must expose the non-activating Cursor Cloud doctor.");
  }
  return errors;
}

/** @param {string} configured */
function configuredBaseModel(configured) {
  const match = /^(.*)\[[^\[\]]+\]$/u.exec(configured);
  return match ? match[1] : configured;
}

/** @param {string} content */
function cursorAgentFrontmatter(content) {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end < 0 || content.slice(end + 5).trim().length === 0) return null;
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of content.slice(4, end).split("\n")) {
    const match = /^(name|model|readonly):\s*(\S.*)$/u.exec(line);
    if (!match) continue;
    if (Object.hasOwn(fields, match[1])) return null;
    fields[match[1]] = match[2];
  }
  return fields;
}

/**
 * @param {{
 *   hooksConfig: unknown,
 *   packageJson: unknown,
 *   agentsConfig: unknown,
 *   executionPolicy: unknown,
 *   cursorAgentFiles: string[],
 *   cursorAgentContents: Record<string, string>,
 * }} input
 */
export function validateCursorHookPolicy(input) {
  const errors = [];
  const hooksConfig = input.hooksConfig && typeof input.hooksConfig === "object"
    ? /** @type {Record<string, unknown>} */ (input.hooksConfig)
    : {};
  const hooks = hooksConfig.hooks && typeof hooksConfig.hooks === "object" && !Array.isArray(hooksConfig.hooks)
    ? /** @type {Record<string, unknown>} */ (hooksConfig.hooks)
    : {};
  const hookNames = Object.keys(hooks);

  if (hooksConfig.version !== 1 || !equal(hookNames.toSorted(), requiredCursorHookEvents.toSorted())) {
    errors.push("Cursor Cloud project hooks must not claim unsupported hook coverage.");
  }
  if (hookNames.includes("beforeMCPExecution") || hookNames.includes("afterMCPExecution")) {
    if (!errors.includes("Cursor Cloud project hooks must not claim unsupported hook coverage.")) {
      errors.push("Cursor Cloud project hooks must not claim unsupported hook coverage.");
    }
  }

  for (const event of requiredCursorHookEvents) {
    const entries = hooks[event];
    const entry = Array.isArray(entries) && entries.length === 1 && entries[0] && typeof entries[0] === "object"
      ? /** @type {Record<string, unknown>} */ (entries[0])
      : null;
    const validKeys = entry && Object.keys(entry).every((key) => ["command", "failClosed", "timeout", "type"].includes(key));
    if (
      !entry ||
      entry.type !== "command" ||
      entry.command !== "node tools/guard-cursor-hook.mjs" ||
      !Number.isInteger(entry.timeout) ||
      Number(entry.timeout) <= 0 ||
      Number(entry.timeout) > 60 ||
      entry.failClosed !== true ||
      !validKeys
    ) {
      errors.push(`Cursor hook ${event} must be a finite fail-closed project command.`);
    }
  }

  if (containsPotentialSecret(JSON.stringify(hooksConfig))) {
    errors.push("Cursor hook configuration must not contain credential values.");
  }

  const packageJson = input.packageJson && typeof input.packageJson === "object"
    ? /** @type {{ scripts?: Record<string, unknown> }} */ (input.packageJson)
    : {};
  if (packageJson.scripts?.["cursor:hook-check"] !== "node tools/guard-cursor-hook.mjs --check") {
    errors.push("package.json must expose the deterministic Cursor hook check.");
  }

  const agentsConfig = input.agentsConfig && typeof input.agentsConfig === "object"
    ? /** @type {{ cursor?: { families?: unknown, roles?: unknown } }} */ (input.agentsConfig)
    : {};
  const executionPolicy = input.executionPolicy && typeof input.executionPolicy === "object"
    ? /** @type {{ cursorModels?: Record<string, unknown>, modelFamilies?: Record<string, unknown> }} */ (input.executionPolicy)
    : {};
  const families = Array.isArray(agentsConfig.cursor?.families)
    ? agentsConfig.cursor.families.filter((family) => typeof family === "string")
    : [];
  const roles = Array.isArray(agentsConfig.cursor?.roles)
    ? agentsConfig.cursor.roles
      .map((role) => role && typeof role === "object" && "slug" in role ? role.slug : null)
      .filter((slug) => typeof slug === "string")
    : [];
  if (
    !equal(families.toSorted(), canonicalCursorFamilies) ||
    families.length !== canonicalCursorFamilies.length ||
    !equal(roles.toSorted(), canonicalCursorRoles) ||
    roles.length !== canonicalCursorRoles.length
  ) {
    errors.push("Cursor agent roles and families must match the canonical nonempty sets.");
  }
  const modelsValid = canonicalCursorFamilies.every((family) => {
    const configured = executionPolicy.cursorModels?.[family];
    const patterns = executionPolicy.modelFamilies?.[family];
    return typeof configured === "string" && Array.isArray(patterns) && patterns.length > 0 && patterns.every(
      (source) => typeof source === "string",
    ) && patterns.some((source) => new RegExp(source, "u").test(configuredBaseModel(configured)));
  });
  if (!modelsValid) errors.push("Cursor configured models must match their canonical families.");
  const expectedAgents = canonicalCursorRoles.flatMap(
    (role) => canonicalCursorFamilies.map((family) => `${role}-${family}.md`),
  ).toSorted();
  if (!modelsValid || !equal(input.cursorAgentFiles.toSorted(), expectedAgents)) {
    errors.push(".cursor/agents must contain exactly the generated Cursor agent set.");
  }
  const contents = input.cursorAgentContents && typeof input.cursorAgentContents === "object"
    ? input.cursorAgentContents
    : {};
  const contentValid = modelsValid && expectedAgents.length === 6 && expectedAgents.every((filename) => {
    const content = contents[filename];
    if (typeof content !== "string") return false;
    const fields = cursorAgentFrontmatter(content);
    const name = filename.replace(/\.md$/u, "");
    const family = canonicalCursorFamilies.find((candidate) => name.endsWith(`-${candidate}`));
    return fields?.name === name && fields.readonly === "true" && typeof family === "string" &&
      fields.model === executionPolicy.cursorModels?.[family];
  });
  if (!contentValid) {
    errors.push(".cursor/agents content must preserve canonical name, model, and readonly frontmatter.");
  }
  return errors;
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
  const authority = await readFile(path.join(root, "docs", "authority.md"), "utf8");
  const decisions = await readFile(path.join(root, "specs", "decisions.md"), "utf8");
  errors.push(...validateCursorAuthorityDocumentation({ authority, decisions }));
  const template = JSON.parse(await readFile(path.join(root, "config", "template.json"), "utf8"));
  const project = template.project ?? {};
  if (!equal(ownership.github, project.github)) {
    errors.push("config/ownership.json GitHub ownership does not match config/template.json.");
  }
  if (!equal(ownership.supabase, project.ownership?.supabase)) {
    errors.push("config/ownership.json Supabase ownership does not match config/template.json.");
  }
  if (!equal(ownership.vercel, project.ownership?.vercel)) {
    errors.push("config/ownership.json Vercel ownership does not match config/template.json.");
  }
  const expectedCloudflare = project.ownership?.cloudflare;
  let expectedHostname;
  try {
    expectedHostname = new URL(project.publicUrls?.production).hostname;
  } catch {
    errors.push("config/template.json has an invalid production URL.");
  }
  if (
    ownership.cloudflare?.accountId !== expectedCloudflare?.accountId ||
    ownership.cloudflare?.accountName !== expectedCloudflare?.accountName ||
    ownership.cloudflare?.zoneId !== expectedCloudflare?.zoneId ||
    ownership.cloudflare?.domains?.length !== 1 ||
    ownership.cloudflare.domains[0] !== expectedHostname
  ) {
    errors.push("config/ownership.json Cloudflare ownership does not match config/template.json.");
  }

  const agents = /** @type {{ schemaVersion?: number, reviewContract?: string, agents?: Array<{ slug: string }>, cursor?: { families?: string[], roles?: Array<{ slug?: string }> } }} */ (
    JSON.parse(await readFile(path.join(root, "config", "agents.json"), "utf8"))
  );
  const slugs = agents.agents?.map((agent) => agent.slug) ?? [];
  if (slugs.join(",") !== "change-evaluator,supabase-auditor") {
    errors.push("The initial evaluator set must contain only change-evaluator and supabase-auditor.");
  }
  if (agents.schemaVersion !== 2 || agents.reviewContract !== "config/review-contract.schema.json") {
    errors.push("config/agents.json must use schema version 2 and the canonical review contract.");
  }
  const reviewSchema = JSON.parse(await readFile(path.join(root, "config", "review-contract.schema.json"), "utf8"));
  const reviewProperties = Object.keys(reviewSchema.properties ?? {}).sort();
  const expectedReviewProperties = [...(reviewSchema.required ?? []), "unavailableReason"].sort();
  if (reviewSchema.additionalProperties !== false || reviewProperties.join(",") !== expectedReviewProperties.join(",")) {
    errors.push("The review JSON schema must be strict and keep required/optional properties synchronized.");
  }

  const workflow = JSON.parse(await readFile(path.join(root, "config", "workflow.json"), "utf8"));
  const states = /** @type {string[]} */ (Array.isArray(workflow.states) ? workflow.states : []);
  const stateSet = new Set(states);
  if (stateSet.size !== states.length) errors.push("config/workflow.json states must be unique.");
  if (workflow.reviewerMap?.codex !== "claude" || workflow.reviewerMap?.claude !== "codex") {
    errors.push("config/workflow.json must map each primary model to the opposite reviewer.");
  }
  if (workflow.baseRef !== "main") errors.push("config/workflow.json must derive review scope from main.");
  const reviewGate = workflow.githubReviewGate;
  if (reviewGate?.checkName !== "Exact Head review policy") {
    errors.push("GitHub review gate must keep the required check name stable.");
  }
  if (
    reviewGate?.dependabot?.userId !== 49699333 ||
    reviewGate?.dependabot?.login !== "dependabot[bot]" ||
    reviewGate?.dependabot?.userType !== "Bot" ||
    reviewGate?.dependabot?.headPrefix !== "dependabot/github_actions/" ||
    !equal(reviewGate?.dependabot?.allowedActions, ["actions/checkout", "actions/setup-node"]) ||
    !equal(reviewGate?.dependabot?.allowedPathPrefixes, [".github/workflows/"])
  ) {
    errors.push("Dependabot review exception must remain pinned to the GitHub Actions bot and allowlist.");
  }
  const githubRuleset = JSON.parse(await readFile(path.join(root, "config", "github-ruleset.json"), "utf8"));
  const statusRule = githubRuleset.rules?.find(/** @param {{type?: string}} rule */ (rule) => rule.type === "required_status_checks");
  const pullRequestRule = githubRuleset.rules?.find(/** @param {{type?: string}} rule */ (rule) => rule.type === "pull_request");
  if (
    githubRuleset.name !== "main exact-Head review" ||
    githubRuleset.target !== "branch" ||
    githubRuleset.enforcement !== "active" ||
    !equal(githubRuleset.conditions?.ref_name, { include: ["~DEFAULT_BRANCH"], exclude: [] }) ||
    !equal(statusRule?.parameters?.required_status_checks, [
      { context: "Repository checks", integration_id: 15368 },
      { context: "Database and Auth policy checks", integration_id: 15368 },
      { context: "macOS onboarding and browser checks", integration_id: 15368 },
      { context: "Exact Head review policy", integration_id: 15368 },
    ]) ||
    statusRule?.parameters?.strict_required_status_checks_policy !== true ||
    pullRequestRule?.parameters?.required_approving_review_count !== 0 ||
    !equal(pullRequestRule?.parameters?.allowed_merge_methods, ["squash"])
  ) {
    errors.push("GitHub ruleset export must require the strict exact-Head check and squash pull requests on main.");
  }
  for (const state of states.filter((state) => !state.startsWith("blocked:") && state !== "paused")) {
    if (!Array.isArray(workflow.transitions?.[state])) errors.push(`Workflow state ${state} needs a transition list.`);
  }
  for (const [state, targets] of Object.entries(workflow.transitions ?? {})) {
    if (!stateSet.has(state)) errors.push(`Workflow transition source is unknown: ${state}.`);
    for (const target of /** @type {string[]} */ (targets)) {
      if (!stateSet.has(target)) errors.push(`Workflow transition target is unknown: ${target}.`);
    }
  }
  for (const rule of workflow.privilegedPathRules ?? []) {
    if (!["prefix", "exact"].includes(rule.type) || typeof rule.path !== "string" || rule.path !== rule.path.toLowerCase()) {
      errors.push("Workflow privileged path rules must use lower-case exact/prefix canonical paths.");
    }
    if (!Array.isArray(rule.contracts) || rule.contracts.some(/** @param {string} contract */ (contract) => !slugs.includes(contract))) {
      errors.push(`Workflow path rule uses an unknown review contract: ${rule.path ?? "<missing>"}.`);
    }
  }

  const expectedClaudeAgents = slugs.map((slug) => `${slug}.md`).sort();
  const expectedCodexAgents = slugs.map((slug) => `${slug}.toml`).sort();
  const actualClaudeAgents = (await readdir(path.join(root, ".claude", "agents"))).sort();
  const actualCodexAgents = (await readdir(path.join(root, ".codex", "agents"))).sort();
  const actualCursorAgents = (await readdir(path.join(root, ".cursor", "agents"))).sort();
  const actualCursorAgentContents = Object.fromEntries(await Promise.all(actualCursorAgents.map(async (filename) => [
    filename,
    await readFile(path.join(root, ".cursor", "agents", filename), "utf8"),
  ])));
  if (actualClaudeAgents.join(",") !== expectedClaudeAgents.join(",")) {
    errors.push(".claude/agents must contain exactly the generated evaluator set.");
  }
  if (actualCodexAgents.join(",") !== expectedCodexAgents.join(",")) {
    errors.push(".codex/agents must contain exactly the generated evaluator set.");
  }

  const nodeVersion = (await readFile(path.join(root, ".node-version"), "utf8")).trim();
  const nvmVersion = (await readFile(path.join(root, ".nvmrc"), "utf8")).trim();
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const cursorHooks = JSON.parse(await readFile(path.join(root, ".cursor", "hooks.json"), "utf8"));
  const cursorEnvironment = JSON.parse(await readFile(path.join(root, ".cursor", "environment.json"), "utf8"));
  const cursorDockerfile = await readFile(path.join(root, ".cursor", "Dockerfile"), "utf8");
  const executionPolicy = JSON.parse(await readFile(path.join(root, "config", "execution.json"), "utf8"));
  errors.push(...validateCursorHookPolicy({
    hooksConfig: cursorHooks,
    packageJson,
    agentsConfig: agents,
    executionPolicy,
    cursorAgentFiles: actualCursorAgents,
    cursorAgentContents: actualCursorAgentContents,
  }));
  errors.push(...validateCursorEnvironmentPolicy({
    environmentConfig: cursorEnvironment,
    dockerfile: cursorDockerfile,
    packageJson,
  }));
  if (nodeVersion !== nvmVersion || packageJson.engines?.node !== nodeVersion) {
    errors.push(".node-version, .nvmrc, and package.json engines.node must agree exactly.");
  }
  if (packageJson.packageManager !== "npm@11.6.2") {
    errors.push("package.json must pin npm@11.6.2.");
  }
  if (packageJson.engines?.npm !== packageJson.packageManager.replace(/^npm@/u, "")) {
    errors.push("package.json engines.npm must exactly match packageManager.");
  }
  const packageLock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  if (!equal(packageLock.packages?.[""]?.engines, packageJson.engines)) {
    errors.push("package-lock.json root engines must match package.json.");
  }
  if (packageJson.scripts?.["workstation:doctor"] !== "node tools/workstation-doctor.mjs") {
    errors.push("package.json must expose the cross-platform workstation doctor.");
  }
  const ciWorkflow = await readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  if (!ciWorkflow.includes("runs-on: macos-latest") || !ciWorkflow.includes("npm run workstation:doctor")) {
    errors.push("CI must verify the workstation contract on a real macOS runner.");
  }
  const reviewWorkflow = await readFile(path.join(root, ".github", "workflows", "review-gate.yml"), "utf8");
  const trustedInstallIndex = reviewWorkflow.indexOf("npm ci --ignore-scripts");
  const verificationIndex = reviewWorkflow.indexOf("Verify exact-Head review evidence");
  if (
    !reviewWorkflow.includes("name: Exact Head review policy") ||
    !reviewWorkflow.includes("types: [opened, synchronize, reopened, edited, ready_for_review]") ||
    !reviewWorkflow.includes("ref: ${{ github.event.pull_request.base.sha }}") ||
    !reviewWorkflow.includes('gate_path="trusted/tools/github-review-gate.mjs"') ||
    !reviewWorkflow.includes('workflow_path="trusted/config/workflow.json"') ||
    !reviewWorkflow.includes('execution_policy_path="trusted/config/execution.json"') ||
    !reviewWorkflow.includes("cache-dependency-path: trusted/package-lock.json") ||
    !reviewWorkflow.includes("working-directory: trusted") ||
    trustedInstallIndex === -1 ||
    verificationIndex === -1 ||
    trustedInstallIndex > verificationIndex ||
    /working-directory:\s*candidate[\s\S]{0,160}npm (?:ci|install)/u.test(reviewWorkflow) ||
    /npm (?:--prefix\s+candidate|ci[^\n]*candidate|install[^\n]*candidate)/u.test(reviewWorkflow) ||
    !reviewWorkflow.includes('HEAD_REPOSITORY" != "$BASE_REPOSITORY"') ||
    !reviewWorkflow.includes("github.event.pull_request.head.repo.full_name") ||
    !reviewWorkflow.includes("github.event.pull_request.base.repo.full_name") ||
    !reviewWorkflow.includes("Review gate produced no result.") ||
    reviewWorkflow.includes("pull_request_target") ||
    reviewWorkflow.includes("github.event.pull_request.body") ||
    /^\s*paths:/mu.test(reviewWorkflow) ||
    /^\s*if:/mu.test(reviewWorkflow)
  ) {
    errors.push("Exact-Head GitHub workflow must run from trusted base code on every relevant PR event without body interpolation.");
  }
  const attributes = await readFile(path.join(root, ".gitattributes"), "utf8");
  if (!attributes.includes("* text=auto eol=lf")) {
    errors.push(".gitattributes must establish LF as the default text line ending.");
  }
  const ignore = await readFile(path.join(root, ".gitignore"), "utf8");
  if (!ignore.split(/\r?\n/u).includes(".env")) {
    errors.push(".gitignore must ignore .env.");
  }
  if (!ignore.split(/\r?\n/u).includes(".artifacts/")) {
    errors.push(".gitignore must ignore .artifacts/ domain evidence.");
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
