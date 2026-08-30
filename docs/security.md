# Security baseline

## Secrets

- Commit `.env.example` with names and safe placeholders only.
- Never commit `.env`, `.env.local`, provider tokens, private keys, service-role keys, or production credentials.
- Never echo complete environment values into logs or review packets.
- Treat `NEXT_PUBLIC_*` as public and inspect browser bundles for accidental server-secret exposure.
- Preview deployments do not receive production secrets by default.

## Shared operator guard

Claude and Codex have equal account-bound authority when acting as implementer or external-operator. The operator label does not authenticate a provider account, and normal application permission prompts do not replace repository authorization. Every repository-approved authenticated use must match the protected-main authority snapshot, Issue purpose, service mode, exact target, execution role, and guarded receipt flow described in [the authority runbook](authority.md).

- GitHub, Supabase, Vercel, and Cloudflare are `repository-active` only within frozen Issue scope.
- Linear is `explicit-user-purpose-only`; a missing explicit user purpose or null stable workspace/user/team ID denies both reads and writes.
- Evaluator and auditor roles are read-only and cannot access secrets, execute operations, create receipts, or self-approve. Cross-model independence remains mandatory.
- Account or target mismatch fails closed without automatic account, profile, team, or project switching.
- High-risk writes rerun exact-Head review, and destructive actions require exact target and recovery evidence.

Repository checks detect actor-specific deny/delegation text and require the generated operator entrypoints to remain in parity. This is workflow enforcement, not an OS sandbox: processes sharing an OS user may reach the same filesystem, keychain, browser, CLI, API, or MCP credentials.

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
- Do not run unreviewed `npx` or ad-hoc downloaded executables from either operator surface.

## Build artifact scope

The CI scanner checks public static assets plus prerendered HTML and RSC payloads. It also compares secret-shaped server environment values without printing their values. Dynamic SSR responses must be checked by feature-specific browser tests when introduced; a successful build scan does not prove that arbitrary future runtime code cannot serialize a secret.

## Reporting

If a secret may have been exposed, stop using it, avoid reproducing it in output, and rotate it only through a verified account-bound operator authorization. Document only the secret name, scope, and rotation time.
