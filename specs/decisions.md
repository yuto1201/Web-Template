# Decision log

Decisions are append-only. To change one, add a new entry that explicitly supersedes the old entry.

## D-001: GitHub template is the canonical distribution

- Status: accepted
- Date: 2026-08-21
- Decision: maintain this repository as a GitHub Template repository. An optional initialization tool may validate or replace project identifiers, but it is not the source of truth.
- Reason: this keeps the repository easy to inspect and update while avoiding an early custom generator framework.

## D-002: Cloudflare provides DNS, Vercel serves the application

- Status: accepted
- Date: 2026-08-21
- Decision: begin with Cloudflare DNS-only records that point to Vercel. Do not place the Cloudflare proxy in front of Vercel unless a later project-specific decision documents the need and validation.
- Reason: it keeps the hosting and certificate path conventional and removes an unnecessary initial caching/proxy layer.

## D-003: External operations are Codex-only

- Status: accepted
- Date: 2026-08-21
- Decision: Claude may review or modify local files but must delegate all authenticated provider operations to Codex. Repository hooks and read-only agents enforce this operationally where possible.
- Reason: Claude is connected to a company identity while Codex is connected to the owner's personal services.

## D-004: Provider writes require an explicit preflight

- Status: accepted
- Date: 2026-08-21
- Decision: migrations, deployments, DNS changes, and GitHub mutations are not run by unattended generic scripts. Codex verifies identity, target, diff, and rollback/recovery path before each external write.
- Reason: automation should reduce repetition without hiding the account or target being changed.

## D-005: Initial evaluator set stays small

- Status: accepted
- Date: 2026-08-21
- Decision: ship only `change-evaluator` and `supabase-auditor` initially. Add specialized agents only after repeated evidence shows a separate contract is useful.
- Reason: narrow agents are easier to trigger, test, and keep within least privilege.

## D-006: Generated repositories retain the guardrails

- Status: accepted
- Date: 2026-08-21
- Decision: treat this repository as a guarded golden template rather than a minimal code snippet. Initialization changes app identity, ports, URLs, and provider ownership placeholders, but retains the tested Auth, RLS, deployment, DNS, review, and secret-boundary checks.
- Reason: the generated application stays product-neutral while keeping the failure controls that make reuse safe. Local readiness and optional live provider activation are reported separately so repository size is not confused with mandatory cloud provisioning.

## D-007: Account-bound operator authority replaces actor-specific authority

- Status: accepted
- Date: 2026-08-30
- Supersedes: D-003 and actor-specific portions of D-004/D-006
- Decision: Claude acting in implementer and external-operator roles has the same account-bound authority as Codex. Authorization derives from the authenticated account, repository service mode, protected-main authority snapshot, frozen Issue purpose, exact target, execution role, and current review evidence; `operatorLabel` and `modelFamily` do not authenticate or authorize a provider operation. Evaluator and auditor roles remain read-only and opposite-model review remains independent.
- Reason: model labels are not security principals. Shared, account-bound controls prevent unrelated-account and wrong-target operations while permitting either operator surface to implement and operate under the same policy.
- Enforcement boundary: repository-approved external operations must pass strict authorization, fresh preflight, one-time claim, redacted result/finalize, and required exact-Head gates without automatic account switching. This controls accepted repository workflow evidence but cannot cryptographically stop a process sharing the same OS user from bypassing adapters; stronger isolation requires OS, container/VM, keychain, or provider-token mediation.
- Migration: preserve D-003 as history, remove actor-specific policy atomically only after the shared controls are green, and do not let the candidate authority authorize Issue #33 itself. The new authority becomes active after reviewed merge to protected `main`; generated repositories must explicitly replace or deactivate source accounts/targets and pass clean-room leakage and idempotence checks.

## D-008: Verification effort follows trusted change risk

- Status: accepted
- Date: 2026-08-30
- Decision: derive `low`, `normal`, or `high` from the protected-base execution policy and actual merge-base diff. Low is a narrow non-operational documentation allowlist with no external operation and no independent reviewer. Normal uses one different observed reviewer family. High retains approved OpenAI and Anthropic reviews, full relevant integrations, and exact-Head gates for repository-content-derived writes.
- CI: preserve all required status-context names. Each job may complete through a validated lightweight path only when trusted classification explicitly disables its expensive checks; missing, malformed, unavailable, bootstrap, and protected-main-push classification runs the full path.
- Efficiency: use focused checks or `check:fast` while editing, batch findings, target two review rounds, and run one final full check for normal/high at the exact review Head. Required CI on that unchanged Head satisfies the merge-time rerun. Changes expected above 30 files or 3,000 lines should be split or carry an atomicity rationale.
- Invariants: candidate policy and PR claims cannot lower risk. Authority/security/workflow/agent-contract/provider/auth/database/deployment/DNS/tool paths remain high risk; account binding, secrets, destructive-action controls, external-operation receipts, and required exact-Head evidence are not relaxed.

## D-009: Legal documents are required website surfaces

- Status: accepted
- Date: 2026-08-31
- Decision: all websites generated from this template retain `/terms`, `/privacy`, and shared footer links. Both exact routes bypass session refresh and render without provider configuration; no other route gains an authentication exemption.
- Content boundary: the template provides explicitly unreviewed Japanese customization outlines, not binding service terms or a compliance certification. Actual operator/contact details, data practices and dates must be confirmed for each application before public release. Unknown values are not invented from repository account identifiers.
- Verification: fast tests check required routes, shared layout links and the exact public-route boundary; browser tests cover navigation, accessibility and mobile layout. These tests do not determine legal adequacy or automatically authorize publication. Follow `docs/legal-pages.md` for the owner review checklist.
- Scope: no consent database, cookie banner, billing system, legal version-management subsystem or provider-policy change is introduced.

## D-010: Confirm the site-wide theme once before page implementation

- Status: accepted
- Date: 2026-08-31
- Decision: after target users/MVP are known, capture the application theme in `specs/design-system.md`. Bootstrap records a draft and preview plan; the next authorized UI Issue may build a bounded nonfunctional representative preview before confirmation. Record genuine desktop/mobile user confirmation before implementing the remaining pages. Existing template CSS/fonts are an unapproved baseline.
- Consistency: use shared tokens/components for all surfaces, including login, legal and error states. Reconfirm material direction changes, not every page, token addition/rename or minor adjustment. Keep theme-independent work moving within its authorized scope.
- Reason: early visual alignment prevents page-by-page drift without creating repeated approval waits. Claude and Grok consultations favored a short specification and existing workflow integration over a new theme JSON/CI system.
- Evidence boundary: confirmation records reference the specification revision, representative artifacts, date and actual user approval. Local readiness, tests and model review are not visual approval or release authorization. This accepted workflow decision does not itself accept an application's theme.
- Scope: no template redesign, new CI gate, mandatory design platform, additional theme-only Issue or change to risk/account/review policy.

## D-011: Separate routine GitHub collaboration from infrastructure evidence

- Status: accepted
- Date: 2026-08-31
- Supersedes: the blanket Issue-before-any-authenticated-read interpretation of D-007 for the bounded GitHub intake operations only; other authority and risk decisions remain in force.
- Decision: provide a protected-main-policy, same-account GitHub collaboration lane for approved proposal intake, bounded observations, exact Issue branch push and draft PR lifecycle. Preserve the existing guarded exact-Head squash merge and infrastructure evidence lane.
- Reason: ordinary push/PR iterations must not require source evidence-only commits or a permanent raw-CLI exception. Claude/Grok consultation identified the bootstrapping and repeated-write gap; lookup-before-create alone does not prevent duplicate attempts across clones.
- Safety: freeze approved input, open Issue content, protected authority and exact Head; use atomic shared local claims and create-only provider refs for one-use fencing. No automatic retry, account switch, claim cleanup, main push, non-fast-forward update or candidate self-authorization. Ready retains authoritative reviews; merge remains separate.
- Limits: proposal approval/model identity are operational attestations, not cryptographic proof. Metadata API races are detected by fresh/post-state observations, not an atomic transaction. Ambiguous claimed writes require read-only inspection and separately authorized recovery. See `docs/github-workflow.md`.
