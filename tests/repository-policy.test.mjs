import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  containsPotentialSecret,
  detectActorAsymmetry,
  hasCanonicalOperatorParityStatement,
  operatorParityErrors,
  validateCursorHookPolicy,
  validateRepository,
} from "../tools/repository-policy.mjs";
import { evaluateGitHubReviewGate } from "../tools/github-review-gate.mjs";

describe("repository policy", () => {
  it("requires every supported Cursor hook to remain finite and fail closed", async () => {
    const hooksConfig = JSON.parse(await readFile(path.resolve(".cursor/hooks.json"), "utf8"));
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
    expect(validateCursorHookPolicy({ hooksConfig, packageJson })).toEqual([]);

    const weakened = structuredClone(hooksConfig);
    weakened.hooks.beforeShellExecution[0].failClosed = false;
    expect(validateCursorHookPolicy({ hooksConfig: weakened, packageJson })).toContain(
      "Cursor hook beforeShellExecution must be a finite fail-closed project command.",
    );
  });
  it("keeps the PR template compatible with the exact-Head review body parser", async () => {
    const template = await readFile(path.resolve(".github/pull_request_template.md"), "utf8");
    const workflow = JSON.parse(await readFile(path.resolve("config/workflow.json"), "utf8"));
    const executionPolicy = JSON.parse(await readFile(path.resolve("config/execution.json"), "utf8"));
    const headSha = "a".repeat(40);
    const completedBody = template
      .replace("Closes #", "Closes #33")
      .replace(/^- Execution surface:.*$/mu, "- Execution surface: codex-local")
      .replace(/^- Primary operator label:.*$/mu, "- Primary operator label: codex")
      .replace(/^- Primary configured model:.*$/mu, "- Primary configured model: gpt-5.6-sol")
      .replace(/^- Primary observed model:.*$/mu, "- Primary observed model: gpt-5.6-sol")
      .replace(/^- Primary family:.*$/mu, "- Primary family: openai")
      .replace(/^- Primary fallback:.*$/mu, "- Primary fallback: false")
      .replace(/^- Risk:.*$/mu, "- Risk: low")
      .replace(/^- Risk reasons:.*$/mu, "- Risk reasons: path:README.md")
      .replace(/^- Reviewed SHA:.*$/mu, `- Reviewed SHA: \`${headSha}\``)
      .replace(/^- Reviewer anthropic:.*\n/mu, "")
      .replace(/^- Reviewer openai:.*\n/mu, "");

    expect(() => evaluateGitHubReviewGate({
      event: {
        pull_request: {
          body: completedBody,
          head: { sha: headSha, ref: "codex/33-template-policy", repo: { full_name: "yuto1201/Web-Template" } },
          base: { sha: "b".repeat(40), repo: { full_name: "yuto1201/Web-Template" } },
          user: { login: "yuto1201", id: 50611866, type: "User" },
        },
      },
      changedPaths: ["README.md"],
      diff: "",
      workflow,
      executionPolicy,
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

  it("documents the committed structured external-operation lifecycle", async () => {
    const workflow = await readFile(path.resolve("docs/workflow.md"), "utf8");
    expect(workflow).toMatch(/six unique committed references[^:]*: request, preflight, claim, mutation, result, and finalized/iu);
    expect(workflow).toMatch(/preflight and result[^.]*share one redacted `receiptId`/iu);
    expect(workflow).toMatch(/claim carries the fresh observation digest[^.]*mutation carries the provider idempotency-key digest/iu);
    expect(workflow).toMatch(/committed `evidence\/external-operations\/`/u);
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

  it("exercises template initialization through the public package script", async () => {
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
    const verifier = await readFile(path.resolve("tools/verify-template-instantiation.mjs"), "utf8");

    expect(packageJson.scripts["template:init"]).toBe("node tools/initialize-template.mjs");
    expect(verifier.match(/\[npmCli, "run", "template:init", "--", "--config", inputPath\]/gu)).toHaveLength(2);
    expect(verifier).not.toContain('["tools/initialize-template.mjs", "--config", inputPath]');
  });

  it("uses the shared tracked-index file list for clean-room copies", async () => {
    const verifier = await readFile(path.resolve("tools/verify-template-instantiation.mjs"), "utf8");

    expect(verifier).toContain("const trackedFiles = listTrackedFiles(source);");
    expect(verifier).not.toContain('"--others"');
    expect(verifier).not.toContain('"--exclude-standard"');
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
    for (const relative of [
      "AGENTS.md", "README.md", "docs/activation.md", "docs/authority.md", "docs/onboarding-macos.md", "docs/security.md",
      "specs/acceptance.md", "specs/account-bound-authority.md", "specs/architecture.md", "specs/completion-audit.md", "specs/product.md",
    ]) {
      const content = contents.get(relative) ?? await readFile(path.resolve(relative), "utf8");
      expect(content, `${relative} must keep Linear denied because no operation is registered`).toMatch(/Linear[^\n]*(?:no (?:Linear )?operation is registered|操作自体が未登録)/iu);
    }
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
      claudeSettings: {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        permissions: { deny: ["Read(./.env)", "Read(./.env.*)"] },
      },
      generatorSource: "Claude has the same account-bound authority as Codex.",
      generatedAssets: new Map([
        ["CLAUDE.md", "Claude has the same account-bound authority as Codex."],
      ]),
    })).toEqual([]);
  });

  it("allows only reviewed actor-neutral secret-path denies and scans every generated wrapper", () => {
    const equality = "Claude acting in implementer and external-operator roles has the same account-bound authority as Codex.";
    expect(operatorParityErrors({
      claudeSettings: {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        permissions: { deny: ["Read(./.env)", "Read(./.env.*)"] },
      },
      generatorSource: equality,
      generatedAssets: new Map([
        ["CLAUDE.md", equality],
        [".codex/agents/supabase-auditor.toml", "Remote evidence must be delegated to Codex."],
      ]),
    })).toEqual(expect.arrayContaining([
      expect.stringMatching(/supabase-auditor.*actor-specific/iu),
    ]));

    expect(operatorParityErrors({
      claudeSettings: {
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        permissions: { deny: ["Read(./.env)", "Bash"] },
      },
      generatorSource: equality,
      generatedAssets: new Map([["CLAUDE.md", equality]]),
    })).toEqual(expect.arrayContaining([expect.stringMatching(/deny rules/iu)]));
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
