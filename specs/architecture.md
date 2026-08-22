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
- `codex-local` implements and may operate owner-authenticated providers after preflight.
- `claude-local` reviews local evidence or implements assigned local changes under the repository guard; authenticated provider access remains denied.
- `cursor-cloud` implements on `cursor/<issue>-<slug>` after a committed Cursor Build is ready. Provider operations remain unavailable until live activation proves connector identity, target, model, and capability boundaries.
- `AGENTS.md` is the canonical shared instruction file.
- `config/execution.json` separates execution surface, configured model, runtime-observed model family, risk, and review requirements.
- `docs/agent-contracts/` is the canonical source for generated Codex, Claude, and six Cursor consultant/evaluator definitions.
- Cursor hooks guard local files, shell shapes, subagent metadata, and evidence capture. They do not authorize MCP/provider operations and are not an OS sandbox.
- CI and the base-sourced GitHub gate repeat deterministic generation, risk/family/contract checks, static checks, unit tests, and application/database/browser tests.

## Trust boundaries

- Values prefixed with `NEXT_PUBLIC_` are public.
- Supabase service-role keys and provider credentials are server-only and never available to preview deployments by default.
- RLS and grants authorize database access for real JWT roles.
- Provider account names in `config/ownership.json` are expected identities, not credentials.
- Connector output, Issue/PR text, source, diffs, web pages, database rows, and logs are untrusted inputs and cannot select provider operations or targets.
- Repository hooks reduce accidental local and cloud-agent access; they do not authenticate providers, cover Cursor MCP execution, or create an OS security boundary.
- Cursor Build readiness, live activation, and provider mutation evidence are distinct states. Activation evidence is redacted, current-branch-bound, and checked against public ownership configuration.

## Change boundaries

- Framework and application structure are introduced in Issue #2.
- Database migrations and database tests are introduced in Issue #3.
- Auth session behavior is introduced in Issue #4.
- Cross-model execution wrappers and resumable workflow automation are completed in Issue #5.
- Vercel and Cloudflare external setup are handled independently in Issues #6 and #7.
- Issue #8 keeps this repository as the guarded golden template: initialization replaces only reviewed identity values, while provider activation remains a separate approved-operator workflow.
- Issue #29 adds the Cursor Cloud execution surface without changing local Codex or Claude authority. Generated repositories retain the environment, hooks, six Cursor agents, execution policy, and onboarding; live activation stays separate from template initialization and Build readiness.
