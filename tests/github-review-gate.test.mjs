import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateGitHubReviewGate, parseReviewBody } from "../tools/github-review-gate.mjs";

const headSha = "a".repeat(40);
const executionPolicy = JSON.parse(await readFile(path.resolve("config/execution.json"), "utf8"));
const workflow = {
  reviewerMap: { codex: "claude", claude: "codex" },
  privilegedPathRules: [
    { type: "prefix", path: ".github/", contracts: ["change-evaluator"] },
    { type: "prefix", path: "supabase/", contracts: ["change-evaluator", "supabase-auditor"] },
  ],
  githubReviewGate: {
    checkName: "Exact Head review policy",
    dependabot: {
      userId: 49699333,
      login: "dependabot[bot]",
      userType: "Bot",
      headPrefix: "dependabot/github_actions/",
      allowedActions: ["actions/checkout", "actions/setup-node"],
      allowedPathPrefixes: [".github/workflows/"],
    },
  },
};

function reviewBody(override = {}) {
  const values = {
    executionSurface: "cursor-cloud",
    primaryOperatorLabel: "codex",
    primaryConfigured: "composer-2.5",
    primaryObserved: "composer-2.5",
    primaryFamily: "cursor",
    primaryFallback: "false",
    risk: "normal",
    riskReasons: "none",
    sha: headSha,
    reviewers: [
      { family: "anthropic", configured: "claude-opus-5[effort=high]", observed: "claude-opus-5", fallback: "false", verdict: "approved", contracts: "change-evaluator" },
    ],
    ...override,
  };
  const reviews = values.reviewers.map(({ family, configured, observed, fallback, verdict, contracts }) =>
    `- Reviewer ${family}: ${configured} | ${observed} | ${family} | ${fallback} | ${verdict} | ${contracts}`).join("\n");
  return `Closes #29\n\n## Cross-model review\n- Execution surface: ${values.executionSurface}\n- Primary operator label: ${values.primaryOperatorLabel}\n- Primary configured model: ${values.primaryConfigured}\n- Primary observed model: ${values.primaryObserved}\n- Primary family: ${values.primaryFamily}\n- Primary fallback: ${values.primaryFallback}\n- Risk: ${values.risk}\n- Risk reasons: ${values.riskReasons}\n- Reviewed SHA: \`${values.sha}\`\n${reviews}\n\n## External changes\n- None.\n\n## Remaining work\n- None.\n`;
}

function highRiskBody(override = {}) {
  return reviewBody({
    risk: "high",
    riskReasons: "path:.cursor/",
    reviewers: [
      { family: "anthropic", configured: "claude-opus-5[effort=high]", observed: "claude-opus-5", fallback: "false", verdict: "approved", contracts: "change-evaluator" },
      { family: "openai", configured: "gpt-5.6-sol[effort=high]", observed: "gpt-5.6-sol", fallback: "false", verdict: "approved", contracts: "change-evaluator" },
    ],
    ...override,
  });
}

function event(body = reviewBody()) {
  return {
    pull_request: {
      body,
      head: { sha: headSha, ref: "cursor/29-exact-head-review", repo: { full_name: "yuto1201/Web-Template" } },
      base: { sha: "b".repeat(40), repo: { full_name: "yuto1201/Web-Template" } },
      user: { login: "yuto1201", id: 50611866, type: "User" },
    },
  };
}

function dependabotEvent() {
  const value = event("Dependabot generated body");
  value.pull_request.user = { login: "dependabot[bot]", id: 49699333, type: "Bot" };
  value.pull_request.head.ref = "dependabot/github_actions/actions/checkout-7";
  return value;
}

const actionDiff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1 +1 @@\n-        uses: actions/checkout@v6\n+        uses: actions/checkout@v7\n`;

describe("GitHub exact-Head review gate", () => {
  it("parses strict visible version 2 review evidence", () => {
    expect(parseReviewBody(highRiskBody())).toEqual({
      issue: 29,
      executionSurface: "cursor-cloud",
      primaryOperatorLabel: "codex",
      primaryModel: {
        configured: "composer-2.5",
        observed: "composer-2.5",
        family: "cursor",
        fallback: false,
      },
      risk: { level: "high", reasons: ["path:.cursor/"] },
      reviews: [
        { family: "anthropic", configured: "claude-opus-5[effort=high]", observed: "claude-opus-5", fallback: false, verdict: "approved", contracts: ["change-evaluator"] },
        { family: "openai", configured: "gpt-5.6-sol[effort=high]", observed: "gpt-5.6-sol", fallback: false, verdict: "approved", contracts: ["change-evaluator"] },
      ],
      reviewedSha: headSha,
      contracts: ["change-evaluator"],
    });
  });

  it("accepts normal-risk different-family and high-risk dual-family evidence", () => {
    expect(evaluateGitHubReviewGate({ event: event(), changedPaths: ["src/app/page.tsx"], diff: "", workflow, executionPolicy })).toMatchObject({
      ok: true,
      mode: "independent-review",
      headSha,
      reviewers: ["anthropic"],
      risk: "normal",
    });
    expect(evaluateGitHubReviewGate({ event: event(highRiskBody()), changedPaths: [".cursor/hooks.json"], diff: "", workflow, executionPolicy })).toMatchObject({
      ok: true,
      reviewers: ["anthropic", "openai"],
      risk: "high",
    });
    expect(evaluateGitHubReviewGate({
      event: event(reviewBody({ reviewers: [{ family: "anthropic", configured: "claude-opus-5[effort=high]", observed: "claude-opus-5", fallback: "false", verdict: "approved", contracts: "change-evaluator, supabase-auditor" }] })),
      changedPaths: ["README.md"],
      diff: "",
      workflow,
      executionPolicy,
    })).toMatchObject({ ok: true, risk: "normal" });

    const bootstrap = event(highRiskBody({
      executionSurface: "codex-local",
      primaryConfigured: "gpt-5.6-sol",
      primaryObserved: "gpt-5.6-sol",
      primaryFamily: "openai",
    }));
    bootstrap.pull_request.head.ref = "codex/29-cursor-cloud-mode";
    expect(evaluateGitHubReviewGate({
      event: bootstrap,
      changedPaths: [".cursor/hooks.json"],
      diff: "",
      workflow,
      executionPolicy,
    })).toMatchObject({ ok: true, risk: "high", reviewers: ["anthropic", "openai"] });
  });

  it("requires high-risk dual-family evidence for canonical authority documentation", () => {
    expect(() => evaluateGitHubReviewGate({
      event: event(reviewBody()),
      changedPaths: ["docs/authority.md"],
      diff: "",
      workflow,
      executionPolicy,
    })).toThrow(/Risk claim/u);

    expect(evaluateGitHubReviewGate({
      event: event(highRiskBody({ riskReasons: "path:docs/authority.md" })),
      changedPaths: ["docs/authority.md"],
      diff: "",
      workflow,
      executionPolicy,
    })).toMatchObject({ risk: "high", reviewers: ["anthropic", "openai"] });
  });

  it("rejects stale, duplicate, hidden, unknown, ambiguous, and injected claims", () => {
    /** @param {string} body */
    const input = (body) => ({ event: event(body), changedPaths: ["README.md"], diff: "", workflow, executionPolicy });
    expect(() => evaluateGitHubReviewGate(input(reviewBody({ sha: "9".repeat(40) })))).toThrow(/current Head/u);
    expect(() => parseReviewBody(`${reviewBody()}- Reviewed SHA: \`${headSha}\`\n`)).toThrow(/exactly once/u);
    expect(() => parseReviewBody(`${reviewBody()}\n## Cross-model review\n`)).toThrow(/exactly once/u);
    expect(() => parseReviewBody(reviewBody().replace("## Cross-model review", "```text\n## Cross-model review\n```"))).toThrow(/fenced/u);
    expect(() => parseReviewBody(reviewBody().replace("## Cross-model review", "<!--\n## Cross-model review\n-->"))).toThrow(/HTML comment/u);
    expect(() => parseReviewBody(reviewBody().replace("## Cross-model review", "<details>\n## Cross-model review").replace("## Remaining work", "</details>\n\n## Remaining work"))).toThrow(/raw HTML/u);
    expect(() => parseReviewBody(reviewBody().replace("## Cross-model review", "<div>\n## Cross-model review").replace("## Remaining work", "</div>\n\n## Remaining work"))).toThrow(/raw HTML/u);
    expect(() => parseReviewBody(reviewBody().replace("## Cross-model review", "<details/>\n## Cross-model review"))).toThrow(/raw HTML/u);
    expect(() => parseReviewBody(reviewBody().replace("## Cross-model review", "<div class=\"hidden\"/>\n## Cross-model review"))).toThrow(/raw HTML/u);
    expect(() => parseReviewBody(reviewBody().replace("- Risk:", "<div>\n- Risk:").replace("## Remaining work", "</div>\n\n## Remaining work"))).toThrow(/raw HTML/u);
    expect(() => parseReviewBody(reviewBody().replace("Closes #29", "```text\nCloses #29\n```"))).toThrow(/fenced/u);
    expect(() => parseReviewBody(reviewBody()
      .replace("## Cross-model review", "<div hidden>\n<!-- </div> -->\n## Cross-model review")
      .replace("## Remaining work", "</div>\n\n## Remaining work"))).toThrow(/raw HTML/u);
    expect(() => parseReviewBody(reviewBody().replace("- Risk:", "- Unsupported label: no\n- Risk:"))).toThrow(/unknown review field/u);
    expect(() => parseReviewBody(reviewBody().replace("change-evaluator", "change-evaluator,, supabase-auditor"))).toThrow(/canonical comma-separated/u);
    expect(() => parseReviewBody(reviewBody().replace("- Reviewer anthropic:", "- Reviewer anthropic:\n- Injected:"))).toThrow(/newline|unknown review field/u);
    expect(() => parseReviewBody(reviewBody({ sha: headSha.toUpperCase() }))).toThrow(/lowercase SHA/u);
  });

  it("rejects invalid family, fallback, verdict, contract, and path-derived risk evidence", () => {
    /** @param {string} body @param {string[]} [changedPaths] */
    const evaluate = (body, changedPaths = ["README.md"]) => evaluateGitHubReviewGate({ event: event(body), changedPaths, diff: "", workflow, executionPolicy });
    expect(() => evaluate(reviewBody({ reviewers: [{ family: "cursor", configured: "composer-2.5", observed: "composer-2.5", fallback: "false", verdict: "approved", contracts: "change-evaluator" }] }))).toThrow(/different from the primary/u);
    expect(() => evaluate(reviewBody({ reviewers: [{ family: "unknown", configured: "future-model", observed: "future-model", fallback: "false", verdict: "approved", contracts: "change-evaluator" }] }))).toThrow(/unknown reviewer model family/u);
    expect(() => evaluate(reviewBody({ reviewers: [{ family: "anthropic", configured: "gpt-5.6-sol[effort=high]", observed: "gpt-5.6-sol", fallback: "false", verdict: "approved", contracts: "change-evaluator" }] }))).toThrow(/mismatched reviewer model family/u);
    expect(() => evaluate(reviewBody({ reviewers: [{ family: "anthropic", configured: "claude-opus-5[effort=high]", observed: "claude-sonnet-5", fallback: "false", verdict: "approved", contracts: "change-evaluator" }] }))).toThrow(/fallback/u);
    expect(() => evaluate(reviewBody({ reviewers: [{ family: "anthropic", configured: "claude-sonnet-5", observed: "claude-sonnet-5", fallback: "false", verdict: "approved", contracts: "change-evaluator" }] }))).toThrow(/configured reviewer model/u);
    expect(() => evaluate(reviewBody({ primaryFallback: "true" }))).toThrow(/fallback/u);
    expect(() => evaluate(reviewBody({ reviewers: [{ family: "anthropic", configured: "claude-opus-5[effort=high]", observed: "claude-opus-5", fallback: "false", verdict: "changes-requested", contracts: "change-evaluator" }] }))).toThrow(/approved/u);
    expect(() => evaluate(highRiskBody({ reviewers: [{ family: "anthropic", configured: "claude-opus-5[effort=high]", observed: "claude-opus-5", fallback: "false", verdict: "approved", contracts: "change-evaluator" }] }), [".cursor/hooks.json"])).toThrow(/openai/u);
    expect(() => evaluate(highRiskBody({ reviewers: [
      { family: "anthropic", configured: "claude-opus-5[effort=high]", observed: "claude-opus-5", fallback: "false", verdict: "approved", contracts: "change-evaluator" },
      { family: "anthropic", configured: "claude-opus-5[effort=high]", observed: "claude-opus-5", fallback: "false", verdict: "approved", contracts: "change-evaluator" },
    ] }), [".cursor/hooks.json"])).toThrow(/unique/u);
    expect(() => evaluate(highRiskBody({
      riskReasons: "path:supabase/",
      reviewers: [
        { family: "anthropic", configured: "claude-opus-5[effort=high]", observed: "claude-opus-5", fallback: "false", verdict: "approved", contracts: "change-evaluator" },
        { family: "openai", configured: "gpt-5.6-sol[effort=high]", observed: "gpt-5.6-sol", fallback: "false", verdict: "approved", contracts: "change-evaluator" },
      ],
    }), ["supabase/migrations/001.sql"])).toThrow(/supabase-auditor/u);
    expect(() => evaluate(reviewBody(), [".cursor/hooks.json"])).toThrow(/Risk claim/u);
    expect(() => evaluate(highRiskBody({ riskReasons: "operation:not-real" }))).toThrow(/unknown operation risk reason/u);
    expect(() => evaluate(reviewBody({ reviewers: [{ family: "anthropic", configured: "claude-opus-5[effort=high]", observed: "claude-opus-5", fallback: "false", verdict: "approved", contracts: "change-evaluator, fictional-auditor" }] }))).toThrow(/unknown review contract/u);

    const wrongSurface = event(reviewBody());
    wrongSurface.pull_request.head.ref = "codex/29-exact-head-review";
    expect(() => evaluateGitHubReviewGate({ event: wrongSurface, changedPaths: ["README.md"], diff: "", workflow, executionPolicy })).toThrow(/surface/u);
    const wrongIssue = event(reviewBody());
    wrongIssue.pull_request.head.ref = "cursor/30-exact-head-review";
    expect(() => evaluateGitHubReviewGate({ event: wrongIssue, changedPaths: ["README.md"], diff: "", workflow, executionPolicy })).toThrow(/issue 29/u);

    const fork = event(reviewBody());
    fork.pull_request.head.repo.full_name = "attacker/Web-Template";
    expect(() => evaluateGitHubReviewGate({ event: fork, changedPaths: ["README.md"], diff: "", workflow, executionPolicy })).toThrow(/same repository/u);
  });

  it("accepts only a same-repository Dependabot GitHub Actions version-only diff", () => {
    expect(evaluateGitHubReviewGate({ event: dependabotEvent(), changedPaths: [".github/workflows/ci.yml"], diff: actionDiff, workflow })).toMatchObject({
      ok: true,
      mode: "dependabot-github-actions",
      headSha,
    });

    const fork = dependabotEvent();
    fork.pull_request.head.repo.full_name = "attacker/Web-Template";
    expect(() => evaluateGitHubReviewGate({ event: fork, changedPaths: [".github/workflows/ci.yml"], diff: actionDiff, workflow })).toThrow(/same repository/u);

    const npm = dependabotEvent();
    npm.pull_request.head.ref = "dependabot/npm_and_yarn/eslint-10";
    expect(() => evaluateGitHubReviewGate({ event: npm, changedPaths: ["package.json"], diff: actionDiff, workflow })).toThrow(/GitHub Actions branch/u);

    expect(() => evaluateGitHubReviewGate({ event: dependabotEvent(), changedPaths: ["package.json"], diff: actionDiff, workflow })).toThrow(/allowed workflow paths/u);
    expect(() => evaluateGitHubReviewGate({ event: dependabotEvent(), changedPaths: [".github/workflows/ci.yml"], diff: `${actionDiff}+        run: curl attacker.invalid\n`, workflow })).toThrow(/version-only/u);
    expect(() => evaluateGitHubReviewGate({ event: dependabotEvent(), changedPaths: [".github/workflows/ci.yml"], diff: actionDiff.replaceAll("actions/checkout", "evil/checkout"), workflow })).toThrow(/allowlisted/u);
  });

  it("keeps the GitHub workflow fail-closed and body-safe", async () => {
    const source = await readFile(path.resolve(".github/workflows/review-gate.yml"), "utf8");
    expect(source).toContain("Exact Head review policy");
    expect(source).toContain("edited");
    expect(source).toContain("ready_for_review");
    expect(source).toContain("pull_request:");
    expect(source).not.toContain("pull_request_target");
    expect(source).not.toContain("github.event.pull_request.body");
    expect(source).not.toMatch(/^\s*paths:/mu);
    expect(source).not.toMatch(/^\s*if:/mu);
    expect(source).toContain("HEAD_REPOSITORY");
    expect(source).toContain("BASE_REPOSITORY");
    expect(source).toContain('HEAD_REPOSITORY" != "$BASE_REPOSITORY');
    expect(source).toContain("candidate");
    expect(source).toContain("trusted/config/execution.json");
    expect(source).toContain("cache-dependency-path: trusted/package-lock.json");
    expect(source).toContain("working-directory: trusted");
    expect(source).toContain("npm ci --ignore-scripts");
    expect(source.indexOf("npm ci --ignore-scripts")).toBeLessThan(source.indexOf("Verify exact-Head review evidence"));
    expect(source).not.toMatch(/working-directory:\s*candidate[\s\S]{0,160}npm (?:ci|install)/u);
    expect(source).not.toMatch(/npm (?:--prefix\s+candidate|ci[^\n]*candidate|install[^\n]*candidate)/u);
    expect(source).not.toContain("62da0e1699ddfcf39f35914b54ad963fe5aa0740");
    expect(source).not.toContain("codex/22-exact-head-review");
    expect(source).not.toContain("initial rollout");
  });

  it("runs the committed CLI and derives pull-request changes from merge-base", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "github-review-gate-"));
    /** @param {string[]} args */
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    try {
      git("init", "-b", "main");
      git("config", "user.name", "Template Test");
      git("config", "user.email", "template-test@example.invalid");
      await writeFile(path.join(root, "README.md"), "base\n", "utf8");
      git("add", "README.md");
      git("commit", "-m", "base");
      git("switch", "-c", "feature");
      await writeFile(path.join(root, "README.md"), "base\nfeature\n", "utf8");
      git("commit", "-am", "feature");
      const featureSha = git("rev-parse", "HEAD");
      git("switch", "main");
      await mkdir(path.join(root, "supabase", "migrations"), { recursive: true });
      await writeFile(path.join(root, "supabase", "migrations", "001.sql"), "select 1;\n", "utf8");
      git("add", "supabase/migrations/001.sql");
      git("commit", "-m", "base advanced");
      const baseSha = git("rev-parse", "HEAD");
      const eventPath = path.join(root, "event.json");
      const configRoot = path.join(root, "config");
      await mkdir(configRoot, { recursive: true });
      const workflowPath = path.join(configRoot, "workflow.json");
      await writeFile(eventPath, `${JSON.stringify({ pull_request: { ...event(reviewBody({ sha: featureSha, executionSurface: "codex-local", primaryConfigured: "gpt-5.6-sol", primaryObserved: "gpt-5.6-sol", primaryFamily: "openai", reviewers: [{ family: "anthropic", configured: "claude-opus-5", observed: "claude-opus-5", fallback: "false", verdict: "approved", contracts: "change-evaluator" }] })).pull_request, base: { sha: baseSha, repo: { full_name: "yuto1201/Web-Template" } }, head: { sha: featureSha, ref: "codex/29-feature", repo: { full_name: "yuto1201/Web-Template" } } } })}\n`, "utf8");
      await writeFile(workflowPath, `${JSON.stringify(workflow)}\n`, "utf8");
      await writeFile(path.join(configRoot, "execution.json"), `${JSON.stringify(executionPolicy)}\n`, "utf8");
      const output = execFileSync(process.execPath, [path.resolve("tools/github-review-gate.mjs"), "--event", eventPath, "--repository", root, "--workflow", workflowPath, "--base", baseSha, "--head", featureSha], { encoding: "utf8" });
      expect(JSON.parse(output)).toMatchObject({ ok: true, mode: "independent-review", headSha: featureSha });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
