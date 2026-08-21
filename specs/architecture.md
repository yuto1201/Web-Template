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
- Codex implements and owns authenticated external operations.
- Claude reviews local evidence or implements local changes under the repository guard.
- `AGENTS.md` is the canonical shared instruction file.
- `docs/agent-contracts/` is the canonical source for generated Codex and Claude evaluator definitions.
- CI repeats deterministic generation, static checks, unit tests, and later application/database/browser tests.

## Trust boundaries

- Values prefixed with `NEXT_PUBLIC_` are public.
- Supabase service-role keys and provider credentials are server-only and never available to preview deployments by default.
- RLS and grants authorize database access for real JWT roles.
- Provider account names in `config/ownership.json` are expected identities, not credentials.
- Repository hooks reduce accidental Claude access to external tools and secrets; they do not create an OS security boundary.

## Change boundaries

- Framework and application structure are introduced in Issue #2.
- Database migrations and database tests are introduced in Issue #3.
- Auth session behavior is introduced in Issue #4.
- Cross-model execution wrappers and resumable workflow automation are completed in Issue #5.
- Vercel and Cloudflare external setup are handled independently in Issues #6 and #7.
