# Cloudflare DNS-only domain boundary

Cloudflare is authoritative DNS; Vercel serves the application. Claude and Codex have equal account-bound authority as implementer or external-operator, but neither operator label proves provider authentication. The exact Cloudflare account ID, allowed `Free` zone plan, zone ID, hostname `web-template.yutodev.com`, and Vercel team/project must match the protected-main authority and frozen Issue purpose. A mismatch fails closed without switching accounts or targets.

## Safe ordering

1. Inspect the exact Cloudflare account, active zone, target hostname, CAA constraints, and an identity-only snapshot of every unrelated record. Record `caaStatus` as `absent` or `allows-vercel`; any unresolved CAA policy fails schema validation.
2. Confirm that the hostname is already attached to the canonical Vercel project and that project-domain ownership is `verified: true`; adding or removing a Vercel project domain is an unsupported configuration mutation and must not be inferred from this runbook.
3. Read the live Vercel-recommended routing record. DNS configuration may still be pending at planning time.
4. Give both provider observations their actual UTC `observedAt`, then run `node tools/domain-workflow.mjs plan --input <live-input> --output .artifacts/cloudflare-domain-plan.json`. The provider-free planner assigns `plannedAt` from its own clock and rejects observations older than five minutes or from the future. Its output is readiness evidence only and cannot authorize mutation.
5. Submit a strict `cloudflare.upsert_dns` request whose frozen constraints contain the zone ID, hostname, record type, target, `proxied: false`, and the Vercel routing source with recommendation digest. The Cloudflare guarded adapter obtains its own live preflight, claim-time, and postflight observations and executes only that exact upsert with provider idempotency.
6. Re-read the target and unrelated record identities through the adapter. The strict result must show one exact target record and no unrelated-record identity change before finalization.
7. Wait for Vercel domain verification and TLS, then run provider-free DNS and release readiness checks. They may report state, but cannot finalize an authenticated mutation from caller-authored JSON.

The desired content is accepted only from a `source: vercel-api` observation bound to the canonical Vercel team, project, and hostname. The guarded adapter obtains the value from the live provider response through the same authenticated surface; caller-authored JSON is never identity or target provenance. CNAME targets must match Vercel's documented `*.vercel-dns[-N].com` form; other targets fail closed.

## Diff and rollback

The live input stores only public DNS state: the prior target record (zero or one) and unrelated record IDs, types, names, and modification timestamps. It does not store Cloudflare tokens, cookies, or credentials. After mutation, unrelated identities must be byte-for-byte identical and exactly one target record must match the planned type, name, content, TTL, and `proxied: false` setting.

The plan retains the prior target record and unrelated-record identities so a future reviewed recovery operation can be specified exactly. It does not authorize rollback. `apply-preflight` and `rollback-preflight` are legacy mutation commands and fail closed; Cloudflare DNS rollback and Vercel project-domain removal are not registered operations. A failure or ambiguous response requires live provider-state inspection, preservation of the prior-state evidence, and a later Issue that registers the exact recovery operation. Never bulk-replace the zone or infer a rollback from current state.

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

The only registered Cloudflare mutation is `cloudflare.upsert_dns`. Domain transfer, nameserver replacement, proxy enablement, broad replacement, and every Cloudflare rollback remain unsupported.
