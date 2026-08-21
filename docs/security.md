# Security baseline

## Secrets

- Commit `.env.example` with names and safe placeholders only.
- Never commit `.env`, `.env.local`, provider tokens, private keys, service-role keys, or production credentials.
- Never echo complete environment values into logs or review packets.
- Treat `NEXT_PUBLIC_*` as public and inspect browser bundles for accidental server-secret exposure.
- Preview deployments do not receive production secrets by default.

## Claude guard

Claude Code loads `.claude/settings.json`, which runs `tools/guard-claude-tool.mjs` before every tool call.

The guard is default-deny:

- Local reads, searches, and edits inside the repository are allowed, except secret and protected policy paths.
- Shell execution and Claude network tools are denied. Codex runs installation, tests, builds, Git commands, and provider operations.
- MCP tools and credential paths are denied.
- Only the two generated read-only evaluator agents may be spawned.

Run `npm test -- guard-claude-tool` after changing the guard. Codex owns changes to policy, specifications, tooling, project configuration, generated assets, and shared agent instruction files. Claude-led application work is limited to ordinary product source and test files; Codex performs its validation and Git operations.

## Database

- Enable RLS explicitly on exposed tables.
- Pair RLS policies with explicit grants and test both.
- Test anonymous, authenticated-owner, authenticated-non-owner, and service-only cases where relevant.
- Do not rely on UI filtering or application middleware for row authorization.
- Use forward-only recovery migrations; never edit a migration already applied remotely.

## Dependencies and supply chain

- Use the committed lockfile and `npm ci` in CI.
- Pin the Node and npm major versions.
- Review dependency changes separately from feature behavior.
- Do not run `npx` or ad-hoc downloaded executables from Claude sessions.

## Build artifact scope

The CI scanner checks public static assets plus prerendered HTML and RSC payloads. It also compares secret-shaped server environment values without printing their values. Dynamic SSR responses must be checked by feature-specific browser tests when introduced; a successful build scan does not prove that arbitrary future runtime code cannot serialize a secret.

## Reporting

If a secret may have been exposed, stop using it, avoid reproducing it in output, rotate it through Codex on the verified personal account, and document only the secret name, scope, and rotation time.
