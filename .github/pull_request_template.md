Closes #

## Summary

- Describe the user-visible or operational outcome.

## Verification

- Head SHA: `current-head-sha`
- Contract digest: `sha256:...`
- `npm run check`: pending

## Acceptance evidence

- AC-1: pending

## Cross-model review

- Execution surface: codex-local, claude-local, or cursor-cloud
- Primary operator label: codex or claude
- Primary configured model: exact configured model ID
- Primary observed model: exact observed model ID
- Primary family: openai, anthropic, cursor, or xai
- Primary fallback: false
- Risk: normal or high
- Risk reasons: none, or the canonical comma-separated derived reasons
- Reviewed SHA: `current-head-sha`
- Reviewer anthropic: exact configured model ID | exact observed model ID | anthropic | false | approved | change-evaluator, and any privileged-path auditors
- Reviewer openai: exact configured model ID | exact observed model ID | openai | false | approved | change-evaluator, and any privileged-path auditors

## External changes

- None.

## External-change evidence format

- A pull request may declare at most one pre-merge authenticated external change. Replace `None` above with one single-line `Operation evidence` JSON object produced by `workflow bind-external-evidence` from the six-file evidence-only successor commit. PR merge itself is protected-base delivery evidence, not candidate-PR external-change evidence.
- Operator label: `codex` or `claude`
- Execution role: `implementer` or `external-operator`
- Model family: `gpt` or `claude`
- Account ref: protected-main authority reference
- Service mode: `repository-active`; Linear is `explicit-user-purpose-only` but has no registered operation and cannot produce operation evidence
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
