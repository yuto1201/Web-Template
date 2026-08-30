# Account-Bound Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Claude and Codex equal implementation/external-operator policy rights while fail-closing every authenticated operation against protected-main personal-account authority, repository service policy, frozen Issue purpose, exact target, and current review evidence.

**Architecture:** A canonical `authority-core` parses ownership schema v2 and evaluates account/service/target observations. Workflow contracts freeze authority and resolved external authorizations from protected `main`; guarded provider adapters produce one-use preflight and result receipts. Existing Claude-only enforcement remains until all shared gates are green, then is removed atomically while reviewer roles stay read-only.

**Tech Stack:** Node.js 24.13.0, npm 11.6.2, ESM JavaScript, Zod, Vitest, GitHub CLI/Git for delivery only.

**Spec:** `specs/account-bound-authority.md`

## Global Constraints

- Use Node.js `24.13.0` and npm `11.6.2` through `fnm use 24.13.0`.
- Work only on Issue #33 and branch `codex/33-account-bound-authority`.
- Follow red-green-refactor: no production behavior change before its focused test fails for the expected reason.
- Do not mutate Supabase, Vercel, Cloudflare, Linear, DNS, hosted databases, deployments, billing, or provider secrets.
- Issue #33 external GitHub delivery remains authorized by protected-main authority v1; candidate authority v2 must never authorize itself.
- Preserve opposite-model exact-Head review, reviewer self-approval rejection, diff/verification/contract digests, provider-specific deployment/domain checks, secret scanning, and the Dependabot exception.
- Never automatically log out, log in, switch accounts, switch teams, select another profile, or accept a display-name match as identity proof.
- Linear stays `explicit-user-purpose-only`; its missing provider-stable workspace/user IDs block every authenticated read and write.
- Remove Claude-specific restrictions only after Tasks 1–4 pass together.

---

## File Structure

- `tools/authority-core.mjs`: sole parser and pure evaluator for authority schema v2, service modes, identity observations, target resolution, and canonical digests.
- `tests/authority-core.test.mjs`: focused schema, hard-gate, warning, service-mode, and no-switch tests.
- `config/ownership.json`: canonical source-repository authority registry.
- `config/template.json` and `template-init.example.json`: source manifest and explicit generated-repository authority input.
- `tools/template-core.mjs`: initialization normalization, replacement, fingerprints, and source-identity leakage contract.
- `tools/repository-policy.mjs`, `tools/template-readiness.mjs`, `tools/deployment-core.mjs`, `tools/domain-core.mjs`: consumers of the shared parser; no private partial ownership schema.
- `tools/workflow-core.mjs`: protected-main authority snapshot, external authorization, preflight/result receipt, risk, and exact-Head orchestration.
- `tools/issue-workflow.mjs`: CLI surface for v2 contract, request, preflight, and result validation.
- `tests/workflow-contract.test.mjs`, `tests/workflow-gate.test.mjs`, `tests/workflow-e2e.test.mjs`: authorization and exact-Head regression coverage.
- `.claude/settings.json`, `tools/generate-agent-wrappers.mjs`, generated `CLAUDE.md`: equal operator policy without Claude-only denies.
- `tools/guard-claude-tool.mjs` and `tests/guard-claude-tool.test.mjs`: deleted only after shared controls pass.
- Policy/spec/docs/UI/acceptance files: coherent operator-neutral language and traceability.

---

### Task 1: Canonical Authority Schema and Account Evaluation

**Files:**
- Create: `tools/authority-core.mjs`
- Create: `tests/authority-core.test.mjs`
- Modify: `config/ownership.json`

**Interfaces:**
- Produces: `parseAuthority(value): AuthorityConfiguration`
- Produces: `authorityDigest(value): "sha256:<64 lowercase hex>"`
- Produces: `evaluateAccountObservation(authority, observation): { ok: true, accountRef: string, targetRef: string | null, warnings: string[] }`
- Produces: `authorizeServiceUse(authority, input): { accountRef: string, targetRef: string | null, mode: string }`
- Produces: `readAuthority(root): AuthorityConfiguration`
- Consumes: no new production interfaces.

- [ ] **Step 1: Write failing schema and identity tests**

Add tests that import the five interfaces and assert:

```js
expect(parseAuthority(canonicalAuthority).authorization.operatorLabels)
  .toEqual(["codex", "claude"]);
expect(authorityDigest(canonicalAuthority)).toMatch(/^sha256:[0-9a-f]{64}$/u);
expect(() => evaluateAccountObservation(authority, {
  service: "github",
  account: { login: "company-user", userId: 1, nodeId: "wrong" },
  target: { repositoryId: 1340840341, repositoryNodeId: "R_kgDOT-uZlQ" },
})).toThrow(/account identity/u);
expect(evaluateAccountObservation(authority, githubObservation({ publicRepositories: 10 })).warnings)
  .toContainEqual(expect.stringMatching(/public repository count/u));
expect(() => authorizeServiceUse(authority, {
  service: "linear",
  operation: "linear.read_issue",
  purposeCode: "issue-contract",
  explicitUserPurpose: null,
})).toThrow(/explicit user purpose/u);
```

Also cover duplicate operator labels, malformed SHA-256 fingerprints, missing stable IDs for repository-active configured accounts, Cloudflare role/plan mismatch, Vercel team/plan mismatch, and `allowAutomaticAccountSwitch: true` rejection.

- [ ] **Step 2: Verify RED**

Run:

```sh
npm exec -- vitest run tests/authority-core.test.mjs
```

Expected: FAIL because `tools/authority-core.mjs` does not exist.

- [ ] **Step 3: Add schema v2 configuration**

Use these canonical source values:

```json
{
  "schemaVersion": 2,
  "authorization": {
    "operatorLabels": ["codex", "claude"],
    "externalOperatorRoles": ["implementer", "external-operator"],
    "allowAutomaticAccountSwitch": false
  },
  "accounts": {
    "github": {
      "login": "yuto1201",
      "userId": 50611866,
      "nodeId": "MDQ6VXNlcjUwNjExODY2"
    },
    "supabase": {
      "organizationName": "yuto1201's Org",
      "organizationId": "kmjpkzaqlewqnypyqwkg"
    },
    "vercel": {
      "teamName": "yuto",
      "teamSlug": "yuto16",
      "teamId": "team_ANEUn6gVL8dccPaY08wkvxFt",
      "requiredPlan": "Hobby"
    },
    "cloudflare": {
      "accountName": "Yuto Dev",
      "accountId": "7ea8e713d76506f9e303f58624829aa5",
      "loginEmailHint": "y***@icloud.com",
      "loginEmailSha256": "56875d39ea00e471ad20771dc3936f9ec92b565c7b31f725a1639a4cda71e982",
      "requiredRole": "Super Administrator",
      "allowedZonePlans": ["Free"]
    },
    "linear": {
      "workspaceName": "Yuto33004",
      "workspaceSlug": "yuto33004",
      "workspaceUrl": "https://linear.app/yuto33004",
      "workspaceId": null,
      "userName": "上杉侑斗",
      "userEmailHint": "y***@gmail.com",
      "userEmailSha256": "463920584f870bd7c73cc9056e6630b66cf812577f1d803fa409b39db7617039",
      "userId": null,
      "requiredRole": "Admin"
    }
  },
  "servicePolicies": {
    "github": { "mode": "repository-active" },
    "supabase": { "mode": "repository-active" },
    "vercel": { "mode": "repository-active" },
    "cloudflare": { "mode": "repository-active" },
    "linear": { "mode": "explicit-user-purpose-only" }
  },
  "resourceTargets": {
    "github": {
      "owner": "yuto1201",
      "repository": "Web-Template",
      "repositoryId": 1340840341,
      "repositoryNodeId": "R_kgDOT-uZlQ"
    },
    "supabase": { "projectRef": null },
    "vercel": { "projectId": "prj_KCauT0Bgq4PBZjrxuA1PO3J0Q3Q8" },
    "cloudflare": {
      "zoneId": "df938e9c196edf952ff26e95f02edf49",
      "domains": ["web-template.yutodev.com"]
    },
    "linear": { "teamKey": "YUT", "teamId": null }
  },
  "observations": {
    "github": {
      "displayName": " Yuuuuuuuto",
      "createdAt": "2019-05-14T06:31:57Z",
      "publicRepositories": 9,
      "observedAt": "2026-08-30T00:00:00+09:00"
    }
  }
}
```

- [ ] **Step 4: Implement the pure authority core**

Use strict Zod objects, canonical key sorting, and SHA-256. `evaluateAccountObservation` must compare service-specific hard fields, return warning strings only for `observations.github`, and reject pre/post account changes. `authorizeServiceUse` must reject Linear unless `explicitUserPurpose` is a non-empty single line and all Linear stable IDs/target IDs are non-null.

- [ ] **Step 5: Verify GREEN**

Run:

```sh
npm exec -- vitest run tests/authority-core.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Add the focused test to the ordinary Vitest suite and commit**

Run `npm test`, then:

```sh
git add tools/authority-core.mjs tests/authority-core.test.mjs config/ownership.json
git commit -m "feat: add canonical account authority"
```

---

### Task 2: Template, Policy, and Provider Consumer Migration

**Files:**
- Modify: `config/template.json`
- Modify: `template-init.example.json`
- Modify: `tools/template-core.mjs`
- Modify: `tools/repository-policy.mjs`
- Modify: `tools/template-readiness.mjs`
- Modify: `tools/deployment-core.mjs`
- Modify: `tools/domain-core.mjs`
- Modify: `tests/template-initializer.test.mjs`
- Modify: `tests/repository-policy.test.mjs`
- Modify: `tests/deployment-preflight.test.mjs`
- Modify: `tests/deployment-release.test.mjs`
- Modify: `tests/domain-workflow.test.mjs`

**Interfaces:**
- Consumes: Task 1 `readAuthority`, `parseAuthority`, `authorityDigest`.
- Produces: initialization config schema v2 with explicit `accounts`, `servicePolicies`, and `resourceTargets` groups.
- Preserves: existing deployment/domain exported interfaces and initializer command syntax.

- [ ] **Step 1: Write failing consumer and initializer tests**

Add tests proving:

```js
expect(() => normalizeInitializationConfig(configWithPartialVercelAccount))
  .toThrow(/partial authority/u);
expect(initializedAuthority.accounts.github.login).toBe("target-owner");
expect(initializedAuthority.accounts.linear.workspaceId).toBeNull();
expect(sourceLeakage).not.toContain("7ea8e713d76506f9e303f58624829aa5");
expect(secondRun.status).toBe("idempotent");
```

Update provider tests to expect `accounts.vercel.teamId`, `resourceTargets.vercel.projectId`, `accounts.cloudflare.accountId`, and `resourceTargets.cloudflare.zoneId` without changing their public validation behavior.

- [ ] **Step 2: Verify RED**

Run:

```sh
npm exec -- vitest run tests/template-initializer.test.mjs tests/repository-policy.test.mjs tests/deployment-preflight.test.mjs tests/deployment-release.test.mjs tests/domain-workflow.test.mjs
```

Expected: FAIL because consumers still parse ownership v1.

- [ ] **Step 3: Migrate template configuration and initializer**

Make `config/template.json` mirror schema v2 authority tokens and track every source identifier/fingerprint occurrence. Extend `template-init.example.json` with explicit account/service/target groups. Null or omitted provider-stable IDs must become inactive placeholders, never source values. Preserve reviewed token replacement, source verification, fingerprinting, and same-input idempotence.

- [ ] **Step 4: Migrate all ownership consumers to the canonical parser**

Remove private Zod ownership schemas and direct JSON field assumptions from repository policy, readiness, deployment, and domain tooling. Import `readAuthority` and read only canonical paths. Repository policy must verify template/ownership agreement with explicit semantic comparisons rather than whole-object equality where warning-only observations differ.

- [ ] **Step 5: Verify GREEN and source manifest**

Run:

```sh
npm exec -- vitest run tests/template-initializer.test.mjs tests/repository-policy.test.mjs tests/deployment-preflight.test.mjs tests/deployment-release.test.mjs tests/domain-workflow.test.mjs
npm run template:source-check
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```sh
git add config/ownership.json config/template.json template-init.example.json tools/authority-core.mjs tools/template-core.mjs tools/repository-policy.mjs tools/template-readiness.mjs tools/deployment-core.mjs tools/domain-core.mjs tests
git commit -m "refactor: centralize provider authority"
```

---

### Task 3: Protected-Main Authority and Exact External Authorizations

**Files:**
- Modify: `config/workflow.json`
- Modify: `tools/workflow-core.mjs`
- Modify: `tools/issue-workflow.mjs`
- Modify: `tests/workflow-contract.test.mjs`
- Modify: `tests/workflow-e2e.test.mjs`
- Modify: `tests/fixtures/workflow/happy-path.json`

**Interfaces:**
- Consumes: `parseAuthority`, `authorityDigest`, `authorizeServiceUse`.
- Produces: `loadProtectedAuthority(root, baseRef): { commitSha, authority, digest }`.
- Produces: Issue contract schema v2 field `externalAuthorizations`.
- Produces: `resolveExternalAuthorization(contract, request): ResolvedExternalAuthorization`.

- [ ] **Step 1: Write failing protected-main and authorization tests**

Create a temporary Git repository fixture where `main` contains target A and the candidate branch changes it to target B. Assert:

```js
const snapshot = loadProtectedAuthority(root, "main");
expect(snapshot.authority.resourceTargets.github.repository).toBe("target-a");
expect(snapshot.authority.resourceTargets.github.repository).not.toBe("target-b");
```

Update contract fixtures to freeze:

```js
externalAuthorizations: [{
  service: "github",
  operation: "github.merge_pr",
  purposeCode: "reviewed-release",
  purpose: "Merge the exact reviewed pull request for Issue 33.",
  accountRef: "accounts.github",
  targetRef: "resourceTargets.github",
  environment: "production",
  constraints: { issue: 33, method: "squash" },
  requiresExactHead: true,
}]
```

Test rejection of wrong purpose, account ref, target ref, environment, extra constraints, duplicate authorizations, and branch-local retargeting.

- [ ] **Step 2: Verify RED**

Run:

```sh
npm exec -- vitest run tests/workflow-contract.test.mjs tests/workflow-e2e.test.mjs
```

Expected: FAIL because contract v2 and protected-main loading do not exist.

- [ ] **Step 3: Implement protected-main loading and contract v2**

Read `config/ownership.json` with `git show <baseRef>:config/ownership.json`, verify the returned commit SHA, parse it canonically, and freeze its digest. Do not fall back to the candidate filesystem. Replace string-only contract authorization with strict objects and require operation-specific constraint schemas.

- [ ] **Step 4: Preserve Issue #33 migration boundary**

Do not let branch tooling use v2 candidate authority for Issue #33 delivery. Document and test that base-sourced v1 delivery remains external to the candidate v2 runtime. Do not add a permanent Issue-number exception to production code.

- [ ] **Step 5: Verify GREEN and commit**

Run focused tests, then:

```sh
git add config/workflow.json tools/workflow-core.mjs tools/issue-workflow.mjs tests/workflow-contract.test.mjs tests/workflow-e2e.test.mjs tests/fixtures/workflow/happy-path.json
git commit -m "feat: freeze exact external authorizations"
```

---

### Task 4: Preflight/Result Receipts and High-Risk Exact-Head Gate

**Files:**
- Modify: `tools/workflow-core.mjs`
- Modify: `tools/issue-workflow.mjs`
- Modify: `tests/workflow-contract.test.mjs`
- Modify: `tests/workflow-gate.test.mjs`
- Modify: `tests/workflow-e2e.test.mjs`

**Interfaces:**
- Produces: `validatePreflightReceipt(value, context): ValidatedPreflightReceipt`.
- Produces: `validateOperationResult(value, context): ValidatedOperationResult`.
- Produces: `requiresAuthoritativeHead(operation): boolean`.
- Preserves: `runAuthoritativePremergeGate` and all existing digest checks.

- [ ] **Step 1: Write failing receipt tests**

Define strict receipt fixtures containing schema version, one-use receipt ID, service, operator label, execution role/surface, authority/Issue/request/mutation digests, account/target observations, observed/expiry timestamps, and pre/post identities. Assert rejection for stale receipt, wrong surface, wrong digest, account switch, target switch, reuse, result before preflight, extra fields, and unrecognized operator/role.

- [ ] **Step 2: Write failing high-risk matrix tests**

Assert `true` for:

```js
[
  "github.merge_pr",
  "github.update_ruleset",
  "supabase.apply_migrations",
  "vercel.deploy_production",
  "cloudflare.upsert_dns"
]
```

Keep ordinary public GitHub metadata reads false unless used as protected mutation evidence.

- [ ] **Step 3: Verify RED**

Run focused workflow tests and confirm missing receipt/risk APIs cause the failure.

- [ ] **Step 4: Implement receipts and validation CLI**

Add `validate-preflight` and `validate-result` CLI commands. A request may declare operator metadata but cannot declare live identity as authority. Receipt validation calls Task 1 account evaluation, binds the frozen authorization, and returns only redacted derived evidence. Result validation requires identical pre/post account and target identities and prevents duplicate receipt consumption.

- [ ] **Step 5: Extend authoritative gate use without modifying its integrity checks**

Replace the three-operation inline list with `requiresAuthoritativeHead`. Do not change opposite-model mapping, reviewed SHA, diff digest, verify digest, contract digest, ruleset export, or GitHub workflow bootstrap code.

- [ ] **Step 6: Verify GREEN and commit**

```sh
npm exec -- vitest run tests/workflow-contract.test.mjs tests/workflow-gate.test.mjs tests/workflow-e2e.test.mjs
git add tools/workflow-core.mjs tools/issue-workflow.mjs tests/workflow-contract.test.mjs tests/workflow-gate.test.mjs tests/workflow-e2e.test.mjs
git commit -m "feat: validate account-bound operation receipts"
```

---

### Task 5: Claude/Codex Operator Parity and Role-Based Reviewer Isolation

**Files:**
- Modify: `.claude/settings.json`
- Modify: `tools/generate-agent-wrappers.mjs`
- Modify: `tests/generated-assets.test.mjs`
- Modify: `tools/repository-policy.mjs`
- Modify: `tools/completion-audit.mjs`
- Delete: `tools/guard-claude-tool.mjs`
- Delete: `tests/guard-claude-tool.test.mjs`
- Regenerate: `CLAUDE.md`, `.claude/agents/*.md`, `.codex/agents/*.toml`
- Create: `tests/operator-parity.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–4 authority/workflow gates.
- Preserves: generated evaluator read-only tool lists and Codex read-only sandbox mode.
- Produces: repository policy assertion that no model-specific deny/ownership boundary remains.

- [ ] **Step 1: Write failing operator-parity tests while the old guard still exists**

Assert:

```js
expect(settings.permissions?.deny ?? []).not.toContain("Bash");
expect(JSON.stringify(settings)).not.toContain("guard-claude-tool.mjs");
expect(await fileExists("tools/guard-claude-tool.mjs")).toBe(false);
expect(generatedClaude).toContain("same account-bound authority as Codex");
expect(generatedClaudeEvaluatorTools).toEqual(["Read", "Grep", "Glob"]);
expect(generatedCodexEvaluatorSandbox).toBe("read-only");
```

Also scan canonical policy/docs later for actor-specific operational bans; this task limits the scan to settings, generator, and generated assets.

- [ ] **Step 2: Verify RED**

Run:

```sh
npm exec -- vitest run tests/operator-parity.test.mjs tests/generated-assets.test.mjs
```

Expected: FAIL because the old deny/hook/guard still exists.

- [ ] **Step 3: Remove Claude-only repository restrictions last**

Reduce `.claude/settings.json` to ordinary project metadata without model-specific deny rules or the old hook. Update the generator entrypoint text to grant Claude the same account-bound implementer/external-operator policy rights as Codex. Delete the guard and its old tests only after the focused Task 1–4 suites are green in the same working tree.

- [ ] **Step 4: Keep reviewer roles read-only**

Do not broaden generated evaluator tools. Regenerate with `npm run generate`; confirm only implementer entrypoint authority changes.

- [ ] **Step 5: Replace repository/completion assertions**

Repository policy must require the shared authority files and reject residual Claude-only deny/hook text. Completion audit replaces `claude-guard` with focused `account-authority` and `operator-parity` checks.

- [ ] **Step 6: Verify GREEN and commit**

```sh
npm exec -- vitest run tests/authority-core.test.mjs tests/workflow-contract.test.mjs tests/workflow-gate.test.mjs tests/operator-parity.test.mjs tests/generated-assets.test.mjs tests/repository-policy.test.mjs
git add .claude .codex CLAUDE.md tools tests
git commit -m "refactor: grant equal account-bound operator rights"
```

---

### Task 6: Policy, Product, UI, and Acceptance Trace Migration

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `.github/pull_request_template.md`
- Modify: `src/app/page.tsx`
- Modify: `docs/authority.md`
- Modify: `docs/security.md`
- Modify: `docs/workflow.md`
- Modify: `docs/database.md`
- Modify: `docs/deployment.md`
- Modify: `docs/domain.md`
- Modify: `docs/activation.md`
- Modify: `docs/verification.md`
- Modify: `docs/onboarding-macos.md`
- Modify: `specs/product.md`
- Modify: `specs/architecture.md`
- Modify: `specs/acceptance.md`
- Modify: `specs/completion-audit.md`
- Modify: `specs/decisions.md`
- Modify: `config/acceptance.json`
- Modify: `tools/verify-acceptance-trace.mjs`
- Modify: `tests/page.test.tsx`
- Modify: `tests/links.test.mjs`
- Modify: `tests/repository-policy.test.mjs`

**Interfaces:**
- Consumes: final authority/workflow terminology from Tasks 1–5.
- Produces: accepted decision D-007 superseding D-003 and actor-specific D-004/D-006 clauses.
- Preserves: source-of-truth order, one-Issue workflow, secrets, exact-Head review, provider safety, and template guardrails.

- [ ] **Step 1: Write failing policy and copy tests**

Add assertions that canonical files contain `account-bound authority`, name both operators equally, describe Linear explicit-purpose denial, and do not contain these obsolete claims:

```text
Codex is the only actor
Codex-only external operations
External merge remains a Codex operation
Claude shell execution is disabled
Authenticated provider work stays with Codex
```

The test must allow historical D-003 text only when the same decision is marked superseded by D-007.

- [ ] **Step 2: Verify RED**

Run page, link, repository policy, and acceptance trace tests. Confirm failures identify obsolete actor-specific text or missing Issue #33 trace.

- [ ] **Step 3: Append D-007 and migrate normative docs**

Do not edit D-003 history. Add D-007 with date, accepted status, `Supersedes: D-003 and actor-specific portions of D-004/D-006`, decision, reason, enforcement boundary, and migration rule. Update every normative file to distinguish operator label, execution role, account identity, service mode, and exact target.

- [ ] **Step 4: Update UI and PR language**

Replace Codex-only copy with guarded operator-neutral copy. The PR template records primary model, external operator label, verified account/target references, and redacted receipt identifiers.

- [ ] **Step 5: Update acceptance trace**

Add Issue #33 to `config/acceptance.json`, remove the hard-coded fixed Issue list in favor of validated unique sorted Issue IDs or include #33 explicitly, and connect evidence to authority core, workflow receipts, operator parity, template verification, and this spec.

- [ ] **Step 6: Verify GREEN and commit**

```sh
npm exec -- vitest run tests/page.test.tsx tests/links.test.mjs tests/repository-policy.test.mjs
npm run audit:trace
npm run check:generated
git add AGENTS.md README.md .github/pull_request_template.md src/app/page.tsx docs specs config/acceptance.json tools/verify-acceptance-trace.mjs tests
git commit -m "docs: adopt account-bound operator policy"
```

---

### Task 7: Full Verification, Independent Review, and Delivery

**Files:**
- Modify only when verification or review exposes an Issue #33 defect.
- Create ignored evidence under `.artifacts/issues/33/` using protected-main v1 delivery tooling.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: exact-Head verification/review/PR/CI/merge evidence.

- [ ] **Step 1: Run all focused suites**

```sh
npm exec -- vitest run tests/authority-core.test.mjs tests/template-initializer.test.mjs tests/workflow-contract.test.mjs tests/workflow-gate.test.mjs tests/workflow-e2e.test.mjs tests/operator-parity.test.mjs tests/generated-assets.test.mjs tests/repository-policy.test.mjs
```

Expected: PASS with no warnings other than intentional warning-observation assertions.

- [ ] **Step 2: Run full repository verification**

```sh
npm run check
npm run template:verify
git diff --check
git status --short --branch
```

Expected: all commands succeed and the tracked tree contains only Issue #33 changes.

- [ ] **Step 3: Run independent Claude and Codex reviews**

Give each reviewer the Issue URL, spec, base SHA, exact candidate Head SHA, complete diff, and verification results. Require findings ordered by severity and explicit checks for self-authorizing authority, direct-tool bypass claims, Linear activation, reviewer role isolation, template source leakage, and exact-Head regression.

- [ ] **Step 4: Fix findings through TDD**

For each material finding, add or strengthen a failing regression test, verify RED, apply the minimal fix, rerun focused tests, and rerun the affected independent review. Any new commit invalidates earlier exact-Head review.

- [ ] **Step 5: Record exact-Head repository review evidence**

Use protected-main v1 Issue #33 contract/delivery tools so candidate v2 authority never authorizes itself. Record verification, review packet, opposite-model review, and gate output bound to the final Head.

- [ ] **Step 6: Push and open the PR**

Preflight the active GitHub account `yuto1201`, exact repository `yuto1201/Web-Template`, branch, diff, and final Head. Push `codex/33-account-bound-authority`, create a PR with `Closes #33`, verification evidence, both independent evaluations, external-change statement, and exact reviewed SHA.

- [ ] **Step 7: Wait for required CI and exact-Head policy**

Required checks: Repository checks, Database and Auth policy checks, macOS onboarding and browser checks, and Exact Head review policy. If main advances, update the branch, rerun verification, and obtain fresh opposite-model review.

- [ ] **Step 8: Squash merge and verify post-state**

Use protected-main authority and exact reviewed Head to squash merge. Confirm PR merged, Issue #33 closed, `main` contains the squash commit, required checks passed, and no provider resource was changed.

- [ ] **Step 9: Safe cleanup**

Delete only the exact merged remote branch and remove only `.worktrees/33-account-bound-authority` after cleanliness and merge evidence pass. Preserve all unrelated existing worktrees and branches.
