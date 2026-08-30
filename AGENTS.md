# Repository instructions

## Mission

Build and maintain a reusable, issue-driven web application template. The default stack is Next.js App Router, strict TypeScript, Supabase, Vercel, and Cloudflare DNS.

## Sources of truth

Use sources in this order when they differ:

1. The user's current instruction.
2. The active GitHub Issue and its acceptance criteria.
3. `specs/` and accepted decisions in `specs/decisions.md`.
4. `docs/` operational guidance.
5. Existing implementation and tests.

Do not silently resolve a material conflict. Record the decision or ask the user when it changes scope, external state, cost, or security.

## Workflow

- Work on one GitHub Issue per branch and pull request.
- The only exception is a Dependabot GitHub Actions version-only pull request that passes the pinned bot, same-repository branch, workflow-path, action allowlist, and diff-shape checks in `tools/github-review-gate.mjs`; it does not require a synthetic Issue or cross-model body evidence.
- Branch names use `codex/<issue-number>-<slug>` for Codex-local work, `claude/<issue-number>-<slug>` for Claude-local work, and `cursor/<issue-number>-<slug>` for an activated Cursor Cloud run.
- Branch prefixes and operator labels describe the execution surface; they do not grant authority or prove an authenticated account.
- Read the Issue before editing. Keep changes inside its scope.
- Add or update tests with behavior changes.
- Run `npm run check` before review and again before merge.
- Obtain the required cross-model review before marking a PR ready. Normal risk needs one different observed family; high risk needs approved OpenAI and Anthropic family results.
- Keep the generated PR body's cross-model review section synchronized with the exact final Head; GitHub's `Exact Head review policy` check rejects stale, fallback, unknown-family, risk-reduced, or structurally invalid evidence.
- Prefer squash merge. The PR description must close its Issue and summarize verification evidence.
- Never stage unrelated user changes or rewrite unrelated history.

## Authority boundary

- Claude acting in implementer and external-operator roles has the same account-bound authority as Codex. `operatorLabel` (`claude` or `codex`) is audit metadata, not an authentication factor.
- Keep `operatorLabel`, `executionRole`, model identity, authenticated account identity, service mode, and exact resource target separate. Evaluator and auditor roles remain read-only. Normal-risk work needs an independent opposite-family review; high-risk work needs both OpenAI and Anthropic reviews.
- `config/ownership.json` is the canonical account, service-policy, and target registry. Runtime authorization comes from a protected-`main` authority snapshot frozen into the Issue contract; a candidate branch cannot authorize itself by retargeting that file.
- GitHub, Supabase, Vercel, and Cloudflare are `repository-active`, but every authenticated use still needs the Issue's declared purpose and exact frozen authorization. Linear is `explicit-user-purpose-only`, and every Linear read and write currently fails closed because no Linear operation is registered. A user-stated purpose and protected stable IDs are necessary but never sufficient until a later Issue registers one exact operation.
- Repository-approved authenticated operations use the guarded request → preflight receipt → one-time execution claim → result/finalize path. Re-read account and target before execution, never switch accounts automatically, and do not retry an ambiguous result without first observing provider state.
- Registered high-risk writes derived from repository content—GitHub merge, hosted migrations, preview/production deployment, and one DNS upsert—must rerun the authoritative exact-Head gate. GitHub ruleset, Supabase Auth-policy, Vercel configuration/rollback, Cloudflare rollback, and every operation without a production provider client are unsupported and fail closed. Destructive actions require exact scope, reversibility or recovery evidence, and explicit authorization.
- Cursor is an execution surface, not a model family or account identity. `cursor-cloud` uses the same protected personal account registry and additionally requires fresh run-bound activation matching its `cursor/<issue>` branch, exact Head, and provider targets; Cursor evaluator subagents remain read-only.

This is an operational repository policy, not OS-level or cryptographic isolation. Claude and Codex running as the same OS user may be able to bypass repository adapters; stronger prevention requires separate OS credentials, a container/VM, keychain mediation, or provider-token mediation. See `docs/authority.md`.

## Engineering rules

- Treat browser-exposed variables as public. Never place service-role keys or provider tokens in `NEXT_PUBLIC_*` values.
- Keep server-only modules separate from client components.
- Database changes are forward-only Supabase migrations with explicit RLS and grants.
- Preview environments never receive production secrets by default.
- Cloudflare is the registrar and DNS authority; Vercel serves the application. Start with DNS-only Vercel records unless a documented decision changes this.
- Do not print secrets in logs, PRs, Issues, screenshots, or review packets.
- Prefer Windows-compatible Node scripts over POSIX-only scripts or symlinks.

## Reviewer behavior

Reviewers are read-only. Lead with concrete findings ordered by severity. Cite files and explain the user-visible or security impact. If no material issue exists, say so and list remaining verification gaps.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
