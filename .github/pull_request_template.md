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

- None, or list the exact Codex-operated provider changes and redacted evidence.

## Remaining work

- None for this Issue, or list explicit limitations.
