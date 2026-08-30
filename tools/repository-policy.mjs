import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAuthority, readAuthority } from "./authority-core.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(modulePath), "..");
const requiredFiles = [
  ".claude/agents/change-evaluator.md",
  ".claude/agents/supabase-auditor.md",
  ".claude/settings.json",
  ".codex/agents/change-evaluator.toml",
  ".codex/agents/supabase-auditor.toml",
  ".gitattributes",
  ".github/pull_request_template.md",
  ".github/workflows/review-gate.yml",
  "AGENTS.md",
  "CLAUDE.md",
  "config/agents.json",
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
  "docs/onboarding-macos.md",
  "docs/workflow.md",
  "specs/account-bound-authority.md",
  "tools/authority-core.mjs",
  "tools/completion-audit.mjs",
  "tools/generate-agent-wrappers.mjs",
  "tools/issue-workflow.mjs",
  "tools/github-review-gate.mjs",
  "tools/workstation-doctor.mjs",
  "tools/run-next-dev.mjs",
  "tools/run-next-start.mjs",
  "tools/deployment-core.mjs",
  "tools/deployment-workflow.mjs",
  "tools/domain-core.mjs",
  "tools/domain-workflow.mjs",
  "tools/workflow-core.mjs",
  "specs/acceptance.md",
  "tests/authority-core.test.mjs",
  "tests/domain-workflow.test.mjs",
  "tests/operator-parity.test.mjs",
  "tests/workstation-doctor.test.mjs",
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

const actorPattern = /\b(?:claude|codex)\b/iu;
const actorReviewerRolePattern = /\b(?:claude|codex)(?:\s+and\s+(?:claude|codex))?\s+(?:reviewers?|evaluators?|auditors?)\b/iu;
const reviewIndependencePattern = /\b(?:approv(?:e|al|es|ed|ing)|audit(?:or|ors|ed|ing)?|cross[- ]model|evaluat(?:e|or|ors|ed|ing|ion)|review(?:er|ers|ed|ing|s)?)\b/iu;
const operatorSurfacePattern = /\b(?:authenticated|cloudflare|command|deploy(?:ment|ments|ed|ing)?|dns|external\s+(?:operation|operations|service|services)|github|mcp|provider|shell|supabase|tool|tools|vercel)\b/iu;
const actorRestrictionPattern = /\b(?:alone|barred|belongs?\s+to|cannot|can(?:['’]t)|delegat(?:e|es|ed|ing|ion|ions)|den(?:y|ies|ied)|disallow(?:ed|s)?|exclusive|exclusively|forbid(?:den|s)?|hand[- ]?off|limited\s+to|may\s+not|must\s+not|mustn(?:['’]t)|not\s+allowed|only|owned|owner|ownership|owns|prohibit(?:ed|s|ion)?|remains?\s+(?:an?\s+)?(?:claude|codex)\s+(?:operation|operator|work)|reserved|restricted|shall\s+not|sole|stays?\s+with)\b/iu;
const canonicalOperatorParityPattern = /\bclaude\b[^.!?。！？\n]{0,160}\bhas\s+the\s+same\s+account-bound\s+authority\s+as\s+codex\b/iu;

/** @param {string} content */
export function detectActorAsymmetry(content) {
  if (/guard-claude-tool\.mjs/iu.test(content)) {
    return "Actor-specific Claude guard policy remains.";
  }

  const clauses = content.split(/[.!?。！？;\n]+/u);
  for (const clause of clauses) {
    if (!actorPattern.test(clause) || !actorRestrictionPattern.test(clause)) {
      continue;
    }
    if (actorReviewerRolePattern.test(clause)) {
      continue;
    }
    if (reviewIndependencePattern.test(clause) && !operatorSurfacePattern.test(clause)) {
      continue;
    }
    return `Actor-specific operator delegation, ownership, or restriction remains: ${clause.trim()}`;
  }
  return null;
}

/** @param {string} content */
export function hasCanonicalOperatorParityStatement(content) {
  return canonicalOperatorParityPattern.test(content);
}

/**
 * @param {{
 *   claudeSettings: Record<string, unknown>,
 *   generatorSource: string,
 *   generatedAssets: Map<string, string>,
 *   canonicalSurfaces?: Map<string, string>,
 * }} input
 */
export function operatorParityErrors({
  claudeSettings,
  generatorSource,
  generatedAssets,
  canonicalSurfaces = new Map(),
}) {
  const errors = [];
  const permissions = claudeSettings.permissions && typeof claudeSettings.permissions === "object"
    ? claudeSettings.permissions
    : {};
  const hooks = claudeSettings.hooks && typeof claudeSettings.hooks === "object"
    ? claudeSettings.hooks
    : {};
  if (Array.isArray(permissions.deny) && permissions.deny.length > 0) {
    errors.push("Claude project settings must not contain model-specific deny rules.");
  }
  if (Array.isArray(hooks.PreToolUse) && hooks.PreToolUse.length > 0) {
    errors.push("Claude project settings must not contain a PreToolUse policy hook.");
  }

  const generatedClaude = generatedAssets.get("CLAUDE.md");
  const sources = new Map([
    [".claude/settings.json", JSON.stringify(claudeSettings)],
    ["tools/generate-agent-wrappers.mjs", generatorSource],
    ...(typeof generatedClaude === "string" ? [["CLAUDE.md", generatedClaude]] : []),
    ...canonicalSurfaces,
  ]);
  for (const [relativePath, content] of sources) {
    const asymmetry = detectActorAsymmetry(content);
    if (asymmetry) {
      errors.push(`${relativePath}: ${asymmetry}`);
    }
  }
  for (const relativePath of ["tools/generate-agent-wrappers.mjs", "CLAUDE.md"]) {
    const content = sources.get(relativePath);
    if (typeof content !== "string" || !hasCanonicalOperatorParityStatement(content)) {
      const surface = relativePath === "CLAUDE.md"
        ? "generated CLAUDE.md"
        : `generator source (${relativePath})`;
      errors.push(`Canonical operator equality statement is missing from ${surface}.`);
    }
  }
  return errors;
}

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

  const ownership = readAuthority(root);
  const template = JSON.parse(await readFile(path.join(root, "config", "template.json"), "utf8"));
  const project = template.project ?? {};
  let templateAuthority;
  try {
    templateAuthority = parseAuthority({
      schemaVersion: project.schemaVersion,
      authorization: project.authorization,
      accounts: project.accounts,
      servicePolicies: project.servicePolicies,
      resourceTargets: project.resourceTargets,
      observations: project.observations,
    });
  } catch {
    errors.push("config/template.json contains invalid authority configuration.");
  }
  if (templateAuthority && !equal(ownership.authorization, templateAuthority.authorization)) {
    errors.push("config/ownership.json authorization does not match config/template.json.");
  }
  for (const service of ["github", "supabase", "vercel", "cloudflare", "linear"]) {
    if (templateAuthority && !equal(ownership.accounts[service], templateAuthority.accounts[service])) {
      errors.push(`config/ownership.json ${service} account does not match config/template.json.`);
    }
    if (templateAuthority && !equal(ownership.servicePolicies[service], templateAuthority.servicePolicies[service])) {
      errors.push(`config/ownership.json ${service} service policy does not match config/template.json.`);
    }
    if (templateAuthority && !equal(ownership.resourceTargets[service], templateAuthority.resourceTargets[service])) {
      errors.push(`config/ownership.json ${service} resource target does not match config/template.json.`);
    }
  }
  let expectedHostname;
  try {
    expectedHostname = new URL(project.publicUrls?.production).hostname;
  } catch {
    errors.push("config/template.json has an invalid production URL.");
  }
  if (ownership.resourceTargets.cloudflare.domains.length !== 1 || ownership.resourceTargets.cloudflare.domains[0] !== expectedHostname) {
    errors.push("config/ownership.json Cloudflare ownership does not match config/template.json.");
  }

  const agents = /** @type {{ schemaVersion?: number, reviewContract?: string, agents?: Array<{ slug: string }> }} */ (
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
  if (actualClaudeAgents.join(",") !== expectedClaudeAgents.join(",")) {
    errors.push(".claude/agents must contain exactly the generated evaluator set.");
  }
  if (actualCodexAgents.join(",") !== expectedCodexAgents.join(",")) {
    errors.push(".codex/agents must contain exactly the generated evaluator set.");
  }

  const nodeVersion = (await readFile(path.join(root, ".node-version"), "utf8")).trim();
  const nvmVersion = (await readFile(path.join(root, ".nvmrc"), "utf8")).trim();
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
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
  if (
    !reviewWorkflow.includes("name: Exact Head review policy") ||
    !reviewWorkflow.includes("types: [opened, synchronize, reopened, edited, ready_for_review]") ||
    !reviewWorkflow.includes("ref: ${{ github.event.pull_request.base.sha }}") ||
    !reviewWorkflow.includes('BASE_SHA" != "62da0e1699ddfcf39f35914b54ad963fe5aa0740"') ||
    !reviewWorkflow.includes('HEAD_REF" != "codex/22-exact-head-review"') ||
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

  const claudeSettings = JSON.parse(await readFile(path.join(root, ".claude", "settings.json"), "utf8"));
  const generatorSource = await readFile(path.join(root, "tools", "generate-agent-wrappers.mjs"), "utf8");
  const generatedAssets = new Map([
    ["CLAUDE.md", await readFile(path.join(root, "CLAUDE.md"), "utf8")],
  ]);
  for (const slug of slugs) {
    generatedAssets.set(
      `.claude/agents/${slug}.md`,
      await readFile(path.join(root, ".claude", "agents", `${slug}.md`), "utf8"),
    );
    generatedAssets.set(
      `.codex/agents/${slug}.toml`,
      await readFile(path.join(root, ".codex", "agents", `${slug}.toml`), "utf8"),
    );
  }
  const canonicalSurfaces = new Map([
    ["tools/completion-audit.mjs", await readFile(path.join(root, "tools", "completion-audit.mjs"), "utf8")],
  ]);
  errors.push(...operatorParityErrors({
    claudeSettings,
    generatorSource,
    generatedAssets,
    canonicalSurfaces,
  }));

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
