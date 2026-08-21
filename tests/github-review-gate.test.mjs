import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateGitHubReviewGate } from "../tools/github-review-gate.mjs";

const headSha = "a".repeat(40);
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
    primary: "codex",
    reviewer: "claude",
    sha: headSha,
    verdict: "approved",
    contracts: "change-evaluator",
    ...override,
  };
  return `Closes #22\n\n## Opposite-model review\n- Primary: ${values.primary}\n- Reviewer: ${values.reviewer}\n- Reviewed SHA: \`${values.sha}\`\n- Verdict: ${values.verdict}\n- Contracts: ${values.contracts}\n\n## Remaining work\n- None.\n`;
}

function event(body = reviewBody()) {
  return {
    pull_request: {
      body,
      head: { sha: headSha, ref: "codex/22-exact-head-review", repo: { full_name: "yuto1201/Web-Template" } },
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
  it("accepts exact opposite-model evidence rendered in the PR body", () => {
    expect(evaluateGitHubReviewGate({ event: event(), changedPaths: ["src/app/page.tsx"], diff: "", workflow })).toMatchObject({
      ok: true,
      mode: "independent-review",
      headSha,
      reviewer: "claude",
    });
  });

  it("rejects stale, duplicate, self-reviewed, unapproved, and incomplete evidence", () => {
    expect(() => evaluateGitHubReviewGate({ event: event(reviewBody({ sha: "9".repeat(40) })), changedPaths: ["README.md"], diff: "", workflow })).toThrow(/current Head/u);
    expect(() => evaluateGitHubReviewGate({ event: event(`${reviewBody()}- Reviewed SHA: \`${headSha}\`\n`), changedPaths: ["README.md"], diff: "", workflow })).toThrow(/exactly once/u);
    expect(() => evaluateGitHubReviewGate({ event: event(reviewBody().replace("- Reviewed SHA", "```\n- Reviewed SHA")), changedPaths: ["README.md"], diff: "", workflow })).toThrow(/fenced/u);
    expect(() => evaluateGitHubReviewGate({ event: event(reviewBody().replace("- Primary", "<!--\n- Primary")), changedPaths: ["README.md"], diff: "", workflow })).toThrow(/HTML comment/u);
    expect(() => evaluateGitHubReviewGate({ event: event(reviewBody({ reviewer: "codex" })), changedPaths: ["README.md"], diff: "", workflow })).toThrow(/opposite model/u);
    expect(() => evaluateGitHubReviewGate({ event: event(reviewBody({ verdict: "changes-requested" })), changedPaths: ["README.md"], diff: "", workflow })).toThrow(/approved/u);
    expect(() => evaluateGitHubReviewGate({ event: event(), changedPaths: ["supabase/migrations/001.sql"], diff: "", workflow })).toThrow(/supabase-auditor/u);
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
  });
});
