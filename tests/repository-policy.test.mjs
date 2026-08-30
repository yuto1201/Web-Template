import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  containsPotentialSecret,
  detectActorAsymmetry,
  hasCanonicalOperatorParityStatement,
  operatorParityErrors,
  validateRepository,
} from "../tools/repository-policy.mjs";
import { evaluateGitHubReviewGate } from "../tools/github-review-gate.mjs";

describe("repository policy", () => {
  it("keeps the PR template compatible with the exact-Head review body parser", async () => {
    const template = await readFile(path.resolve(".github/pull_request_template.md"), "utf8");
    const workflow = JSON.parse(await readFile(path.resolve("config/workflow.json"), "utf8"));
    const headSha = "a".repeat(40);
    const completedBody = template
      .replace("Closes #", "Closes #33")
      .replace(/^- Primary:.*$/mu, "- Primary: codex")
      .replace(/^- Reviewer:.*$/mu, "- Reviewer: claude")
      .replace(/^- Reviewed SHA:.*$/mu, `- Reviewed SHA: \`${headSha}\``)
      .replace(/^- Verdict:.*$/mu, "- Verdict: approved")
      .replace(/^- Contracts:.*$/mu, "- Contracts: change-evaluator");

    expect(() => evaluateGitHubReviewGate({
      event: {
        pull_request: {
          body: completedBody,
          head: { sha: headSha },
          user: { login: "yuto1201", id: 50611866, type: "User" },
        },
      },
      changedPaths: ["README.md"],
      diff: "",
      workflow,
    })).not.toThrow();
  });

  it("records external-operation evidence axes as distinct PR fields", async () => {
    const template = await readFile(path.resolve(".github/pull_request_template.md"), "utf8");
    for (const label of [
      "Operator label",
      "Execution role",
      "Model family",
      "Account ref",
      "Service mode",
      "Exact target ref",
      "Redacted preflight receipt ID",
      "Redacted execution claim reference",
      "Redacted finalized result receipt ID",
    ]) {
      expect(template, `missing separate ${label} field`).toMatch(new RegExp(`^- ${label}:`, "mu"));
    }
    expect(template).not.toMatch(/Operator label\s*\/\s*Execution role/iu);
    expect(template).not.toMatch(/^- Redacted receipt ID:/mu);
  });

  it("documents receipt, claim marker, and finalized marker evidence without invented IDs", async () => {
    const workflow = await readFile(path.resolve("docs/workflow.md"), "utf8");
    expect(workflow).toMatch(/preflight receipt ID[^.]*canonical `receiptId`/iu);
    expect(workflow).toMatch(/execution claim reference[^.]*`<mutation-digest>\.claim\.json`/iu);
    expect(workflow).toMatch(/finalized result receipt ID[^.]*same canonical `receiptId`/iu);
    expect(workflow).toMatch(/`<mutation-digest>\.finalized\.json`/u);
  });

  it("requires receipts for every approved authenticated operation on a new Mac", async () => {
    const onboarding = await readFile(path.resolve("docs/onboarding-macos.md"), "utf8");
    expect(onboarding).toMatch(/Every repository-approved authenticated operation[^.]*request[^.]*preflight[^.]*claim[^.]*result/iu);
    expect(onboarding).toMatch(/High-risk writes[^.]*additionally[^.]*exact-Head/iu);
  });

  it("installs dependencies before account-bound template initialization", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const activation = await readFile(path.resolve("docs/activation.md"), "utf8");
    const onboarding = await readFile(path.resolve("docs/onboarding-macos.md"), "utf8");

    expect(readme.indexOf("npm ci")).toBeLessThan(readme.indexOf("npm run template:init"));
    expect(activation.indexOf("`npm ci`")).toBeLessThan(activation.indexOf("`npm run template:init"));
    expect(onboarding).toMatch(/run `npm ci` before template initialization/iu);
  });

  it("migrates normative policy to account-bound operator parity", async () => {
    const normativePaths = [
      "AGENTS.md",
      "README.md",
      ".github/pull_request_template.md",
      "docs/authority.md",
      "docs/security.md",
      "docs/workflow.md",
      "docs/database.md",
      "docs/deployment.md",
      "docs/domain.md",
      "docs/activation.md",
      "docs/verification.md",
      "docs/onboarding-macos.md",
      "specs/product.md",
      "specs/architecture.md",
      "specs/acceptance.md",
      "specs/completion-audit.md",
    ];
    const contents = new Map(await Promise.all(normativePaths.map(async (relative) => /** @type {[string, string]} */ ([
      relative,
      await readFile(path.resolve(relative), "utf8"),
    ]))));
    const obsoleteClaims = [
      "Codex is the only actor",
      "Codex-only external operations",
      "External merge remains a Codex operation",
      "Claude shell execution is disabled",
      "Authenticated provider work stays with Codex",
    ];

    for (const [relative, content] of contents) {
      for (const claim of obsoleteClaims) {
        expect(content, `${relative} retains obsolete actor-specific policy: ${claim}`).not.toContain(claim);
      }
      expect(detectActorAsymmetry(content), `${relative} contains actor-specific normative policy`).toBeNull();
    }

    for (const relative of ["AGENTS.md", "README.md", "docs/authority.md", "specs/product.md", "specs/architecture.md"]) {
      const content = contents.get(relative);
      expect(content, `${relative} must name account-bound authority`).toMatch(/account-bound authority/iu);
      expect(content, `${relative} must name Claude`).toMatch(/Claude/u);
      expect(content, `${relative} must name Codex`).toMatch(/Codex/u);
    }

    const authority = contents.get("docs/authority.md");
    expect(authority).toMatch(/repository-active/iu);
    expect(authority).toMatch(/explicit-user-purpose-only/iu);
    expect(authority).toMatch(/Linear[^\n]*(?:deny|denies|denial|denied|block|fail closed)/iu);
  });

  it("preserves D-003 as superseded history and records accepted D-007", async () => {
    const decisions = await readFile(path.resolve("specs/decisions.md"), "utf8");
    const d003 = decisions.match(/## D-003:[\s\S]*?(?=\n## D-|$)/u)?.[0] ?? "";
    const d007 = decisions.match(/## D-007:[\s\S]*?(?=\n## D-|$)/u)?.[0] ?? "";

    expect(d003).toContain("Codex-only");
    expect(d007).toMatch(/Status:\s*accepted/iu);
    expect(d007).toContain("Supersedes: D-003 and actor-specific portions of D-004/D-006");
    expect(d007).toMatch(/account-bound authority/iu);
  });

  it("keeps acceptance Issues sorted, unique, and traces Issue #33", async () => {
    const trace = JSON.parse(await readFile(path.resolve("config/acceptance.json"), "utf8"));
    const issues = trace.issues.map(/** @param {Record<string, any>} entry */ (entry) => entry.issue);

    expect(issues).toEqual([...new Set(issues)].toSorted((left, right) => left - right));
    expect(issues).toContain(33);
    expect(trace.issues.find(/** @param {Record<string, any>} entry */ (entry) => entry.issue === 33)).toMatchObject({
      evidence: expect.arrayContaining([
        "specs/account-bound-authority.md",
        "tools/authority-core.mjs",
        "tools/issue-workflow.mjs",
        "tools/verify-template-instantiation.mjs",
      ]),
    });
  });

  it("keeps required policy, ownership, agent, and secret boundaries valid", async () => {
    const authority = JSON.parse(await readFile(path.resolve("config/ownership.json"), "utf8"));
    const template = JSON.parse(await readFile(path.resolve("config/template.json"), "utf8"));
    if (template.status === "template-source") {
      expect(template.project.observations.github.observedAt).not.toBe(authority.observations.github.observedAt);
    } else {
      expect(template.status).toBe("initialized");
    }
    await expect(validateRepository(path.resolve("."))).resolves.toEqual([]);
  });

  it("detects representative provider credentials without flagging placeholders", () => {
    expect(containsPotentialSecret(["AK", "IA1234567890ABCDEF"].join(""))).toBe(true);
    expect(containsPotentialSecret(["sb", "p_12345678901234567890"].join(""))).toBe(true);
    expect(containsPotentialSecret(["-----BEGIN PRIVATE", " KEY-----"].join(""))).toBe(true);
    expect(containsPotentialSecret("SUPABASE_SERVICE_ROLE_KEY=replace-me")).toBe(false);
  });

  it("rejects residual actor-specific deny, guard, and delegation policy", () => {
    expect(operatorParityErrors({
      claudeSettings: {
        permissions: { deny: ["Bash"] },
        hooks: { PreToolUse: [{ hooks: [{ command: "node tools/guard-claude-tool.mjs" }] }] },
      },
      generatorSource: "All authenticated external operations must be delegated to Codex.",
      generatedAssets: new Map([
        ["CLAUDE.md", "Claude may perform local implementation only."],
      ]),
    })).toEqual(expect.arrayContaining([
      expect.stringMatching(/deny rules/u),
      expect.stringMatching(/PreToolUse/u),
      expect.stringMatching(/guard/u),
      expect.stringMatching(/delegation/u),
    ]));

    expect(operatorParityErrors({
      claudeSettings: { $schema: "https://json.schemastore.org/claude-code-settings.json" },
      generatorSource: "Claude has the same account-bound authority as Codex.",
      generatedAssets: new Map([
        ["CLAUDE.md", "Claude has the same account-bound authority as Codex."],
      ]),
    })).toEqual([]);
  });

  it.each([
    "Claude must delegate all external operations to Codex.",
    "codex MUST DELEGATE every provider operation to Claude!",
    "Only Codex may perform authenticated operations.",
    "CLAUDE-only external operations are prohibited.",
    "Provider ownership belongs only to Codex.",
    "Claude owns external service operations.",
    "Codex cannot use provider APIs.",
    "Claude must not operate deployments.",
    "Codex mustn't change DNS.",
    "External operations are forbidden for Claude.",
    "Authenticated provider work stays with Codex.",
    "External merge remains a Codex operation.",
    "Provider work belongs to Claude.",
    "Claude is not allowed to call provider APIs.",
    "Codex may not deploy production.",
    "Claude shall not change DNS.",
    "Codex is barred from external operations.",
    "Claude and Codex must delegate external operations to Codex.",
    "Claude and Codex may operate, but only Codex owns deployments.",
    "Claude and Codex may operate, while Claude cannot deploy production.",
    "Codex and Claude may operate, while Codex cannot deploy production.",
    "Claude and Codex share authority, although Codex is barred from DNS changes.",
    "Codex and Claude share authority, although Claude is barred from DNS changes.",
    "Claude and Codex may operate, Claude cannot change DNS.",
    "Codex and Claude may operate, Codex cannot change DNS.",
    "Claude and Codex may operate; Claude cannot change DNS.",
    "Codex and Claude may operate; Codex cannot change DNS.",
    "Claude and Codex may operate (although Claude cannot call provider APIs).",
    "Codex and Claude may operate (although Codex cannot call provider APIs).",
    "Claude (and Codex) may operate (although Codex cannot deploy production).",
    "Codex (and Claude) may operate (although Claude cannot deploy production).",
    "Claude and Codex share receipts, and Codex and Claude share targets, while Claude cannot deploy.",
    "Claude reviewer remains read-only, while Codex cannot deploy production.",
    "Claude reviewer remains read-only, while Codex cannot merge pull requests.",
    "Codex reviewer remains read-only, while Claude cannot merge pull requests.",
    "Codex auditor remains read-only, although Claude may not modify repository files.",
    "Claude auditor remains read-only, although Codex may not modify repository files.",
    "CLAUDE reviewer remains read-only, while codex cannot edit repository files!",
    "Codex evaluator remains read-only (although Claude cannot use the shell).",
    "Claude evaluator remains read-only, while Codex cannot use external tools.",
    "Claude reviewer remains read-only, Codex auditor remains read-only, while Claude cannot merge pull requests.",
    "Codex reviewer remains read-only, Claude auditor remains read-only, while Codex may not modify repository files.",
  ])("detects actor-asymmetric operator restriction: %s", (content) => {
    expect(detectActorAsymmetry(content)).toMatch(/actor-specific/iu);
  });

  it.each([
    "Claude reviewer cannot approve changes and Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes and Claude cannot merge pull requests.",
    "Claude auditor may not edit repository files and Codex cannot use external tools.",
    "Codex auditor may not edit repository files and Claude cannot use external tools.",
    "Claude reviewer may only review Codex-authored implementations and Codex cannot merge pull requests.",
    "Codex reviewer may only review Claude-authored implementations and Claude cannot merge pull requests.",
    "Claude reviewer cannot approve changes or Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes or Claude cannot merge pull requests.",
    "Claude reviewer cannot approve changes yet Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes yet Claude cannot merge pull requests.",
    "Claude reviewer cannot approve changes then Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes then Claude cannot merge pull requests.",
    "Claude reviewer cannot approve changes but Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes but Claude cannot merge pull requests.",
    "Claude reviewer cannot approve changes while Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes while Claude cannot merge pull requests.",
    "Claude reviewer cannot approve changes although Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes although Claude cannot merge pull requests.",
    "Claude reviewer cannot approve changes whereas Codex cannot merge pull requests.",
    "Codex reviewer cannot approve changes whereas Claude cannot merge pull requests.",
  ])("detects a no-punctuation actor restriction after reviewer coordination: %s", (content) => {
    expect(detectActorAsymmetry(content)).toMatch(/actor-specific/iu);
  });

  it.each([
    "Claude acting in implementer and external-operator roles has the same account-bound authority as Codex.",
    "Claude and Codex reviewers remain read-only.",
    "Claude reviews Codex implementations, and Codex reviews Claude implementations to preserve cross-model review independence.",
    "Generated evaluator and auditor roles remain read-only, and model family is used only for independent cross-model review.",
    "Claude and Codex must not switch authenticated accounts automatically.",
    "Only Claude and Codex in operator roles may use account-bound receipts.",
    "CLAUDE, and codex must not switch authenticated accounts automatically.",
    "Codex / Claude must not switch authenticated accounts automatically.",
    "Claude (and Codex) must not switch authenticated accounts automatically.",
    "Codex (and Claude) must not switch authenticated accounts automatically.",
    "Claude reviewer remains read-only.",
    "Codex auditor remains read-only.",
    "Claude reviewer and Codex auditor remain read-only.",
    "Claude reviewer must not self-approve changes.",
    "Codex auditor cannot approve Codex-authored changes.",
    "Claude reviewer cannot approve changes.",
    "Codex auditor may not edit repository files.",
    "Claude reviewer may only review Codex-authored changes.",
    "Codex evaluator may only evaluate Claude-authored implementations.",
  ])("allows shared authority and read-only independent review policy: %s", (content) => {
    expect(detectActorAsymmetry(content)).toBeNull();
  });

  it("requires the canonical operator equality statement on authority entrypoints", () => {
    expect(hasCanonicalOperatorParityStatement(
      "Claude acting in implementer and external-operator roles has the same account-bound authority as Codex.",
    )).toBe(true);
    expect(hasCanonicalOperatorParityStatement(
      "Claude and Codex may both perform some work.",
    )).toBe(false);
    expect(detectActorAsymmetry(
      "Claude has the same account-bound authority as Codex and Codex cannot merge pull requests.",
    )).toMatch(/actor-specific/iu);
    expect(detectActorAsymmetry(
      "Claude has the same account-bound authority as Codex and Claude cannot use external tools.",
    )).toMatch(/actor-specific/iu);

    expect(operatorParityErrors({
      claudeSettings: { $schema: "https://json.schemastore.org/claude-code-settings.json" },
      generatorSource: "Claude and Codex may both perform some work.",
      generatedAssets: new Map([
        ["CLAUDE.md", "Claude and Codex may both perform some work."],
      ]),
    })).toEqual(expect.arrayContaining([
      expect.stringMatching(/canonical operator equality.+generator/iu),
      expect.stringMatching(/canonical operator equality.+CLAUDE\.md/iu),
    ]));
  });

  it("applies the shared detector to settings, generator, and generated entrypoint content", () => {
    const equality = "Claude acting in implementer and external-operator roles has the same account-bound authority as Codex.";
    const errors = operatorParityErrors({
      claudeSettings: {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        note: "Claude must delegate all external operations to Codex.",
      },
      generatorSource: `${equality}\nOnly CODEX may own provider operations.`,
      generatedAssets: new Map([
        ["CLAUDE.md", `${equality}\nClaude cannot operate deployments; Codex owns deployment operations.`],
      ]),
      canonicalSurfaces: new Map([
        ["tools/completion-audit.mjs", "Only Claude may own completion operations."],
      ]),
    });

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/\.claude\/settings\.json/iu),
      expect.stringMatching(/generate-agent-wrappers\.mjs/iu),
      expect.stringMatching(/CLAUDE\.md/iu),
      expect.stringMatching(/completion-audit\.mjs/iu),
    ]));
  });
});
