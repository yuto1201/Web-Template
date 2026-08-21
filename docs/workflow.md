# Issue-to-merge workflow

## 1. Define

- Create a GitHub Issue with a goal, in-scope work, out-of-scope work, acceptance criteria, and dependencies.
- Keep a single coherent outcome per Issue.
- Resolve material architecture or account questions before implementation.

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

## 4. Verify

- Run `npm run check`.
- Run Issue-specific database, build, browser, or deployment checks.
- Record commands, outcomes, and any checks that could not run.
- Do not use a successful build as a substitute for behavior or authorization tests.

## 5. Review

- Send a bounded diff and acceptance criteria to an independent model.
- The reviewer remains read-only and returns severity-ranked findings.
- Address material findings or record a concrete rationale before merge.

## 6. Pull request and merge

- Open a draft PR linked with `Closes #<number>`.
- Include scope, verification evidence, external changes, and known limitations.
- Mark ready only after local checks and independent review.
- Wait for required CI. Squash merge and verify `main` contains the result and the Issue is closed.

Issue #5 adds machine-readable run state and evidence packets so this workflow can resume safely after interruption.
