import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateGitHubReviewGate } from "../tools/github-review-gate.mjs";
import { digestValue } from "../tools/workflow-core.mjs";
import { authorityDigest } from "../tools/authority-core.mjs";

const headSha = "a".repeat(40);
const workflow = {
  reviewerModelFamilyMap: { gpt: "claude", claude: "gpt" },
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
    primaryFamily: "gpt",
    reviewerFamily: "claude",
    sha: headSha,
    verdict: "approved",
    contracts: "change-evaluator",
    external: "- None.",
    ...override,
  };
  return `Closes #22\n\n## Opposite-model review\n- Primary operator: ${values.primary}\n- Reviewer operator: ${values.reviewer}\n- Primary model family: ${values.primaryFamily}\n- Reviewer model family: ${values.reviewerFamily}\n- Reviewed SHA: \`${values.sha}\`\n- Verdict: ${values.verdict}\n- Contracts: ${values.contracts}\n\n## External changes\n${values.external}\n\n## Remaining work\n- None.\n`;
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

function externalLifecycle() {
  const prefix = "evidence/external-operations/merge";
  const receiptId = "receipt-github-merge-1";
  const executionHeadSha = "c".repeat(40);
  const authority = JSON.parse(readFileSync(path.resolve("config/ownership.json"), "utf8"));
  const authorization = {
    service: "github",
    operation: "github.merge_pr",
    purposeCode: "reviewed-release",
    purpose: "Merge the exact reviewed pull request for Issue 22.",
    accountRef: "accounts.github",
    targetRef: "resourceTargets.github",
    environment: "production",
    constraints: { issue: 22, repository: "yuto1201/Web-Template", prNumber: 33, headSha: executionHeadSha, method: "squash" },
    requiresExactHead: true,
  };
  const contractWithoutDigest = {
    schemaVersion: 2,
    issue: 22,
    repository: "yuto1201/Web-Template",
    goal: "Prove strict external lifecycle evidence.",
    acceptanceCriteria: [{ id: "AC-1", text: "Lifecycle evidence is strict." }],
    dependencies: [],
    externalAuthorizations: [authorization],
    authority: { commitSha: "b".repeat(40), digest: authorityDigest(authority) },
    fetchedAt: "2026-08-30T01:00:00Z",
  };
  const contract = { ...contractWithoutDigest, digest: digestValue(contractWithoutDigest) };
  const request = {
    schemaVersion: 1,
    requestId: "issue-22-github-merge-pr-1",
    issue: 22,
    operation: "github.merge_pr",
    target: { kind: "github.repository", identifier: "resourceTargets.github" },
    environment: "production",
    reasonCode: "reviewed-release",
    operatorLabel: "codex",
    executionRole: "external-operator",
    executionSurface: "github-cli",
    intent: "Merge the exact reviewed pull request for Issue 22.",
    reversibility: "compensating-change",
    recovery: { strategy: "separate-reviewed-operation", instructions: "Use a separately reviewed compensating change." },
    inputs: authorization.constraints,
  };
  const requestDigest = digestValue(request);
  const mutationDigest = digestValue({ operation: request.operation, inputs: request.inputs });
  const authorizationDigest = digestValue(authorization);
  const common = {
    schemaVersion: 1,
    service: "github",
    operation: "github.merge_pr",
    operatorLabel: "codex",
    executionRole: "external-operator",
    modelFamily: "gpt",
    executionSurface: "github-cli",
    executionHeadSha,
    authorityDigest: contract.authority.digest,
    issueContractDigest: contract.digest,
    authorizationDigest,
    requestDigest,
    mutationDigest,
    requestId: request.requestId,
  };
  const accountObservation = { ...authority.accounts.github, ...authority.observations.github };
  const targetObservation = authority.resourceTargets.github;
  const receipt = {
    schemaVersion: 1,
    receiptId,
    requestId: request.requestId,
    service: "github",
    operatorLabel: "codex",
    executionRole: "external-operator",
    executionSurface: "github-cli",
    authorityDigest: contract.authority.digest,
    issueContractDigest: contract.digest,
    authorizationDigest,
    requestDigest,
    mutationDigest,
    accountObservation,
    targetObservation,
    observedAt: "2026-08-30T01:00:01Z",
    expiresAt: "2026-08-30T01:02:01Z",
  };
  const operationObservation = request.inputs;
  const observationDigest = digestValue({ account: accountObservation, target: targetObservation, operation: operationObservation });
  const idempotencyKeyDigest = `sha256:${"2".repeat(64)}`;
  /** @type {Record<string, any>} */
  const outcome = {
    status: "succeeded",
    evidence: { ...request.inputs, mergeCommitSha: "d".repeat(40), issueClosed: true },
  };
  outcome.evidenceDigest = digestValue(outcome.evidence);
  const resultReceipt = {
    schemaVersion: 1,
    receiptId,
    requestId: request.requestId,
    service: "github",
    operatorLabel: "codex",
    executionRole: "external-operator",
    executionSurface: "github-cli",
    authorityDigest: contract.authority.digest,
    issueContractDigest: contract.digest,
    authorizationDigest,
    requestDigest,
    mutationDigest,
    preflight: { accountObservation, targetObservation, observedAt: receipt.observedAt },
    postflight: { accountObservation, targetObservation, observedAt: "2026-08-30T01:00:05Z" },
    outcome,
  };
  /** @type {Record<string, Record<string, any>>} */
  const artifacts = {};
  artifacts[`${prefix}/request.json`] = { ...common, phase: "request", receiptId: null, previousDigest: null, payload: { request, contract } };
  artifacts[`${prefix}/preflight.json`] = { ...common, phase: "preflight", receiptId, previousDigest: digestValue(artifacts[`${prefix}/request.json`]), payload: { receipt } };
  artifacts[`${prefix}/claim.json`] = { ...common, phase: "claim", receiptId, previousDigest: digestValue(artifacts[`${prefix}/preflight.json`]), payload: { accountObservation, targetObservation, operationObservation, observationDigest, idempotencyKeyDigest, startedAt: "2026-08-30T01:00:02Z" } };
  artifacts[`${prefix}/mutation.json`] = { ...common, phase: "mutation", receiptId, previousDigest: digestValue(artifacts[`${prefix}/claim.json`]), payload: { observationDigest, idempotencyKeyDigest, startedAt: "2026-08-30T01:00:02Z" } };
  artifacts[`${prefix}/result.json`] = { ...common, phase: "result", receiptId, previousDigest: digestValue(artifacts[`${prefix}/mutation.json`]), payload: { result: resultReceipt } };
  artifacts[`${prefix}/finalized.json`] = { ...common, phase: "finalized", receiptId, previousDigest: digestValue(artifacts[`${prefix}/result.json`]), payload: { outcome: "succeeded", evidenceDigest: outcome.evidenceDigest, finalizedAt: "2026-08-30T01:00:06Z" } };
  /** @param {string} name */
  const binding = (name) => ({ reference: `${prefix}/${name}.json`, digest: digestValue(artifacts[`${prefix}/${name}.json`]) });
  const change = {
    schemaVersion: 1,
    service: "github",
    operation: "github.merge_pr",
    operatorLabel: "codex",
    executionRole: "external-operator",
    modelFamily: "gpt",
    accountRef: "accounts.github",
    targetRef: "resourceTargets.github",
    serviceMode: "repository-active",
    executionHeadSha,
    evidenceHeadSha: headSha,
    mutationDigest,
    request: binding("request"),
    preflight: { ...binding("preflight"), receiptId },
    claim: { ...binding("claim"), observationDigest },
    mutation: { ...binding("mutation"), idempotencyKeyDigest },
    result: { ...binding("result"), receiptId },
    finalized: binding("finalized"),
    outcome: "succeeded",
  };
  return {
    artifacts,
    change,
    authority,
    evidenceCommit: { headSha, parentSha: executionHeadSha, changedPaths: Object.keys(artifacts) },
  };
}

describe("GitHub exact-Head review gate", () => {
  it("accepts exact opposite-model evidence rendered in the PR body", () => {
    expect(evaluateGitHubReviewGate({ event: event(), changedPaths: ["src/app/page.tsx"], diff: "", workflow })).toMatchObject({
      ok: true,
      mode: "independent-review",
      headSha,
      reviewerOperatorLabel: "claude",
      reviewerModelFamily: "claude",
    });
  });

  it("rejects stale, duplicate, self-reviewed, unapproved, and incomplete evidence", () => {
    expect(() => evaluateGitHubReviewGate({ event: event(reviewBody({ sha: "9".repeat(40) })), changedPaths: ["README.md"], diff: "", workflow })).toThrow(/current Head/u);
    expect(() => evaluateGitHubReviewGate({ event: event(`${reviewBody()}- Reviewed SHA: \`${headSha}\`\n`), changedPaths: ["README.md"], diff: "", workflow })).toThrow(/exactly once/u);
    expect(() => evaluateGitHubReviewGate({ event: event(reviewBody().replace("- Reviewed SHA", "```\n- Reviewed SHA")), changedPaths: ["README.md"], diff: "", workflow })).toThrow(/fenced/u);
    expect(() => evaluateGitHubReviewGate({ event: event(reviewBody().replace("- Primary operator", "<!--\n- Primary operator")), changedPaths: ["README.md"], diff: "", workflow })).toThrow(/HTML comment/u);
    expect(() => evaluateGitHubReviewGate({ event: event(`\`\`\`text\n${reviewBody()}\`\`\``), changedPaths: ["README.md"], diff: "", workflow })).toThrow(/fenced/u);
    expect(() => evaluateGitHubReviewGate({ event: event(`<!--\n${reviewBody()}-->`), changedPaths: ["README.md"], diff: "", workflow })).toThrow(/HTML comment/u);
    expect(evaluateGitHubReviewGate({ event: event(reviewBody({ reviewer: "codex" })), changedPaths: ["README.md"], diff: "", workflow }))
      .toMatchObject({ reviewerOperatorLabel: "codex", reviewerModelFamily: "claude" });
    expect(() => evaluateGitHubReviewGate({ event: event(reviewBody({ reviewerFamily: "gpt" })), changedPaths: ["README.md"], diff: "", workflow })).toThrow(/opposite model family|model family/u);
    expect(() => evaluateGitHubReviewGate({ event: event(reviewBody({ verdict: "changes-requested" })), changedPaths: ["README.md"], diff: "", workflow })).toThrow(/approved/u);
    expect(() => evaluateGitHubReviewGate({ event: event(), changedPaths: ["supabase/migrations/001.sql"], diff: "", workflow })).toThrow(/supabase-auditor/u);
  });

  it("rejects missing lifecycle evidence in the real PR-body gate", () => {
    expect(() => evaluateGitHubReviewGate({
      event: event(reviewBody({ external: '- Operation evidence: {"operation":"github.merge_pr"}' })),
      changedPaths: ["README.md"],
      diff: "",
      workflow,
    })).toThrow(/lifecycle|external change|operation evidence/iu);
    expect(() => evaluateGitHubReviewGate({
      event: event(),
      changedPaths: ["evidence/external-operations/merge/result.json"],
      diff: "",
      workflow,
    })).toThrow(/missing.*external|lifecycle|committed artifact/iu);
  });

  it("validates structured lifecycle evidence against committed artifact contents", () => {
    const { artifacts, change, authority, evidenceCommit } = externalLifecycle();
    const result = evaluateGitHubReviewGate({
      event: event(reviewBody({ external: `- Operation evidence: ${JSON.stringify(change)}` })),
      changedPaths: Object.keys(artifacts),
      diff: "",
      workflow,
      artifactLoader: (reference) => artifacts[reference],
      authorityLoader: () => authority,
      evidenceCommit,
      isAuthorityAncestor: () => true,
    });
    expect(result).toMatchObject({ ok: true, externalChanges: 1 });

    const tampered = structuredClone(change);
    tampered.result.digest = `sha256:${"9".repeat(64)}`;
    expect(() => evaluateGitHubReviewGate({
      event: event(reviewBody({ external: `- Operation evidence: ${JSON.stringify(tampered)}` })),
      changedPaths: Object.keys(artifacts),
      diff: "",
      workflow,
      artifactLoader: (reference) => artifacts[reference],
      authorityLoader: () => authority,
      evidenceCommit,
      isAuthorityAncestor: () => true,
    })).toThrow(/result artifact digest mismatch/iu);
  });

  it("rejects minimally populated caller-authored lifecycle placeholders", () => {
    const fixture = externalLifecycle();
    const { artifacts, authority, evidenceCommit } = fixture;
    const change = /** @type {Record<string, any>} */ (fixture.change);
    /** @type {Record<string, any>} */
    const minimal = {
      request: { operation: "github.merge_pr", operatorLabel: "codex", executionRole: "external-operator" },
      preflight: { receiptId: change.preflight.receiptId },
      claim: { observationDigest: change.claim.observationDigest },
      mutation: { idempotencyKeyDigest: change.mutation.idempotencyKeyDigest },
      result: { receiptId: change.result.receiptId },
      finalized: { outcome: "succeeded" },
    };
    for (const phase of Object.keys(minimal)) {
      const reference = change[phase].reference;
      artifacts[reference] = minimal[phase];
      change[phase].digest = digestValue(minimal[phase]);
    }
    expect(() => evaluateGitHubReviewGate({
      event: event(reviewBody({ external: `- Operation evidence: ${JSON.stringify(change)}` })),
      changedPaths: Object.keys(artifacts),
      diff: "",
      workflow,
      artifactLoader: (reference) => artifacts[reference],
      authorityLoader: () => authority,
      evidenceCommit,
      isAuthorityAncestor: () => true,
    })).toThrow(/strict|contract|request|receipt|lifecycle|execution Head/iu);
  });

  it("rejects execution-Head relabeling and non-evidence successor changes", () => {
    const fixture = externalLifecycle();
    const relabeled = structuredClone(fixture.change);
    relabeled.executionHeadSha = "e".repeat(40);
    expect(() => evaluateGitHubReviewGate({
      event: event(reviewBody({ external: `- Operation evidence: ${JSON.stringify(relabeled)}` })),
      changedPaths: Object.keys(fixture.artifacts),
      diff: "",
      workflow,
      artifactLoader: (reference) => fixture.artifacts[reference],
      authorityLoader: () => fixture.authority,
      evidenceCommit: fixture.evidenceCommit,
      isAuthorityAncestor: () => true,
    })).toThrow(/first parent|execution Head/iu);

    expect(() => evaluateGitHubReviewGate({
      event: event(reviewBody({ external: `- Operation evidence: ${JSON.stringify(fixture.change)}` })),
      changedPaths: [...Object.keys(fixture.artifacts), "src/app/page.tsx"],
      diff: "",
      workflow,
      artifactLoader: (reference) => fixture.artifacts[reference],
      authorityLoader: () => fixture.authority,
      evidenceCommit: { ...fixture.evidenceCommit, changedPaths: [...fixture.evidenceCommit.changedPaths, "src/app/page.tsx"] },
      isAuthorityAncestor: () => true,
    })).toThrow(/only the six|evidence files/iu);
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
      const workflowPath = path.join(root, "workflow.json");
      await writeFile(eventPath, `${JSON.stringify({ pull_request: { ...event(reviewBody({ sha: featureSha })).pull_request, base: { sha: baseSha, repo: { full_name: "yuto1201/Web-Template" } }, head: { sha: featureSha, ref: "feature", repo: { full_name: "yuto1201/Web-Template" } } } })}\n`, "utf8");
      await writeFile(workflowPath, `${JSON.stringify(workflow)}\n`, "utf8");
      const output = execFileSync(process.execPath, [path.resolve("tools/github-review-gate.mjs"), "--event", eventPath, "--repository", root, "--workflow", workflowPath, "--base", baseSha, "--head", featureSha], { encoding: "utf8" });
      expect(JSON.parse(output)).toMatchObject({ ok: true, mode: "independent-review", headSha: featureSha });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
