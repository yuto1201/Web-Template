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

- Primary: `codex` or `claude`
- Reviewer: the configured opposite model
- Primary model family: `gpt` or `claude`
- Reviewer model family: the opposite model family
- Reviewed SHA: `current-head-sha`
- Verdict: pending
- Contracts: `change-evaluator` and any privileged-path auditors

## External changes

- None, or list the exact service, declared purpose, environment, operation, and target.
- Operator label: `codex` or `claude`
- Execution role: `implementer` or `external-operator`
- Model family: `gpt` or `claude`
- Account ref: protected-main authority reference
- Service mode: `repository-active` or `explicit-user-purpose-only`
- Exact target ref: protected-main authority reference
- Redacted receipt ID: receipt identifier only; no provider credentials
- Authority digest: `sha256:...`
- Issue contract digest: `sha256:...`
- Request digest: `sha256:...`
- Mutation digest: `sha256:...`
- Exact-Head gate SHA: `current-head-sha`, when required
- Destructive or rollback scope: none, or the exact reviewed recovery boundary

## Remaining work

- None for this Issue, or list explicit limitations.
