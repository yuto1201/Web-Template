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
