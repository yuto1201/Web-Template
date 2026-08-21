# Issue-to-merge workflow

The canonical state names, transitions, reviewer mapping, and privileged-path contracts live in `config/workflow.json`. Runtime validation lives in `tools/workflow-core.mjs`; `npm run workflow -- <command>` is its operator CLI.

## 1. Define

- Create a GitHub Issue with a goal, in-scope work, out-of-scope work, acceptance criteria, and dependencies.
- Keep a single coherent outcome per Issue.
- Resolve material architecture or account questions before implementation.
- Snapshot the accepted Issue contract into `.artifacts/issues/<issue>/issue-contract.json`. Its digest freezes the goal, numbered `AC-*` criteria, dependencies, and allowlisted external operations for the run.

## 2. Branch

- Start from updated `main`.
- Use `codex/<number>-<slug>` for Codex-led work or `claude/<number>-<slug>` for Claude-led local work.
- For Claude-led work, Codex creates the branch, runs validation, commits, pushes, and performs all GitHub operations. Claude only edits the explicitly assigned local application files.
- Confirm the working tree and preserve unrelated user changes.

## 3. Implement

- Read `AGENTS.md`, the Issue, relevant specs, and existing tests.
- Make the smallest complete change that satisfies the Issue.
- Keep external provider operations separate from local code changes and run them only through Codex preflight.
- Update durable specifications and decisions in the same change.
- Persist state transitions so an interrupted run resumes from recorded evidence instead of inference.

## 4. Verify

- Run `npm run check`.
- Run Issue-specific database, build, browser, or deployment checks.
- Record commands, outcomes, and any checks that could not run.
- Do not use a successful build as a substitute for behavior or authorization tests.
- Bind `verify.json` to the exact current Head SHA and frozen Issue digest. Map every acceptance criterion exactly once with concrete evidence.
- After committing the implementation, run `prepare-review`; it derives the base, Head, byte-exact Git diff, changed paths, digests, and privileged contracts from Git rather than caller input.

## 5. Review

- Send a bounded diff and acceptance criteria to an independent model.
- The reviewer remains read-only and returns severity-ranked findings.
- Address material findings or record a concrete rationale before merge.
- Follow `docs/agent-contracts/review-packet.md`. A new commit makes the packet and review stale.
- Codex records the opposite model's strict JSON with `record-review`; the reviewer cannot write Issue evidence directly.
- If the opposite model is unavailable or returns invalid output, record `blocked:review`; self-approval is forbidden.

## 6. Pull request and merge

- Open a draft PR linked with `Closes #<number>`.
- Include scope, verification evidence, external changes, and known limitations.
- Mark ready only after local checks and independent review.
- The `Exact Head review policy` workflow reads the GitHub event file and compares the PR body's reviewed SHA with the current GitHub-supplied Head. It derives changed paths from the Git merge-base so a base-only commit cannot expand the PR's review scope. It also enforces the configured opposite-model mapping and required contracts for changed privileged paths. Editing the body reruns the check; any new commit makes the prior reviewed SHA stale.
- Wait for required CI. Squash merge and verify `main` contains the result and the Issue is closed.
- Run the current-Head gate before rendering the PR body or requesting merge. External merge remains a Codex operation.

### GitHub evidence boundary

The PR body is an auditable mirror of local exact-Head evidence, not an authenticated identity for Codex or Claude. The GitHub check prevents stale or malformed review claims and runs the verifier from the base branch after initial rollout, but a repository administrator or a malicious workflow change can bypass it. Local `.artifacts/` remain ignored and authoritative for Codex's merge request gate. Do not use `pull_request_target`, interpolate PR body text into shell commands, or add path/job filters to the required workflow.

The single Issue/branch/PR rule has one narrow exception: Dependabot GitHub Actions updates. The exception passes only when GitHub reports the pinned `dependabot[bot]` identity, the branch belongs to the same repository and uses the `dependabot/github_actions/` prefix, every changed file is an allowlisted workflow YAML path, and every changed diff line only replaces the version of an allowlisted `uses:` action. npm and application dependency PRs, forks, new actions, workflow logic changes, and mixed changes require the normal Issue and opposite-model review path.

The workflow initially falls back to the candidate verifier only for the fixed #22 branch on its recorded pre-gate base SHA and only when the Head and base repositories are identical; any other missing base verifier fails closed. The one-shot guard intentionally remains as unreachable compatibility code after `main` advances beyond that SHA. Codex enables the branch ruleset only after the bootstrap PR is merged and a base-sourced live run passes. The active ruleset name and required check name are fixed in `config/workflow.json`, and the exported ruleset pins the exact-Head check plus all three repository CI jobs to the GitHub Actions App. Changing any of these requires a reviewed migration and corresponding provider update. Strict status checks intentionally require an updated branch and a fresh opposite-model review after concurrent changes land on `main`.

## State machine

The normal path is:

```text
proposed -> approved -> claimed -> in-progress -> verify-passed
         -> review-requested -> approved-for-merge -> merged -> done
```

Review findings return to `changes-requested -> in-progress`. Blocked states record the prior state as `resumeState` and may recover only to that exact state. This prevents a resumed run from skipping verification or review.

## Fixed external-operation transport

Claude may write only a strict request under `.artifacts/ops-requests/<request-id>.json`. It cannot execute the request. Codex validates it with:

```powershell
npm run workflow -- validate-request --file .artifacts/ops-requests/<request-id>.json
```

Requests use `schemaVersion: 1`, a fixed operation allowlist, an ownership-config identifier, an operation-specific environment and reason code, a request ID bound to the Issue/operation, and strict inputs. The request operation must also appear in the frozen Issue contract; requests are therefore available only after Codex snapshots the Issue. Unknown or out-of-scope operations, free-form targets, additional fields such as `prompt` or `force`, path escapes, malformed JSON, and mismatched Issue inputs are rejected. The validator resolves the actual target from `config/ownership.json`; a missing target blocks execution. Merge and production release/DNS requests additionally rerun the authoritative review gate, and any supplied Head SHA must match it. Expected evidence is derived by the validator, never supplied as free-form reviewer authority. Results belong in `.artifacts/ops-results/<request-id>.result.json` after Codex preflight and execution.

## Commands

```powershell
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
npm run workflow -- request-merge --issue <issue> --pr-number <pr-number>

# Validate an exact-target cleanup plan; this command does not delete anything
npm run workflow -- cleanup-check --file <cleanup-plan.json>
```

## Cleanup

Cleanup is never inferred from Git ancestry because squash merge replaces commit identity. Codex first supplies redacted provider evidence for an exact `MERGED` PR, non-null merge commit, matching `headRefOid`, recorded Head SHA, and confirmed exact remote-branch deletion. `cleanup-check` then independently re-derives the local branch SHA, matching Issue branches/worktrees, and target worktree cleanliness from Git. The validator returns the two exact local actions; Codex performs them separately. Dirty, unmerged, ambiguous, stale, escaped, or unrelated targets are refused and unrelated worktrees/branches are preserved. The validator cannot authenticate provider evidence itself; that evidence comes from Codex's personal-account preflight and post-check.
