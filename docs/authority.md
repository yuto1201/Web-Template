# Account-bound authority and external operations

## Independent identity and role axes

Claude acting in implementer and external-operator roles has the same account-bound authority as Codex. Authorization never comes from a model or tool name. Keep these values distinct in requests, evidence, and reviews:

| Axis | Meaning | Authority effect |
| --- | --- | --- |
| `operatorLabel` | `claude` or `codex`, identifying the active development surface | Audit metadata; grants no authority |
| `executionRole` | `implementer`, `external-operator`, `change-evaluator`, or `security-auditor` | Only the first two may request external operations |
| `modelFamily` | `gpt` or `claude` | Selects cross-model review independence; grants no operator authority |
| Account identity | Provider-derived stable account fields | Must match protected-main authority |
| Service mode | Repository policy for the provider | Determines whether the requested purpose is eligible |
| Exact target | Repository, project, zone/hostname, or workspace/team/object | Must match the frozen Issue authorization and live observation |

Evaluator and auditor roles are read-only regardless of operator label or model family. They cannot access secrets, execute provider operations, create receipts, mutate repository state, or approve their own implementation.

## Canonical authority and service modes

`config/ownership.json` schema v2 is the canonical account, service-policy, resource-target, and warning-only observation registry. Names and IDs are public identifiers, not proof of current authentication. Runtime authorization uses the version loaded from the protected `main` commit recorded in the frozen Issue contract. A candidate branch that changes ownership cannot use its candidate bytes to authorize its own push, PR, merge, deployment, or cleanup; those changes become usable only by a later Issue after reviewed merge to protected `main`.

- GitHub, Supabase, Vercel, and Cloudflare are `repository-active`. This means they are eligible for repository work, not generally authorized. Every authenticated read or write still needs an Issue-scoped declared purpose, a frozen account reference, an exact target, environment and operation constraints, and any required exact-Head review.
- Linear is `explicit-user-purpose-only`. Account registration alone denies all authenticated reads and writes. The user must explicitly state the purpose, the Issue must freeze that purpose as `user-directed`, and protected-main authority must already contain non-null stable workspace, user, and team IDs. No Linear operation is registered, so all Linear access remains denied even after those IDs are populated. A later Issue must register an exact operation before Linear can be used.
- `user-directed` is invalid for repository-active services and cannot bypass normal Issue scope.

Email identity is normalized and compared locally by SHA-256 fingerprint. Commit only the configured masked hint and fingerprint where required; never emit a raw address in requests, receipts, Issues, PRs, logs, screenshots, or review packets. Mutable observations such as display name or public repository count can warn, but cannot override a stable-identity mismatch or grant access.

## Frozen Issue authorization

The Issue contract schema v2 records the protected-main authority commit and digest plus strict `externalAuthorizations`. Each authorization binds service, operation, purpose code and text, account and target references, environment, operation-specific constraints, and whether authoritative exact-Head review is required. Examples include repository/branch/PR/Head for GitHub, project ref and migration digests for Supabase, project/environment/commit for Vercel, zone/hostname/record/routing source for Cloudflare, and workspace/team/object/filter/result limit for Linear.

An operator request declares only its operator label, eligible execution role and surface, authorization reference, intent, reversibility, recovery strategy, and exact operation inputs. It cannot inject a free-form account or target, token, approval claim, or evidence. For a merge request, generate every required field from the gated Issue evidence and then validate it:

```bash
npm run workflow -- request-merge --issue 33 --pr-number 123 --operator-label codex --execution-role external-operator --surface codex-cli
npm run workflow -- validate-request --file .artifacts/ops-requests/issue-33-github-merge-pr-1.json
```

The request generator supplies `intent`, `reversibility`, `recovery`, repository, PR number, reviewed Head, and squash method. Replace the example Issue, PR, operator label, and surface with the active run; do not hand-author provider observations.

## Request, receipt, claim, and result

Repository-approved authenticated operations use this sequence:

1. The guarded provider adapter reads the current account and exact target through the same authenticated surface and creates a fresh preflight receipt bound to the authority, Issue, request, mutation, surface, timestamps, expiry, account, and target digests.
2. The adapter validates the preflight receipt, including service purpose, stable identity, target, freshness, and exact-Head gate where required.
3. Immediately before mutation, the adapter re-reads account and target, rejects any switch, and atomically consumes the mutation once. Automatic logout, login, profile, team, project, or account switching is forbidden.
4. The adapter performs only the frozen operation, obtains provider post-state through that same surface, and finalizes a strict redacted result linked to the original receipt.

The legacy `validate-preflight`, `claim-execution`, and `validate-result` CLI commands cannot authorize execution; they fail closed. Tests inject a fake provider client into the adapter, but production callers cannot substitute caller-authored account, target, receipt, or result JSON for provider collection.

Do not retry an ambiguous result with unchanged inputs. Read provider state and resume only the missing phase. A failed or ambiguous finalized mutation records `retryPolicy: forbidden`; a new reviewed authorization is required for another mutation.

## Supported and unsupported operations

The executable registry supports `github.read_issue`, `github.push_branch`, `github.create_pr`, `github.merge_pr`, `github.delete_branch`, `supabase.inspect_project`, `supabase.apply_migrations`, `vercel.inspect_project`, `vercel.deploy_preview`, `vercel.deploy_production`, `cloudflare.inspect_zone`, and `cloudflare.upsert_dns`.

The following high-risk operations are explicitly unsupported and fail closed until a later Issue registers their complete request, result, recovery, and idempotency contracts: GitHub ruleset updates, Supabase Auth-policy updates, Vercel configuration changes, Vercel deployment rollback, and Cloudflare DNS rollback. Compatibility with an older command is not authorization.

## Common safeguards

- Never expose tokens, cookies, private keys, service-role keys, raw email addresses, complete authentication responses, or secret values.
- Read-only authenticated access still needs account, service, purpose, and exact-target validation. If it exposes protected provider data or supplies evidence for a mutation, it also needs authoritative exact-Head review.
- Every supported repository-content-derived high-risk write reruns the current authoritative gate: GitHub merge, hosted Supabase migrations, Vercel deployment, and Cloudflare DNS upsert.
- A destructive action needs explicit Issue authorization, exact resources, a reviewed diff, recovery/rollback evidence, and a fresh preflight. Never broaden a target or infer bulk cleanup.
- Repository policy, secrets, exact-Head review, protected-main authority, receipt claim/finalize, database expand/deploy/contract, Preview-before-Production, DNS-only default, and template clean-room leakage checks remain in force for both operator labels.
- Write claims are stored under the Git common directory, so sibling worktrees cannot execute the same mutation. Every supported write also requires a provider-enforced idempotency mechanism; an operation without one is denied. Separate clones do not share local claim state, so cross-clone safety depends on that provider idempotency key. Authorized reads remain repeatable within their explicit freshness window.

## Enforcement boundary

These controls govern repository-approved workflows and the evidence accepted by CI. They do not provide OS-level or cryptographic isolation. Claude and Codex running under the same OS user may be able to bypass adapters and invoke an arbitrary CLI, browser, API, MCP tool, filesystem credential, or keychain entry. Stronger prevention requires a separate OS user, container/VM, keychain mediation, or provider-token mediation. An ordinary application permission prompt is not evidence that account-bound authorization passed.
