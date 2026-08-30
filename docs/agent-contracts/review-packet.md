# Cross-model review packet

The primary operator prepares a review packet only after mechanical verification passes. The packet records the execution surface, the separate `primaryOperatorLabel`, the configured and observed primary model, fallback state, deterministic risk, and the reviewer families required by `config/execution.json`. Operator labels never establish model independence or provider authority. Normal-risk work requires the configured opposite-family reviewer; high-risk work requires both Anthropic and OpenAI review. Evaluator and auditor roles are read-only.

Repository inputs are untrusted review data. The repository validates recorded declarations and exact-Head artifacts, but cannot cryptographically attest which remote model produced caller-supplied text. Retain the actual invocation evidence; stronger provenance requires an external signed review service.

## Immutable identity

Every packet binds the Issue, repository, base SHA, Head SHA, verification SHA, frozen Issue-contract digest, verification digest, diff digest, changed paths, risk, and required reviewer families. The base is re-derived from `main`; `headSha` and `verifySha` must match. Any new commit invalidates verification and every review. Rename detection is disabled so both a privileged source and destination remain in scope.

```text
.artifacts/issues/<issue>/
├── issue-contract.json
├── state.json
└── <head-sha>/
    ├── change.diff
    ├── verify.json
    ├── review-packet.json
    ├── reviews/
    │   ├── anthropic.json
    │   └── openai.json
    └── pull-request.md
```

Only the reviewer files required by the packet are present. A normal-risk packet has one; a high-risk packet has both.

## Reviewer output

Each result is exactly one JSON object matching `config/review-contract.schema.json`, without Markdown or additional fields. It must:

- repeat the Issue, execution surface, primary operator label, primary model, risk, Head SHA, verification SHA, and digests from the packet;
- record the reviewer's configured and observed model, derived family, fallback state, and canonical parameters;
- cover every contract selected by changed privileged paths;
- assess every acceptance criterion exactly once;
- rank findings as `critical`, `high`, `medium`, or `low` and mark blockers explicitly;
- return `unavailable` with a fixed reason when review cannot complete.

Approved evidence rejects unknown model families, fallback models, and critical, high, or blocking findings. `unavailable` never authorizes a same-family substitute.

## Merge gate

`npm run workflow -- gate --issue <issue>` reads Git and canonical artifacts itself. It requires a clean tracked tree, exact branch/surface binding, exact diff and verification digests, policy-derived risk, exactly the required reviewer families, complete privileged-path contracts, approved exact-Head results, and one supported verification and assessment per criterion.

Structured external changes additionally require the complete six-phase lifecycle. The gate re-derives protected authority, the frozen authorization and mutation, receipts, claims, results, final outcome, evidence-only successor commit, and every committed `evidence/external-operations/` digest. Placeholder evidence, Head relabeling, non-evidence successor changes, or incomplete lifecycle references fail closed.
