# Architecture specification

## Runtime topology

1. A browser reaches the application domain resolved by Cloudflare DNS.
2. DNS-only records route the application to Vercel.
3. Vercel builds and runs the Next.js application.
4. Browser-safe Supabase clients use the public project URL and publishable key.
5. Server-only code performs privileged application operations without exposing secrets to client bundles.
6. Supabase Postgres enforces authorization with RLS and explicit grants; application code is not the security boundary.

## Development topology

- GitHub Issues define bounded work and acceptance criteria.
- Claude acting in implementer and external-operator roles has the same account-bound authority as Codex.
- Operator label (`claude`/`codex`), execution role, model family, authenticated account identity, service mode, and exact target remain independent axes.
- Evaluator and auditor roles are read-only; model family selects the opposite-model reviewer and cannot grant provider authority.
- Protected-main authority and the frozen Issue purpose/target authorize guarded request → preflight → one-time claim → result/finalize workflows. Candidate branches cannot authorize themselves.
- `AGENTS.md` is the canonical shared instruction file.
- `docs/agent-contracts/` is the canonical source for generated Codex and Claude evaluator definitions.
- CI repeats deterministic generation, static checks, unit tests, and later application/database/browser tests.

## Trust boundaries

- Values prefixed with `NEXT_PUBLIC_` are public.
- Supabase service-role keys and provider credentials are server-only and never available to preview deployments by default.
- RLS and grants authorize database access for real JWT roles.
- Provider account names in `config/ownership.json` are expected identities, not credentials.
- GitHub, Supabase, Vercel, and Cloudflare are repository-active only inside an exact frozen authorization. Linear is explicit-user-purpose-only and denied until user purpose plus stable IDs exist.
- Shared adapters and CI reduce accidental account/target misuse; they do not create an OS security boundary when operators share an OS user.

## Change boundaries

- Framework and application structure are introduced in Issue #2.
- Database migrations and database tests are introduced in Issue #3.
- Auth session behavior is introduced in Issue #4.
- Cross-model execution wrappers and resumable workflow automation are completed in Issue #5.
- Vercel and Cloudflare external setup are handled independently in Issues #6 and #7.
- Issue #8 keeps this repository as the guarded golden template: initialization replaces only reviewed identity values, while provider activation remains a separate guarded workflow.
- Issue #33 establishes account-bound operator parity, protected-main authority snapshots, strict external authorizations, receipt continuity, Linear denial, and template source-identity leakage checks.
