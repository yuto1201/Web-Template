# Account-bound authority design

- Status: accepted
- Date: 2026-08-30
- Issue: #33
- Supersedes: D-003 and the actor-specific portions of D-004 and D-006

## Goal

Claude and Codex have equal policy rights as implementers and external operators on the personal Mac. Authorization is determined by the authenticated personal account, repository service policy, protected-main authority, frozen Issue purpose, exact resource target, execution role, and current review evidence—not by whether the active model is Claude or Codex.

The repository must prevent accidental use of a company or unrelated account, must not switch accounts automatically, and must preserve the current secret, exact-Head, database, deployment, DNS, and rollback controls.

## Non-goals

- Grant evaluator or auditor roles mutation, secret, or external-service access.
- Treat a model label as an authenticated principal.
- Permit arbitrary provider operations outside a frozen Issue authorization.
- Mutate Supabase, Vercel, Cloudflare, Linear, DNS, hosted databases, deployments, or billing while implementing Issue #33.
- Claim OS-level or cryptographic enforcement over arbitrary CLI, API, browser, or MCP use.
- Automatically log out, log in, change profiles, switch teams, or select another account when a mismatch occurs.

## Independent review inputs

Independent Claude and Codex consultations agreed on these blocking requirements:

1. Establish the shared authority control before removing the Claude-specific guard.
2. Never let an unmerged branch rewrite authority and then use the rewritten authority to authorize itself.
3. Preserve cross-model reviewer independence as a role boundary even when implementer permissions become equal.
4. Freeze purpose, account, target, environment, and operation constraints rather than only an operation name.
5. Validate fresh preflight and post-operation evidence; configured names alone do not prove authentication.
6. Extend exact-Head gating to every repository-content-derived high-risk write.

Codex additionally identified source-account leakage during template initialization and branch-local ownership retargeting as critical risks. Claude identified the current completion audit, acceptance trace, generated `CLAUDE.md`, and template occurrence manifest as coupled removal surfaces for the old guard. This design adopts both findings.

## Authorization model

### Independent axes

Authorization separates three axes:

- `modelFamily`: `gpt` or `claude`; used only for cross-model review independence.
- `executionRole`: `implementer`, `external-operator`, `change-evaluator`, or `security-auditor`.
- `operatorLabel`: `codex` or `claude`; audit metadata describing the active development surface, not an authentication factor.

`codex` and `claude` may both hold `implementer` and `external-operator`. Evaluator and auditor roles remain read-only regardless of model family and cannot create operation receipts, access secrets, execute external operations, or approve their own implementation.

### Authority source

`config/ownership.json` becomes the canonical account/service/target registry. Runtime authorization for an Issue must use an authority snapshot derived from protected `main`, not the candidate branch.

The frozen Issue contract records:

- protected-main authority commit SHA;
- canonical authority digest;
- fully resolved account and target references needed by the Issue;
- exact external authorizations.

An authority-changing branch cannot use its candidate `config/ownership.json` for external access. Its changes become effective only after opposite-model exact-Head review, required CI, squash merge to protected `main`, and creation of a later Issue contract from the new `main`. Issue #33 itself is delivered using the pre-change v1 authority and base-sourced GitHub gate; candidate v2 authority never authorizes its own push, PR, merge, or cleanup.

## Ownership schema v2

The canonical shape separates policy, accounts, service use, and resource targets:

```json
{
  "schemaVersion": 2,
  "authorization": {
    "operatorLabels": ["codex", "claude"],
    "externalOperatorRoles": ["implementer", "external-operator"],
    "allowAutomaticAccountSwitch": false
  },
  "accounts": {},
  "servicePolicies": {},
  "resourceTargets": {},
  "observations": {}
}
```

A single shared parser in `tools/authority-core.mjs` owns this schema. Deployment, domain, workflow, readiness, repository policy, and template tooling consume the parsed contract and must not maintain private partial ownership schemas.

### Hard-gated account identity

- GitHub: login and provider user/node ID. Repository operations additionally bind repository name and provider repository ID when available.
- Supabase: organization name and organization ID `kmjpkzaqlewqnypyqwkg`; hosted work also requires an exact non-null project ref.
- Vercel: team name `yuto`, slug `yuto16`, team ID `team_ANEUn6gVL8dccPaY08wkvxFt`, and plan `Hobby`; deployment also requires the exact project ID.
- Cloudflare: account name `Yuto Dev`, account ID `7ea8e713d76506f9e303f58624829aa5`, login-email fingerprint, membership role `Super Administrator`, and allowed zone plan `Free`; Pro or Business zone observations fail closed. DNS also requires the exact zone ID and hostname.
- Linear: workspace name `Yuto33004`, workspace slug `yuto33004`, workspace URL, user-name hint, user-email fingerprint, membership role `Admin`, and team key `YUT`. Provider-stable workspace/user IDs remain null and block all access until the user supplies an explicit purpose and a read-only identity discovery Issue records them through protected main.

Email addresses are normalized locally, compared by SHA-256 fingerprint, and never emitted in operation receipts, Issue text, PR text, or logs. Masked hints may be committed for operator recognition.

### Warning-only observations

GitHub display name, account creation date, public repository count, and observation timestamp are audit context only. A mismatch produces warnings and never grants access. Stable-identity mismatch still blocks even when all observations look familiar.

### Service usage modes

- `repository-active`: GitHub, Supabase, Vercel, and Cloudflare. Registration does not bypass Issue scope; each use still needs an exact frozen authorization. Missing project/zone targets block the related operation.
- `explicit-user-purpose-only`: Linear. Account registration alone permits neither authenticated reads nor writes. The user must state the reason, the Issue must freeze a `user-directed` authorization with that purpose, and all stable IDs must already exist in protected-main authority.

`user-directed` is invalid for repository-active services so it cannot become a general scope escape.

## External authorization and receipts

### Frozen authorization

Issue contract schema v2 replaces the coarse string-only `externalOperations` authorization with `externalAuthorizations`. Each item contains:

- service and operation;
- purpose code and human-readable purpose;
- account reference and target reference;
- environment;
- operation-specific constraints;
- whether authoritative exact-Head review is required.

Examples of frozen constraints include repository/branch/PR/Head for GitHub, project ref and migration digests for Supabase, project/environment/commit SHA for Vercel, and zone/hostname/record/proxy/routing source for Cloudflare. Linear has no registered operation or constraint schema in this Issue.

### Request, preflight, execution, result

1. A strict request declares operator label, execution role/surface, frozen authorization reference, intent, reversibility, and mutation inputs. It cannot supply free-form accounts, targets, approval claims, tokens, or evidence.
2. A provider-specific guarded adapter reads the current authenticated identity and target, then creates a fresh preflight receipt. The receipt binds authority, Issue, request, mutation, account, target, surface, timestamp, and expiry digests.
3. Execution consumes the receipt once, re-reads account and target through the same authenticated surface, rejects any switch, and performs only the frozen mutation.
4. A strict result receipt records redacted provider-derived result and post-state. The same in-process adapter checks account continuity, target continuity, expected result shape, and receipt linkage; legacy caller-authored receipt CLI commands fail closed.

No retry occurs with unchanged inputs after an ambiguous result. The operator reads provider state and resumes only the missing phase.

## Risk and review gates

The exact-Head implementation, opposite-model mapping, diff digest, verification digest, contract digest, and reviewer self-approval rejection remain unchanged.

Registered repository-content-derived high-risk writes rerun the authoritative gate: GitHub merge, hosted Supabase migrations, Vercel preview/production deployments, and one exact Cloudflare DNS upsert. GitHub ruleset changes, Supabase Auth-policy changes, Vercel configuration or rollback, and Cloudflare rollback are explicitly unsupported. A registered contract is not itself an executable provider integration: until a provider-specific production client exists, that operation also fails closed. Issue #33 adds the GitHub CLI production client for authenticated Issue reads and exact-Head squash merge; the other production clients require later Issues.

Read-only external access also requires account/service/purpose validation. Exact-Head review is required when the read exposes protected provider data or is evidence for a mutation; ordinary public unauthenticated documentation is outside this provider-account gate.

## Claude restriction migration

The final state contains no repository policy that restricts Claude merely because it is Claude:

- remove Claude-only tool, shell, network, MCP, provider, and external-service deny entries and the Claude-specific PreToolUse guard from `.claude/settings.json`;
- delete `tools/guard-claude-tool.mjs` and replace its completion/acceptance coverage with shared authority validation;
- update the generated `CLAUDE.md` entrypoint so it grants the same implementer/operator policy rights as Codex;
- remove Codex-only operational wording throughout the repository;
- retain normal application permission prompts. The exact `.env`/`.env.*` read deny remains as a secret-file protection layer, not an external-service or actor authority restriction; Codex secret access remains governed by its host/runtime boundary.

The shared authority parser, service policy, frozen authority snapshot, external authorization, preflight receipt, result validator, and tests must be green before the old guard is removed. The migration lands atomically in one PR so no protected branch state exists without either the old or new boundary.

## Template initialization

The template source may contain the owner's configured accounts, but clean-room generation must not silently inherit them. Initialization requires explicit target account/service/target inputs or writes inactive placeholders. It must:

- reject partial account/target groups;
- replace source account and target identifiers only through reviewed manifest entries;
- detect residual source account IDs and email fingerprints;
- preserve same-input `initialized` then `idempotent` behavior;
- refuse reinitialization with a different authority fingerprint.

Generated repositories may select the same personal accounts explicitly. Selection is not proof of live authentication.

## Enforcement boundary

Repository code cannot cryptographically prevent an operator with unrestricted OS credentials from bypassing adapters and calling an arbitrary CLI, browser, API, or MCP tool. The enforceable repository claim is:

- both Claude and Codex receive equal policy rights;
- all repository-approved authenticated operations must use the shared guarded adapters and receipts;
- repository workflow and CI reject evidence that did not pass these gates;
- account/target mismatch fails closed without automatic switching.

Stronger prevention requires OS-user, container, VM, keychain, or provider-token mediation and is outside Issue #33.

## Migration sequence

1. Freeze Issue #33 under the protected-main v1 authority and record the superseding decision.
2. Add failing tests for schema v2, authority snapshots, service modes, external authorization, receipts/results, exact-Head risk coverage, and template leakage.
3. Implement the canonical authority parser and migrate ownership/template contracts.
4. Implement protected-main authority snapshots and exact external authorizations.
5. Implement fresh preflight/result validation and no-switch checks.
6. Register Linear as incomplete and explicit-user-purpose-only.
7. Migrate provider tools, readiness, repository policy, completion audit, acceptance trace, generated wrappers, UI copy, and documentation.
8. Remove Claude-specific restrictions last within the same PR.
9. Run targeted tests, full `npm run check`, clean-room `npm run template:verify`, and independent Claude/Codex reviews.
10. Deliver through exact-Head PR review and required CI. Only a later Issue may use the merged v2 authority.

## Acceptance evidence

Tests must demonstrate:

- equal implementer/external-operator labels for Claude and Codex;
- read-only reviewer/auditor role enforcement and self-review rejection;
- stable account, role, plan, service mode, target, freshness, surface, and digest mismatch failure;
- warning-only mutable observation drift;
- Linear default denial, mandatory `user-directed` purpose metadata, and continued denial while no operation is registered;
- protected-main authority binding and candidate-branch retarget rejection;
- one-time preflight receipt consumption and pre/post account continuity;
- exact-Head rerun for every high-risk write;
- template placeholder behavior, source-identity leakage detection, and idempotence;
- no residual Claude-only deny or Codex-only operator policy;
- full repository and clean-room verification success.
