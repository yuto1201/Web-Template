# Risk-tiered Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make low- and normal-risk repository work faster while preserving or strengthening all high-risk authority, security, provider, and exact-Head controls.

**Architecture:** Extend the existing execution policy with a protected-base-derived low tier and a deterministic verification plan. Keep GitHub required context names stable, run a trusted classification job, and make every required job fail upward to its full path when classification is unavailable. The existing workflow and GitHub gates continue to bind normal/high reviews to exact Head; only trusted low-risk changes may carry zero independent reviews.

**Tech Stack:** Node.js 24.13.0, ECMAScript modules, Zod, Vitest, GitHub Actions YAML, Next.js repository scripts.

**Spec:** `specs/risk-tiered-verification.md`

## Global Constraints

- Risk tiers are exactly `low`, `normal`, and `high`.
- High-risk rules win before low-risk allowlist evaluation.
- Candidate PR text, labels, configuration, or operator input cannot lower trusted risk.
- Normal and high reviews remain bound to the exact final Head.
- Required GitHub check names remain unchanged.
- Missing or invalid classification runs the full verification path.
- No Supabase, Vercel, Cloudflare, Linear, DNS, deployment, hosted database, or ruleset mutation is authorized.
- Use `eval "$(fnm env --shell zsh)" && fnm use 24.13.0` before Node/npm commands.
- Use tests first for every behavior change.

---

### Task 1: Three-tier execution policy

**Files:**
- Modify: `tests/execution-policy.test.mjs`
- Modify: `tools/execution-policy.mjs`
- Modify: `config/execution.json`

**Interfaces:**
- Consumes: existing `classifyRisk`, `requiredReviewerFamilies`, and `validateReviewerFamilies` APIs.
- Produces: `RiskLevel = "low" | "normal" | "high"`; `classifyRisk(...)`; `deriveVerificationPlan(...)`; empty reviewer-family requirements only for low risk.

- [ ] **Step 1: Add failing low/high precedence tests**

Add tests equivalent to:

```js
expect(classifyRisk({ changedPaths: ["README.md"], externalOperations: [] }, policy)).toEqual({
  level: "low",
  reasons: ["path:README.md"],
});
expect(classifyRisk({ changedPaths: ["README.md", "src/app/page.tsx"], externalOperations: [] }, policy)).toEqual({
  level: "normal",
  reasons: [],
});
expect(classifyRisk({ changedPaths: ["docs/agent-contracts/change-evaluator.md"], externalOperations: [] }, policy)).toEqual({
  level: "high",
  reasons: ["path:docs/agent-contracts/"],
});
expect(requiredReviewerFamilies({ risk: "low", primaryFamily: "openai" })).toEqual([]);
expect(validateReviewerFamilies({ risk: "low", primaryFamily: "openai", reviewerFamilies: [] })).toEqual([]);
```

Also cover an external operation on an allowlisted path returning normal/high rather than low, and reject an empty changed-path set.

- [ ] **Step 2: Run the focused suite and verify RED**

Run:

```bash
npm exec -- vitest run tests/execution-policy.test.mjs
```

Expected: failures because `low`, `lowRiskPathRules`, and zero reviewers are unsupported.

- [ ] **Step 3: Extend the strict execution policy schema and classifier**

Implement:

```js
const riskSchema = z.enum(["low", "normal", "high"]);

export function classifyRisk(input, policy) {
  // validate non-empty canonical changed paths and known operations
  // collect high reasons first
  // if high reasons exist, return high
  // if there are no external operations and every path matches lowRiskPathRules,
  // return low with canonical matched allowlist reasons
  // otherwise return normal with no reasons
}

export function requiredReviewerFamilies({ risk, primaryFamily }) {
  // reject unknown primary family
  if (risk === "low") return [];
  if (risk === "high") return ["anthropic", "openai"];
  return [primaryFamily === "anthropic" ? "openai" : "anthropic"];
}
```

Add `lowRiskPathRules` to `config/execution.json`. Final-review correction: name only the two historical plan Markdown files under `docs/superpowers/plans/`; do not allow broad documentation prefixes. All normative `specs/**` and operational-security/reviewer guidance remain high risk. New documentation and README changes require normal review unless high-risk rules apply.

- [ ] **Step 4: Add and test verification-plan routing**

Add `verificationPathRules` for `databaseAuth`, `browser`, `macos`, and `template`. Implement:

```js
export function deriveVerificationPlan({ changedPaths, externalOperations }, policy) {
  const risk = classifyRisk({ changedPaths, externalOperations }, policy);
  if (risk.level === "high") return { risk, repository: "full", databaseAuth: true, browser: true, macos: true, template: true };
  if (risk.level === "low") return { risk, repository: "docs", databaseAuth: false, browser: false, macos: false, template: false };
  return {
    risk,
    repository: "full",
    databaseAuth: matchesConfiguredRule(changedPaths, policy.verificationPathRules.databaseAuth),
    browser: matchesConfiguredRule(changedPaths, policy.verificationPathRules.browser),
    macos: matchesConfiguredRule(changedPaths, policy.verificationPathRules.macos),
    template: matchesConfiguredRule(changedPaths, policy.verificationPathRules.template),
  };
}
```

Test high returns every flag true, low returns every expensive flag false, normal UI enables browser, and normal unrelated source keeps unrelated flags false.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm exec -- vitest run tests/execution-policy.test.mjs
git diff --check
git add config/execution.json tools/execution-policy.mjs tests/execution-policy.test.mjs
git commit -m "feat: add trusted three-tier change risk"
```

Expected: focused suite passes and the commit contains only Task 1 files.

---

### Task 2: Low-risk review evidence and protected local classification

**Files:**
- Modify: `tests/github-review-gate.test.mjs`
- Modify: `tests/workflow-contract.test.mjs`
- Modify: `tests/workflow-gate.test.mjs`
- Modify: `tools/github-review-gate.mjs`
- Modify: `tools/workflow-core.mjs`
- Modify: `config/review-contract.schema.json`
- Modify: `.github/pull_request_template.md`

**Interfaces:**
- Consumes: Task 1 `RiskLevel`, `classifyRisk`, and reviewer-family APIs.
- Produces: canonical low-risk PR evidence with zero reviewer lines; exact-Head normal/high behavior remains unchanged; local preparation reads policy from protected `main`.

- [ ] **Step 1: Add failing GitHub-gate tests for zero-review low risk**

Create a low-risk body helper whose review section contains all primary/risk/Head fields but no `Reviewer` line. Assert:

```js
expect(evaluateGitHubReviewGate({
  event: event(lowRiskBody()),
  changedPaths: ["README.md"],
  diff: "",
  workflow,
  executionPolicy,
})).toMatchObject({ ok: true, risk: "low", reviewers: [] });
```

Add negative cases proving the same body is rejected for `src/app/page.tsx`, `docs/agent-contracts/change-evaluator.md`, `.github/workflows/ci.yml`, and any external operation. Assert a low body with a reviewer line is rejected as non-canonical extra evidence.

- [ ] **Step 2: Add failing workflow-gate tests**

Update fixtures to permit `reviews: []` only when packet risk and required families are low/empty. Add tests proving normal/high still reject empty review arrays and stale Head behavior is unchanged.

- [ ] **Step 3: Run the three focused suites and verify RED**

Run:

```bash
npm exec -- vitest run tests/github-review-gate.test.mjs tests/workflow-contract.test.mjs tests/workflow-gate.test.mjs
```

Expected: parser and Zod minimum-length failures for low/empty review evidence.

- [ ] **Step 4: Implement canonical low-risk review handling**

Change the PR parser so reviewer lines may be empty only after trusted derived risk is known. Parse `low`, preserve exact current Head, and require exactly zero families for low. In workflow core, replace unconditional `z.array(...).min(1)` with an array validated against `requiredReviewerFamilies`.

Keep these invariants:

```js
if (derivedRisk.level === "low") assert(evidence.reviews.length === 0);
if (derivedRisk.level !== "low") assert(evidence.reviewedSha === headSha);
validateReviewerFamilies({ risk: derivedRisk.level, primaryFamily, reviewerFamilies });
```

The reviewed SHA field remains present for all tiers so the gate always binds the current PR metadata, even when no independent reviewer is required.

- [ ] **Step 5: Load local review risk from protected main**

Add a helper that reads `config/execution.json` with `git show main:config/execution.json`, validates it through `executionPolicySchema`, and uses it in `prepareReviewArtifacts`, packet validation with a contract, and the authoritative gate. If protected policy cannot load or parse, throw; do not fall back to candidate policy.

Write a repository fixture where candidate `config/execution.json` adds a source path to low rules but protected main does not. Assert preparation/gate returns the protected classification.

- [ ] **Step 6: Update schema/template and run focused suites**

Allow `risk.level = low` and zero reviewers only when `requiredReviewerFamilies` is empty. Keep normal/high minimum requirements in cross-field validation rather than weakening them in the JSON shape.

Run:

```bash
npm exec -- vitest run tests/github-review-gate.test.mjs tests/workflow-contract.test.mjs tests/workflow-gate.test.mjs tests/workflow-e2e.test.mjs
git diff --check
```

- [ ] **Step 7: Commit**

```bash
git add .github/pull_request_template.md config/review-contract.schema.json tools/github-review-gate.mjs tools/workflow-core.mjs tests/github-review-gate.test.mjs tests/workflow-contract.test.mjs tests/workflow-gate.test.mjs
git commit -m "feat: allow trusted low-risk review evidence"
```

---

### Task 3: Protected-base CI change plan

**Files:**
- Create: `tools/ci-change-plan.mjs`
- Create: `tests/ci-change-plan.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 `deriveVerificationPlan` and a policy file path supplied by the caller.
- Produces: CLI JSON and GitHub outputs `risk`, `repository`, `database_auth`, `browser`, `macos`, and `template`.

- [ ] **Step 1: Write failing CLI/unit tests**

Test a temporary Git repository with protected base and candidate commits. Required cases:

```js
expect(planFor(["README.md"])).toMatchObject({ risk: { level: "low" }, repository: "docs", databaseAuth: false });
expect(planFor(["src/app/page.tsx"])).toMatchObject({ risk: { level: "normal" }, browser: true });
expect(planFor(["supabase/migrations/20260830000000_x.sql"])).toMatchObject({ risk: { level: "high" }, databaseAuth: true, macos: true, template: true });
```

Also prove candidate edits to `config/execution.json` do not affect a plan when `--policy` points at the protected checkout, invalid policy exits nonzero, and `--full` emits every expensive flag as true/high.

- [ ] **Step 2: Run tests and verify RED**

```bash
npm exec -- vitest run tests/ci-change-plan.test.mjs
```

Expected: module/CLI is missing.

- [ ] **Step 3: Implement the CLI**

Export a pure function:

```js
export function createCiChangePlan({ root, baseSha, headSha, policy }) {
  const mergeBase = git(root, ["merge-base", baseSha, headSha]);
  const changedPaths = gitBuffer(root, ["diff", "--name-only", "-z", "--no-renames", mergeBase, headSha, "--"])
    .toString("utf8").split("\0").filter(Boolean);
  return deriveVerificationPlan({ changedPaths, externalOperations: [] }, policy);
}
```

The CLI accepts `--root`, `--base`, `--head`, `--policy`, `--github-output`, and `--full`. It writes only canonical scalar outputs and never evaluates PR text.

- [ ] **Step 4: Add package script and verify GREEN**

Add:

```json
"ci:change-plan": "node tools/ci-change-plan.mjs"
```

Run:

```bash
npm exec -- vitest run tests/ci-change-plan.test.mjs tests/execution-policy.test.mjs
node tools/ci-change-plan.mjs --full
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add package.json tools/ci-change-plan.mjs tests/ci-change-plan.test.mjs
git commit -m "feat: derive conservative CI change plans"
```

---

### Task 4: Required-context-preserving CI routing

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/repository-policy.test.mjs`

**Interfaces:**
- Consumes: Task 3 CLI outputs.
- Produces: unchanged required status contexts with conservative full fallback and conditional expensive steps.

- [ ] **Step 1: Add failing workflow-structure tests**

Read `.github/workflows/ci.yml` as text and assert:

```js
for (const name of ["Repository checks", "Database and Auth policy checks", "macOS onboarding and browser checks"]) {
  expect(ci).toContain(`name: ${name}`);
}
expect(ci).toMatch(/if:\s*always\(\)/u);
expect(ci).toContain("needs.classify.result != 'success'");
expect(ci.match(/npm run deployment:lint/gu)).toBeNull();
expect(ci.match(/npm run domain:lint/gu)).toBeNull();
```

Also assert the classifier checks out the trusted base and the candidate separately, passes base/head SHAs rather than PR body risk, and chooses full output when the trusted classifier does not exist.

- [ ] **Step 2: Run the repository-policy test and verify RED**

```bash
npm exec -- vitest run tests/repository-policy.test.mjs
```

Expected: missing classify job, fallback, and duplicate-removal assertions fail.

- [ ] **Step 3: Implement classify job and fail-up outputs**

Add an unprivileged Ubuntu `classify` job. For pull requests it checks out trusted base and candidate. If `trusted/tools/ci-change-plan.mjs` exists, install trusted dependencies with `npm ci --ignore-scripts` and run the trusted CLI against the candidate Git graph. Otherwise write a full high-risk plan. For push/main, write a full plan.

- [ ] **Step 4: Route required jobs without changing names**

- `Repository checks`: `if: always()`. Run `npm run check:docs` for a successful docs plan; otherwise run full `npm run check`. Browser and template steps run when their flags are true or classification failed.
- `Database and Auth policy checks`: `if: always()`. Run the current Supabase steps when `database_auth` is true or classification failed; otherwise emit a lightweight validated skip message.
- `macOS onboarding and browser checks`: `if: always()`. Select macOS when `macos` is true or classification failed, otherwise Ubuntu. Run setup/check/browser only on the full path; otherwise emit a lightweight validated result.

Do not rename the jobs and do not add `pull_request_target`.

- [ ] **Step 5: Remove duplicated deployment/domain steps and verify**

Run:

```bash
npm exec -- vitest run tests/repository-policy.test.mjs tests/ci-change-plan.test.mjs
npm run policy
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml tests/repository-policy.test.mjs
git commit -m "ci: route required checks by trusted risk"
```

---

### Task 5: Fast inner loop and efficiency policy

**Files:**
- Modify: `package.json`
- Modify: `config/workflow.json`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/workflow.md`
- Modify: `docs/verification.md`
- Modify: `specs/decisions.md`
- Modify: `tests/repository-policy.test.mjs`

**Interfaces:**
- Produces: `npm run check:fast`, `npm run check:docs`, and machine-readable efficiency thresholds.

- [ ] **Step 1: Add failing script/document contract tests**

Assert exact scripts:

```js
expect(packageJson.scripts["check:fast"]).toBe("npm run lint && npm run typecheck && npm test");
expect(packageJson.scripts["check:docs"]).toBe("npm run template:source-check && npm run policy && npm run check:links && npm run audit:trace && npm run check:generated");
```

Assert `config/workflow.json` contains:

```json
{
  "efficiency": {
    "targetReviewRounds": 2,
    "changedFileAdvisoryLimit": 30,
    "changedLineAdvisoryLimit": 3000
  }
}
```

Assert guidance says findings are batched, oversized work is split or justified, normal/high run one final full check, and completion audit is reserved for high-risk/template-release/milestone work.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm exec -- vitest run tests/repository-policy.test.mjs
```

- [ ] **Step 3: Add scripts/config/guidance**

Add the exact commands and thresholds. Update AGENTS workflow rules from “run check before review and again before merge” to risk-specific cadence:

- low: `check:docs` once at final Head;
- normal: focused/fast inner loop and one full `check` at final review Head, rerun only when code changes after it;
- high: full current verification plus relevant integrations and exact-Head reviews.

Document that CI success on the exact unchanged Head satisfies the before-merge rerun; do not run an identical local suite solely for ceremony.

- [ ] **Step 4: Record the accepted decision and verify**

Add D-008 to `specs/decisions.md` with the three-tier policy, required-context preservation, protected classification, and high-risk invariants.

Run:

```bash
npm exec -- vitest run tests/repository-policy.test.mjs tests/execution-policy.test.mjs
npm run check:docs
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add package.json config/workflow.json AGENTS.md README.md docs/workflow.md docs/verification.md specs/decisions.md tests/repository-policy.test.mjs
git commit -m "docs: adopt risk-specific verification cadence"
```

---

### Task 6: Generated assets, acceptance trace, and template manifest

**Files:**
- Modify: `config/acceptance.json`
- Modify: `specs/completion-audit.md`
- Modify: generated agent wrappers if `npm run generate` changes them
- Modify: `config/template.json`
- Modify: tests reported by source-policy drift checks

**Interfaces:**
- Consumes: completed policy/docs/tool changes.
- Produces: generated wrappers and template occurrence manifest consistent with source.

- [ ] **Step 1: Add Issue #35 acceptance trace**

Add Issue 35 with evidence paths including the design, execution policy, CI planner, review gate, workflow, and tests. Update `specs/completion-audit.md` with the risk-tier responsibility and commands.

- [ ] **Step 2: Run generated/source checks and observe expected drift**

```bash
npm run check:generated
npm run template:source-check
npm run audit:trace
```

Expected before regeneration: one or more drift reports caused by changed canonical guidance or occurrence counts.

- [ ] **Step 3: Regenerate only canonical outputs**

Run:

```bash
npm run generate
npm run template:source-check -- --print
```

Apply only mechanically derived occurrence-count changes to `config/template.json`; do not hand-edit generated wrappers beyond generator inputs.

- [ ] **Step 4: Verify and commit**

```bash
npm run check:generated
npm run template:source-check
npm run audit:trace
npm exec -- vitest run tests/generated-assets.test.mjs tests/template-initializer.test.mjs tests/acceptance-trace.test.mjs
git diff --check
git add config/acceptance.json specs/completion-audit.md config/template.json .claude .codex .cursor tests
git commit -m "test: trace risk-tiered verification policy"
```

Stage only paths actually changed by this task.

---

### Task 7: Full high-risk verification, consultation, and delivery

**Files:**
- Modify only files required by verified material findings.
- Create ignored `.artifacts/issues/35/**` workflow evidence.

**Interfaces:**
- Produces: exact-Head verification, Claude/Grok assessments, PR #35 delivery evidence, and merged Issue closure.

- [ ] **Step 1: Run full exact-Head verification**

```bash
npm run check
npm run template:verify
npm run audit:completion
git diff --check
```

Expected: all non-integration checks pass; integration-gated checks are explicitly reported rather than inferred.

- [ ] **Step 2: Prepare exact-Head review evidence**

Commit any final manifest/evidence changes first. Record the exact SHA. Prepare the Issue contract, verification input, packet, and PR body using repository workflow commands. Because this migration modifies `tools/`, `config/`, `.github/`, AGENTS, and security workflow guidance, the protected old policy classifies it high and requires approved OpenAI and Anthropic families.

- [ ] **Step 3: Ask Claude and Grok for final read-only review**

Claude prompt requires severity-ranked correctness/security/findings and exact SHA. Grok prompt requires the same, with a specific attempt to find self-downgrade, skipped-required-context, or high-risk regression paths. Neither reviewer may edit files or access providers.

- [ ] **Step 4: Resolve findings through TDD**

For every material finding, first add a focused failing regression test, run it to observe RED, implement the minimal correction, run focused GREEN, then rerun Task 7 Step 1 and both exact-Head reviews. Batch findings into one Head change when possible.

- [ ] **Step 5: Push, open PR, and wait for required checks**

Use repository `yuto1201/Web-Template`, branch `codex/35-risk-tiered-verification`, and a PR body closing Issue #35. Confirm all four required context names report and pass. Optional Vercel preview failure is reported separately and does not override ruleset requirements.

- [ ] **Step 6: Merge and verify final state**

Squash merge only after no unresolved material thread remains. Verify the PR is merged, Issue #35 is closed, and `origin/main` contains the merge commit. Do not operate Supabase, Vercel CLI, Cloudflare, Linear, DNS, hosted databases, or the GitHub ruleset.
