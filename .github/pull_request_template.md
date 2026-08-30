Closes #

## Summary

- Describe the user-visible or operational outcome.

## Verification

- Head SHA: `current-head-sha`
- Contract digest: `sha256:...`
- `npm run check`: pending

## Acceptance evidence

- AC-1: pending

## Opposite-model review

- Primary operator: `codex` or `claude`
- Reviewer operator: `codex` or `claude`
- Primary model family: `gpt` or `claude`
- Reviewer model family: the opposite model family
- Reviewed SHA: `current-head-sha`
- Verdict: pending
- Contracts: `change-evaluator` and any privileged-path auditors

## External changes

- None.

## External-change evidence format

- For each pre-merge authenticated external change, replace `None` above with one single-line `Operation evidence` JSON object produced by `workflow bind-external-evidence` from the six-file evidence-only successor commit. PR merge itself is protected-base delivery evidence, not candidate-PR external-change evidence.
- Operator label: `codex` or `claude`
- Execution role: `implementer` or `external-operator`
- Model family: `gpt` or `claude`
- Account ref: protected-main authority reference
- Service mode: `repository-active` or `explicit-user-purpose-only`
- Exact target ref: protected-main authority reference
- Redacted preflight receipt ID: `receipt-...`
- Redacted execution claim reference: `<mutation-digest>.claim.json`
- Redacted finalized result receipt ID: `receipt-...`
- Redacted finalized marker reference: `<mutation-digest>.finalized.json`
- Authority digest: `sha256:...`
- Issue contract digest: `sha256:...`
- Request digest: `sha256:...`
- Mutation digest: `sha256:...`
- Execution claim digest: `sha256:...`
- Finalized result digest: `sha256:...`
- Exact-Head gate SHA: `current-head-sha`, when required
- Destructive or rollback scope: none, or the exact reviewed recovery boundary

## Remaining work

- None for this Issue, or list explicit limitations.
