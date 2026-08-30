# Risk-tiered verification and review

## Status

Approved direction for Issue #35. The user approved the three-tier approach after a read-only audit and asked that implementation proceed after creating an Issue. Claude and Grok were consulted independently before this design was written.

## Problem

The repository applies almost the same delivery ceremony to a documentation correction and to an account-authority or production-provider change. The mechanical checks are individually short, but every new Head invalidates verification and model review evidence. Large Issues therefore multiply full verification and review rounds.

The solution must reduce routine work without creating a candidate-controlled escape hatch. High-risk authorization, authentication, database, provider, deployment, DNS, secret, and destructive-operation controls remain exact-Head and fail closed.

## Goals

1. Classify changes as `low`, `normal`, or `high` from protected-base policy and the actual merge-base diff.
2. Allow only a narrow documentation-only class to omit independent model review.
3. Keep one independent reviewer family for normal risk and both OpenAI and Anthropic families for high risk.
4. Keep every existing required GitHub check context while avoiding irrelevant expensive steps.
5. Provide a fast inner loop and reduce repeated verification and review rounds.
6. Strengthen currently under-classified reviewer-contract and operational-security documentation.

## Non-goals

- Reusing an ancestor review for a newer Head.
- Renaming or removing required GitHub status checks.
- Mutating the live GitHub ruleset.
- Weakening provider receipts, one-time claims, account/target continuity, exact-Head provider writes, RLS/Auth verification, or secret handling.
- Activating Supabase, Vercel, Cloudflare, Linear, DNS, deployments, or hosted database changes.

## Risk model

`config/execution.json` remains the canonical policy. It gains `lowRiskPathRules` and verification routing rules. Classification order is fixed:

1. Any high-risk path or high-risk external operation makes the change `high`.
2. Otherwise, a change is `low` only when it declares no external operation and every changed path matches the low-risk allowlist.
3. Every other change is `normal`.
4. Invalid policy, empty/invalid paths, unknown operations, or an unavailable protected policy fail upward rather than producing `low`.

The initial low-risk allowlist is documentation-only. High-risk rules take precedence and include authority/security/workflow/verification/activation/authentication/database/deployment/domain guidance, `specs/decisions.md`, Cursor authority specifications, and all `docs/agent-contracts/**`. Therefore editing reviewer instructions cannot qualify as low risk.

Candidate PR text, labels, operator input, or candidate-edited configuration cannot lower risk. GitHub continues to run the review gate from the checked-out protected base. Local workflow preparation loads the policy from the protected `main` ref; the migration PR itself is evaluated under the old policy and remains high risk.

## Review behavior

| Risk | Required independent review | Head binding |
|---|---|---|
| `low` | none | Gate still derives risk from the exact current diff and binds the PR body to current Head metadata. |
| `normal` | one family different from the primary family | Exact current Head. |
| `high` | approved OpenAI and Anthropic families | Exact current Head. |

Low risk does not bypass the review gate. The gate accepts an empty reviewer list only when its own trusted classification is `low`. A claimed `low` result for any non-allowlisted path is rejected. Privileged contracts are still derived, but every privileged or operational-security contract path is high risk.

## CI routing

The required context names remain unchanged:

- `Repository checks`
- `Database and Auth policy checks`
- `macOS onboarding and browser checks`
- `Exact Head review policy`

A non-required classification job computes a verification plan. Required jobs use `if: always()` and fail upward: if classification fails or outputs are absent, they run their current full path.

For pull requests, the classifier is loaded from the protected base checkout and inspects the candidate merge-base diff. During this bootstrap PR, if the protected base does not yet contain the classifier, it returns the full high-risk plan. Pushes to `main` also run the full plan.

Routing rules:

- High risk runs the current full repository, database/auth, macOS/browser, and clean-room checks.
- Normal risk always runs the full repository check. Database/Auth, macOS/browser, and clean-room steps run only when matching relevant paths.
- Low risk runs a documentation policy/link/generated-drift check. The other required contexts start and report a validated lightweight result without installing or starting unrelated services.
- `deployment:lint` and `domain:lint` are removed as duplicate CI steps because `npm run check` already contains both.
- The macOS context may use an Ubuntu runner only for a classified irrelevant lightweight result; its required check name remains unchanged. Classification failure selects macOS and the full path.

## Local verification cadence

`npm run check:fast` runs lint, typecheck, and unit tests for the implementation inner loop. It does not authorize review or merge.

- Low risk: run `npm run check:docs` before delivery.
- Normal risk: run focused tests while editing and one full `npm run check` at the final review Head.
- High risk: retain the current full check, relevant integration checks, clean-room verification, and exact-Head review requirements.
- `npm run audit:completion` is a high-risk/template-release/milestone audit, not a command to repeat after every small review fix.

## Scope and review-round budget

The default target is at most two independent review rounds: one consolidated review and one confirmation after material fixes. Findings should be batched before changing Head.

An Issue that is expected to exceed 30 changed files or 3,000 changed lines should be split into independently safe preparatory and behavior-switch Issues. If atomicity genuinely requires a larger change, the review evidence records a short scope rationale. This is an efficiency guard, not a security bypass; exceeding it never lowers risk or skips verification.

The first implementation records this rule in workflow guidance and exposes the thresholds in `config/workflow.json`. It does not reject a safe migration solely because a line estimate was inaccurate.

## Components

### `tools/execution-policy.mjs`

- Extend the risk schema with `low`.
- Strictly validate unique low/high path rules and disallow ambiguous duplicate rules within each tier.
- Classify high first, low only when every path is allowlisted, otherwise normal.
- Return no reviewer families for low and accept an empty reviewer list only for low.
- Produce a verification plan from changed paths and risk.

### `tools/ci-change-plan.mjs`

- Read the protected policy and derive changed paths with `git diff --no-renames` from merge base to Head.
- Emit canonical JSON and optional GitHub outputs.
- Return a full high-risk plan for explicit bootstrap/main-push mode.
- Exit nonzero on invalid inputs; workflows interpret failure as full verification.

### Workflow core and GitHub gate

- Parse and render low-risk evidence without reviewer lines.
- Permit zero review artifacts only for trusted low risk.
- Continue requiring current-Head verification and packet binding.
- Load local risk policy from protected `main` for review preparation and gating.
- Add reviewer contracts to privileged/high-risk routing.

### CI workflow

- Add classification and conservative fallback.
- Preserve all required context names.
- Conditionally execute expensive steps based on trusted outputs.
- Remove duplicate deployment/domain steps.

### Documentation and generated assets

- Update `AGENTS.md`, workflow, verification, decisions, PR template, and generated wrappers as required.
- State clearly that low risk is derived, not requested, and never applies to operational-security instructions.

## Failure behavior

- Missing trusted classifier or policy: full high-risk verification.
- Candidate claims low but trusted classification is normal/high: reject.
- Low-risk evidence contains reviewer claims: reject non-canonical extra evidence rather than silently accepting it.
- Normal/high evidence omits required reviewers: reject.
- Required CI routing output is missing or malformed: run full job path.
- New or unmatched paths: at least normal; high-risk namespaces remain high.

## Testing

TDD covers:

1. Documentation-only allowlisted paths classify low with no reviewers.
2. Mixed low and application paths classify normal.
3. Every security/authority/reviewer-contract/CI/auth/database/provider/deploy/DNS path classifies high.
4. External operations prevent low classification; high-risk writes remain high.
5. Empty reviewers pass only for low; normal/high retain existing requirements.
6. GitHub review bodies with low risk accept zero reviewer lines only when trusted classification is low.
7. Candidate risk reduction and candidate policy edits cannot affect trusted GitHub classification.
8. CI plans run all checks for high/unknown, relevant subsets for normal, and the lightweight path for low.
9. Workflow tests prove required context names and fail-up conditions remain present.
10. Existing provider, receipt, authority, template, and exact-Head regression suites remain green.

## Rollout

This PR is high risk under the existing protected policy and therefore uses full CI, clean-room verification, and exact-Head independent review. The new low-risk behavior becomes available only after the reviewed implementation is merged into protected `main`.
