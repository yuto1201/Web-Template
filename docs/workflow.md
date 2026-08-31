# Issue-to-merge workflow

The canonical state names, transitions, model-family review mapping, and privileged-path contracts live in `config/workflow.json`. Runtime validation lives in `tools/workflow-core.mjs`; `npm run workflow -- <command>` is its operator CLI.

## 1. Define

- Create a GitHub Issue with a goal, in-scope work, out-of-scope work, acceptance criteria, and dependencies.
- Keep a single coherent outcome per Issue.
- Resolve material architecture or account questions before implementation.
- Snapshot the accepted Issue contract into `.artifacts/issues/<issue>/issue-contract.json`. Its digest freezes the goal, numbered `AC-*` criteria, dependencies, and allowlisted external operations for the run.

## 2. Branch

- Start from updated `main`.
- Use `codex/<number>-<slug>` for Codex-labeled work or `claude/<number>-<slug>` for Claude-labeled work. The prefix is audit metadata, not authority.
- Claude and Codex have equal account-bound authority in implementer and external-operator roles. Git and GitHub operations still require the protected-main account/target, Issue purpose, guarded receipts, and exact-Head review where applicable.
- Confirm the working tree and preserve unrelated user changes.

## 3. Implement

- Read `AGENTS.md`, the Issue, relevant specs, and existing tests.
- Make the smallest complete change that satisfies the Issue.
- Keep external provider operations separate from local code changes and run supported operations only through the provider-specific guarded adapter's request/preflight/claim/mutation/result/finalized lifecycle.
- A provider operation is executable only when both its strict registry contract and a production provider client exist. This release exposes `npm run provider:github`; registered Supabase, Vercel, and Cloudflare mutations remain non-executable until later Issues add their clients.
- Update durable specifications and decisions in the same change.
- For product UI, follow [the site-wide theme contract](../specs/design-system.md): draft after users/MVP are known; record user confirmation of a representative desktop/mobile preview before implementing individual pages. Only the bounded nonfunctional confirmation prototype may precede confirmation. Bootstrap records the draft/next step without building UI; independent authorized setup/backend work may continue.
- Reuse shared tokens/components on every surface and record minor changes in the Issue/PR without per-page approval. Reconfirm only material direction changes. Theme confirmation does not replace the existing risk-derived verification/review or authorize external operations.
- Persist state transitions so an interrupted run resumes from recorded evidence instead of inference.
- Use focused tests or `npm run check:fast` during the inner loop. Ask reviewers for one complete pass and batch findings before revising instead of starting a new round per finding.
- Treat 30 changed files or 3,000 changed lines as advisory scope limits. Split oversized work into independently safe Issues, or record why atomic delivery is justified; never lower risk to fit the limit.

## 4. Verify

- Let the protected-base policy derive `low`, `normal`, or `high` from the actual merge-base diff. Candidate text, labels, and candidate-edited policy cannot lower it.
- Low runs `npm run check:docs` once at the final Head. Normal and high run one final `npm run check` at the review Head; rerun it only if code or generated artifacts change afterward.
- Run Issue-specific database, build, browser, deployment, macOS, or template checks when the trusted change plan selects them. High risk runs every relevant integration.
- Record commands, outcomes, and any checks that could not run.
- Do not use a successful build as a substitute for behavior or authorization tests.
- Bind `verify.json` to the exact current Head SHA and frozen Issue digest. Map every acceptance criterion exactly once with concrete evidence.
- After committing the implementation, run `prepare-review`; it derives the base, Head, byte-exact Git diff, changed paths, digests, and privileged contracts from Git rather than caller input.
- Required CI success on the exact unchanged Head satisfies the before-merge rerun. Do not run an identical local suite solely for ceremony. Reserve the completion audit for high-risk, template-release, or milestone work.

## 5. Review

- Send a bounded diff and acceptance criteria to an independent model.
- The reviewer remains read-only and returns severity-ranked findings.
- Address material findings or record a concrete rationale before merge.
- Target at most two review rounds by batching all findings from each pass. A low-risk packet has no reviewer artifacts; normal needs one different observed family; high needs approved OpenAI and Anthropic families.
- Follow `docs/agent-contracts/review-packet.md`. A new commit makes the packet and review stale.
- The implementer records the opposite model's strict JSON with `record-review`; the reviewer cannot write Issue evidence directly or self-approve.
- If the opposite model is unavailable or returns invalid output, record `blocked:review`; self-approval is forbidden.

## 6. Pull request and merge

- Open a draft PR linked with `Closes #<number>`.
- Include scope, verification evidence, external changes, and known limitations.
- Mark ready only after local checks and independent review.
- The `Exact Head review policy` workflow reads the GitHub event file and compares the PR body's reviewed SHA with the current GitHub-supplied Head. It derives changed paths from the Git merge-base so a base-only commit cannot expand the PR's review scope. It derives risk and required reviewer families from `config/execution.json`, keeps the primary operator label separate from model identity, and requires all contracts selected by changed privileged paths. Editing the body reruns the check; any new commit makes prior review stale.
- Wait for required CI. Squash merge and verify `main` contains the result and the Issue is closed.
- Run the current-Head gate before rendering the PR body or requesting merge. Merge is a GitHub high-risk write available equally to either operator label only after protected-main account/target checks, one-time receipt claim, and exact-Head authorization.

### GitHub evidence boundary

The PR body is an auditable mirror of exact-Head evidence, not an authenticated account identity or proof of authority for either operator label. The GitHub check prevents stale or malformed review claims and runs the verifier from the base branch after initial rollout, but a repository administrator or a malicious workflow change can bypass it. Local review and state-machine files under `.artifacts/` remain ignored and authoritative for the merge request gate. Redacted external-operation lifecycle copies instead live under committed `evidence/external-operations/`; the gate reads their bytes from the reviewed Head, verifies every declared digest and linkage field, and rejects undeclared lifecycle files. Do not use `pull_request_target`, interpolate PR body text into shell commands, or add path/job filters to the required workflow.

The single Issue/branch/PR rule has one narrow exception: Dependabot GitHub Actions updates. The exception passes only when GitHub reports the pinned `dependabot[bot]` identity, the branch belongs to the same repository and uses the `dependabot/github_actions/` prefix, every changed file is an allowlisted workflow YAML path, and every changed diff line only replaces the version of an allowlisted `uses:` action. npm and application dependency PRs, forks, new actions, workflow logic changes, and mixed changes require the normal Issue and cross-model review path.

The workflow initially falls back to the candidate verifier only for the fixed #22 branch on its recorded pre-gate base SHA and only when the Head and base repositories are identical; any other missing base verifier fails closed. The one-shot guard intentionally remains as unreachable compatibility code after `main` advances beyond that SHA. The active ruleset name and required check name are fixed in `config/workflow.json`, and the exported ruleset pins the exact-Head check plus all three repository CI jobs to the GitHub Actions App. GitHub ruleset mutation is not registered in the guarded adapter and therefore fails closed; a later Issue must add its complete operation contract before the exported ruleset may be activated or changed. Strict status checks require an updated branch and fresh policy-required reviews after concurrent changes land on `main`.

## State machine

The normal path is:

```text
proposed -> approved -> claimed -> in-progress -> verify-passed
         -> review-requested -> approved-for-merge -> merged -> done
```

Review findings return to `changes-requested -> in-progress`. Blocked states record the prior state as `resumeState` and may recover only to that exact state. This prevents a resumed run from skipping verification or review.

## Account-bound external-operation transport

An implementer or external-operator creates a strict request under `.artifacts/ops-requests/<request-id>.json`. The request records `operatorLabel`, `executionRole`, development `executionSurface`, fixed authenticated `providerSurface`, frozen authorization, intent, reversibility, recovery, and exact operation inputs; it does not grant authority. This separation ensures a Cursor run still needs run-bound activation even when the provider transport is `github-cli`. For a merge, use the complete generator and validate the resulting request:

```bash
npm run workflow -- request-merge --issue 33 --pr-number 123 --operator-label codex --execution-role external-operator --surface codex-local
npm run workflow -- validate-request --file .artifacts/ops-requests/issue-33-github-merge-pr-1.json
npm run provider:github -- --request .artifacts/ops-requests/issue-33-github-merge-pr-1.json --model-family gpt
```

Requests use strict schema v2 Issue `externalAuthorizations`, a fixed operation allowlist, an operation-specific environment and purpose code, and inputs bound to the Issue. The frozen contract includes a protected-main authority commit and digest; candidate ownership edits never authorize the current branch. Unknown or out-of-scope operations, operations without production clients, free-form accounts/targets, additional fields such as `prompt` or `force`, path escapes, malformed JSON, and mismatched Issue inputs are rejected. Missing targets block execution. Repository-content-derived high-risk writes rerun the authoritative review gate, and any supplied Head SHA must match it. The provider-specific adapter obtains preflight, claim-time, and postflight observations itself through one authenticated client. Caller-authored provider JSON and the legacy `validate-preflight`, `claim-execution`, and `validate-result` CLI commands cannot authorize a mutation. Account/target switches and unchanged-input retries after ambiguous results are forbidden.

At most one pre-merge provider mutation may be declared by a pull request. Execute it at reviewed Head `H`. The adapter writes six canonical redacted files below `evidence/external-operations/<request-id>/`. Commit exactly those six files as the next first-parent commit `H2`; no application, policy, configuration, or other file may share that commit. Then run `npm run workflow -- bind-external-evidence --directory evidence/external-operations/<request-id>` and place its single-line JSON in the PR External changes section. Local and GitHub gates re-derive the protected authority, frozen contract, authorization, request, mutation, receipt, claim, result, and finalized digest chain; require `H` as `H2`'s parent; require the authority commit to be an ancestor of the protected base; and reject any non-evidence path in that successor commit. This evidence-only successor rule avoids relabeling an operation to a later code Head.

PR merge is the delivery action itself and cannot be attested inside the PR it merges. It is authorized by the protected-base exact-Head gate and records its result outside that candidate PR. Issue #33 specifically uses the protected-main v1 delivery path; candidate v2 authority never authorizes its own delivery.

PR `externalChanges` evidence is structured rather than free-form. Each entry records service, operation, operator label, execution role, model family, protected account and target references, service mode, exact executed Head, outcome, and six unique committed references with SHA-256 digests: request, preflight, claim, mutation, result, and finalized. The preflight and result must share one redacted `receiptId`; claim carries the fresh observation digest; mutation carries the provider idempotency-key digest. The local and GitHub gates load all six files from the reviewed commit, reject a digest or linkage mismatch, and reject committed external-operation files when `externalChanges` is empty. Record only redacted fields—never tokens, secrets, raw email addresses, or raw provider identity observations.

Write claims use the Git common directory so sibling worktrees share one-use state. Each supported write requires provider-enforced idempotency for separate-clone safety; execution fails closed when the provider operation offers none. Read-only operations still require a fresh authorization and receipt but may repeat within their explicit freshness window.

The registered contract names are `github.read_issue`, `github.push_branch`, `github.create_pr`, `github.merge_pr`, `github.delete_branch`, `supabase.inspect_project`, `supabase.apply_migrations`, `vercel.inspect_project`, `vercel.deploy_preview`, `vercel.deploy_production`, `cloudflare.inspect_zone`, and `cloudflare.upsert_dns`. Only `github.read_issue` and `github.merge_pr` have a production provider client in this release; all other registered names remain non-executable. GitHub ruleset updates, Supabase Auth-policy updates, Vercel configuration and rollback, and Cloudflare rollback are unsupported and denied until separately registered.

## Commands

```bash
# Provider-free end-to-end fixture
npm run workflow -- simulate --fixture tests/fixtures/workflow/happy-path.json --root <temporary-directory>

# Derive packet/diff/digests from the real committed Head
npm run workflow -- prepare-review --input <verification-input.json>

# Validate and record the opposite model's strict JSON result
npm run workflow -- record-review --issue <issue> --file <review.json>

# Validate canonical evidence against the real repository before merge
npm run workflow -- gate --issue <issue>

# Render the gated PR body
npm run workflow -- render-pr --issue <issue> --output .artifacts/issues/<issue>/<head>/pull-request.md

# Create a strict squash-merge request only after the same authoritative gate passes
npm run workflow -- request-merge --issue <issue> --pr-number <pr-number> --operator-label <codex-or-claude> --execution-role <implementer-or-external-operator> --surface <codex-local-or-claude-local>

# Validate an exact-target cleanup plan; this command does not delete anything
npm run workflow -- cleanup-check --file <cleanup-plan.json>
```

## Cleanup

Cleanup is never inferred from Git ancestry because squash merge replaces commit identity. The authorized operator supplies redacted provider evidence for an exact `MERGED` PR, non-null merge commit, matching `headRefOid`, recorded Head SHA, and confirmed exact remote-branch deletion. `cleanup-check` then independently re-derives the local branch SHA, matching Issue branches/worktrees, and target worktree cleanliness from Git. The validator returns the two exact local actions; the operator performs them separately through the same account-bound boundary. Dirty, unmerged, ambiguous, stale, escaped, or unrelated targets are refused and unrelated worktrees/branches are preserved. Cleanup is destructive and must never broaden the frozen target.
