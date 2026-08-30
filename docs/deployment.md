# Vercel deployment boundary

Vercel serves the Next.js application; Cloudflare remains the registrar and authoritative DNS provider. DNS routing is a separate Issue and must not be inferred from a successful deployment.

## Authority and linkage

Claude and Codex have equal account-bound authority in implementer and external-operator roles. Before any Vercel mutation, the active operator verifies the provider-reported personal team name, slug, stable team ID, required plan, and exact non-null project ID against the protected-main authority frozen in the Issue contract. The operator label is audit metadata and never substitutes for those fields. The ignored `.vercel/project.json` link is compared with the same canonical target; `--root` overrides are rejected. A mismatch fails at checkpoint `link` or `ownership` without switching accounts, teams, or projects. `.vercel/`, tokens, cookies, and environment values are never committed.

Vercel is `repository-active`, so use also requires the Issue's declared purpose, environment, operation constraints, and fresh guarded receipts. The Git integration model is one production branch (`main`) plus Preview deployments for non-production branches and pull requests. Manual Connector/CLI deployments are permitted only as reviewed bootstrap or recovery operations and must produce the same SHA-bound release evidence.

## Names-only environment policy

`config/deployment.json` is the canonical key-name policy. Collect only key names from Development, Preview, and Production; never serialize values into a snapshot, terminal output, Issue, PR, or review packet.

All three environments require:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `APP_ORIGIN`
- `AUTH_SIGNUP_MODE`

Preview has an exact allowlist containing only these browser-visible/staging or public-policy keys. `SUPABASE_SERVICE_ROLE_KEY` is a production-secret class and is rejected from Preview. It remains optional in Production until a reviewed server feature requires it. A missing key fails the exact `environment:<name>` checkpoint; forbidden/unknown Preview keys also fail closed.

Example redacted snapshot:

```json
{
  "schemaVersion": 1,
  "source": "vercel-key-names-only",
  "environments": {
    "development": ["APP_ORIGIN", "AUTH_SIGNUP_MODE", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_URL"],
    "preview": ["APP_ORIGIN", "AUTH_SIGNUP_MODE", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_URL"],
    "production": ["APP_ORIGIN", "AUTH_SIGNUP_MODE", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_URL"]
  }
}
```

```powershell
node tools/deployment-workflow.mjs preflight --env-snapshot <names-only.json>
```

## Release evidence and smoke checks

Production deployment is allowed only for an already verified 40-character commit SHA, after rerunning the authoritative exact-Head gate. After the Vercel API reports `READY`, the authorized operator records a names-only/provider-derived evidence object containing the canonical team ID, project ID, deployment ID, credential-free HTTPS Vercel origin, provider-reported commit SHA, timestamp, and smoke results, then runs:

```powershell
node tools/deployment-workflow.mjs verify-release --evidence .artifacts/vercel-release-evidence.json --expected-sha <verified-sha>
```

Evidence older than 30 minutes or dated more than five minutes into the future is rejected. The fixed checks are:

- `/` returns 200 and contains the non-secret marker `Start with the boundaries already drawn.`;
- `/health` returns 200 with JSON `status: ok`.

Preview protection stays enabled. The same authenticated surface used for the preflight performs the protected fetch rather than disabling protection. Production is checked through its public deployment URL. Runtime/build errors are inspected without printing environment values.

Release evidence is never accepted from a pull request, downloaded artifact, or user-supplied path. The guarded adapter creates `.artifacts/vercel-release-evidence.json` directly from the Vercel API response and the two live smoke responses, consumes it in the same operator run, and leaves it git-ignored. The CLI rejects every other evidence path. Its result is linked to the preflight receipt, one-time mutation claim, and finalized result receipt.

## Remote schema ordering

Remote schema changes follow `expand -> deploy -> contract`:

1. Expand with backward-compatible additions.
2. Deploy code that works with old and expanded schemas.
3. Contract only after observation and a separate explicit approval.

Production `database.reset`, down migrations, and schema drops are forbidden automation targets. A destructive contract step cannot inherit approval from an application deployment.

## Workflow safety

`npm run deployment:lint` rejects `pull_request_target`, Vercel tokens passed as command arguments, and secret-like environment output. CI uses read-only contents permission and the ordinary `pull_request` event. `npm run build:ci` refuses missing Vercel environment keys and scans static HTML/RSC/client artifacts for server-only values.

## Failure and recovery

- `link` / `ownership`: stop; relink only through a new authorization after the operator re-verifies team and project.
- `environment:*`: add only the missing allowed key to that environment; never copy Production wholesale into Preview.
- `release-sha`: do not promote; deploy the reviewed commit.
- `smoke`: keep the previous production deployment available and inspect build/runtime logs before retrying.
- DNS remains unchanged until the separate Cloudflare Issue succeeds.
