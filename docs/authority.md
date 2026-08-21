# Authority and account boundary

## Fixed ownership rule

Codex is the only actor allowed to authenticate to or mutate personal external services. Claude is a consultant, evaluator, or local implementation partner only.

| Surface | Expected personal target | Operator |
| --- | --- | --- |
| GitHub repository | `yuto1201/Web-Template` or the instantiated repository owner | Codex |
| Supabase organization | `yuto1201's Org` | Codex |
| Vercel scope/project | Filled and verified during setup | Codex |
| Cloudflare account | `Yuto Dev` | Codex |
| Local repository files | Current workspace | Codex; Claude only when explicitly assigned |

Machine-readable expected values live in `config/ownership.json`. They are public identifiers, not proof of authentication.

## External operation definition

External operations include reads as well as writes when they require an authenticated personal account:

- GitHub Issues, pull requests, branches, repository settings, or remote Git transport
- Supabase organizations, projects, hosted SQL, Auth, logs, Edge Functions, or secrets
- Vercel projects, deployments, environment variables, domains, logs, or integrations
- Cloudflare accounts, zones, DNS records, registrar settings, Workers, Pages, or tokens
- Any provider CLI, authenticated API, MCP connector, credential store, or secret manager

Claude must not use these surfaces even for a read-only check. Codex performs the check and returns redacted evidence.

## Codex preflight

Before any external write, Codex must record or report:

1. Current authenticated identity or scope, using the actual connector/CLI involved.
2. Exact target organization, project, repository, zone, branch, or environment.
3. Intended change and whether it is reversible.
4. Relevant local verification and diff.
5. Resulting remote state after the operation.

Do not treat tool availability as proof that authentication is valid. Never print access tokens, service-role keys, cookies, or complete secret values.

## Claude delegation request

When Claude needs an external action, it writes one versioned request beneath `.artifacts/ops-requests/` and continues with any remaining local work. This example is accepted by the strict runtime validator:

```json
{
  "schemaVersion": 1,
  "requestId": "issue-5-supabase-apply-migrations-1",
  "issue": 5,
  "operation": "supabase.apply_migrations",
  "target": {
    "kind": "supabase.project",
    "identifier": "config/ownership.json#supabase.projectRef"
  },
  "environment": "production",
  "reasonCode": "acceptance-evidence",
  "inputs": {
    "projectRefSource": "config/ownership.json",
    "migrations": ["supabase/migrations/20260821010000_example.sql"]
  }
}
```

The request is not authorization. Codex validates it with `npm run workflow -- validate-request`, resolves the fixed identifier from `config/ownership.json`, performs the preflight, and follows the frozen Issue scope. Unknown operations, free-form targets or instructions, invalid operation/environment/reason combinations, mismatched request IDs, caller-supplied evidence or approval claims, additional inputs, and paths outside the request directory fail closed. Required post-operation evidence is derived from the operation allowlist.

## Enforcement limits

`.claude/settings.json` and `tools/guard-claude-tool.mjs` deny shell execution, PowerShell and background execution, Claude network tools, MCP calls, sensitive paths, and changes to policy/configuration or `.git`. Generated evaluator agents are read-only. A Claude implementation session may edit assigned application source, but its only writable workflow artifact surface is a one-level `.json` file in `.artifacts/ops-requests/`; Issue evidence, reviews, state, and operation results are Codex-owned. `reviewerModel` is structured evidence, not an authenticated identity by itself, so the write boundary and opposite-model invocation record remain part of the control.

If the hook cannot start or is syntactically broken, Claude Code may fall back to its ordinary permission handling; the committed deny rules remain a second layer but are not a complete sandbox. Search tools normally respect ignored files, and explicit secret paths are rejected, but these controls are not a substitute for keeping credentials outside the working account. A process running under the same Windows user can potentially access the same filesystem and credentials. Strong isolation requires a separate OS account, VM, or container with no personal credentials.

Claude Code must be launched from the repository root. Live validation showed that a nested-directory launch did not reliably apply the root project hook, while a root launch denied the non-allowlisted `Task/general-purpose` call. If the project hook is not visible in `/hooks` or hook debug output, stop the Claude session and restart it from the root; do not continue on ordinary permission prompts.
