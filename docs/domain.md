# Cloudflare DNS-only domain boundary

Cloudflare is authoritative DNS; Vercel serves the application. Codex is the only operator for both providers. The canonical target is `web-template.yutodev.com`, owned by the personal Cloudflare account `Yuto Dev` and the personal Vercel project recorded in `config/ownership.json`.

## Safe ordering

1. Inspect the exact Cloudflare account, active zone, target hostname, CAA constraints, and an identity-only snapshot of every unrelated record. Record `caaStatus` as `absent` or `allows-vercel`; any unresolved CAA policy fails schema validation.
2. Add the hostname to the canonical Vercel project first.
3. Confirm Vercel project-domain ownership (`verified: true`) separately from DNS configuration (`misconfigured` / configured), then read the live recommended routing record. DNS configuration may still be pending at planning time.
4. Give both provider observations their actual UTC `observedAt`, then run `node tools/domain-workflow.mjs plan --input <live-input> --output .artifacts/cloudflare-domain-plan.json`. The planner assigns `plannedAt` from its own clock and rejects provider observations older than five minutes or from the future.
5. Re-read Cloudflare after `plannedAt` and immediately before apply. `apply-preflight` rejects a changed snapshot, an observation that is not post-plan, a current read older than two minutes, a plan older than ten minutes, or an update without the exact record ID. Execute only its returned `request.method`, `request.path`, and `request.body`; `null` means no mutation. The one permitted record stays `proxied: false` with automatic TTL.
6. Re-read the target and unrelated record identities, then run `verify-dns`. This creates a plan-bound SHA-256 proof and retains the live record ID needed for rollback.
7. Wait for Vercel domain verification and TLS, then verify `/` and `/health` over the custom hostname. Run `verify-release` within ten minutes with `--evidence`, `--plan`, and `--dns`; stale, expired/wrong-host TLS, or evidence from another DNS plan is rejected.

The desired content is accepted only from a `source: vercel-api` observation bound to the canonical Vercel team, project, and hostname. Because the CLI cannot cryptographically attest a hand-built JSON file, Codex must copy the value from the live provider response and preserve the observation evidence. CNAME targets must match Vercel's documented `*.vercel-dns[-N].com` form; other targets fail closed.

## Diff and rollback

The live input stores only public DNS state: the prior target record (zero or one) and unrelated record IDs, types, names, and modification timestamps. It does not store Cloudflare tokens, cookies, or credentials. After mutation, unrelated identities must be byte-for-byte identical and exactly one target record must match the planned type, name, content, TTL, and `proxied: false` setting.

Rollback is deliberately narrow:

- if the plan action was `create`, `rollback-preflight` permits deletion of only the created target record by its newly verified ID;
- if the plan action was `update`, `rollback-preflight` permits restoration of only the exact prior record ID and body captured in `rollback.priorTargetRecords`;
- never bulk-replace the zone or infer a rollback from current state.

Before executing either rollback, re-read Cloudflare and run `rollback-preflight --current <current> --plan <plan>` within two minutes of that read. Execute only its returned request. Restore or delete DNS first. Removing the hostname from the Vercel project is a separate Codex-only recovery action after DNS state is confirmed and only when the project-domain association was created by this change.

## Explicit approval boundary

Domain transfer, nameserver replacement, broad DNS replacement, and Cloudflare proxy enablement are outside the Issue and require a new explicit user approval. Workers, Pages, WAF, cache, and orange-cloud proxying are not introduced by this template.

## Fail-closed recovery

- No verified Vercel routing response: stop before Cloudflare mutation.
- Existing multiple target records: stop and resolve ambiguity manually.
- Existing target record without its Cloudflare ID, or an existing proxied target: stop and request a separate review.
- Any unrelated record identity changes during the operation: stop and investigate; do not overwrite it.
- A restrictive CAA record that prevents Vercel certificate issuance: stop before DNS mutation and resolve it as a separately reviewed DNS change.
- TLS or smoke failure: preserve the prior-record rollback evidence and do not report the domain complete.
- Provider login required: pause at authentication rather than changing accounts or bypassing the login boundary.
