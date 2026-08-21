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
- The only exception is a Dependabot GitHub Actions version-only pull request that passes the pinned bot, same-repository branch, workflow-path, action allowlist, and diff-shape checks in `tools/github-review-gate.mjs`; it does not require a synthetic Issue or opposite-model body evidence.
- Branch names use `codex/<issue-number>-<slug>` for Codex-led work and `claude/<issue-number>-<slug>` for Claude-led local work.
- Read the Issue before editing. Keep changes inside its scope.
- Add or update tests with behavior changes.
- Run `npm run check` before review and again before merge.
- Obtain an independent cross-model review before marking a PR ready.
- Keep the generated PR body's opposite-model review section synchronized with the exact final Head; GitHub's `Exact Head review policy` check rejects stale or structurally invalid evidence.
- Prefer squash merge. The PR description must close its Issue and summarize verification evidence.
- Never stage unrelated user changes or rewrite unrelated history.

## Authority boundary

- Codex is the only actor allowed to authenticate to or operate GitHub, Supabase, Vercel, Cloudflare, DNS, hosted databases, deployment environments, or other personal external services.
- Claude may inspect and edit ordinary local application files when explicitly assigned implementation work. Claude must not run shell commands, invoke network or MCP tools, change repository policy/configuration, use remote Git, deploy, or access secret stores. Codex performs validation and Git operations for Claude-led changes.
- Start Claude Code from the repository root. A session started in a nested directory must stop unless it can verify that the root `.claude/settings.json` and PreToolUse hook are active.
- If Claude needs external information or action, it must return a structured delegation request for Codex. See `docs/authority.md`.
- Provider ownership must match `config/ownership.json` before a Codex external write.

This is an operational policy implemented with repository hooks and least-privilege agents. It is not OS-level or cryptographic isolation when both tools run as the same Windows user.

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
