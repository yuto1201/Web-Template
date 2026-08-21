# Database workflow

## Migration-first rule

Create every migration through the repository-pinned CLI, then edit the generated SQL file:

```powershell
npm exec -- supabase migration new describe_the_change
```

Never edit a migration already applied to a hosted project. Add a forward-only recovery migration instead. Hosted link, push, reset, and SQL execution are Codex-only external operations after the personal project identity is verified.

## Exposed schema checklist

For every table, view, or function exposed through the Data API:

1. revoke inherited/default access and grant only required operations;
2. enable RLS on tables and write role-specific policies;
3. test allowed and denied identities with pgTAP;
4. use `security_invoker = true` for exposed views;
5. revoke function execute from `public`, `anon`, and `authenticated`, then grant only the intended callers;
6. generate and commit types after a successful empty reset.

The baseline pgTAP suite also walks every table, view, and security-definer function in `public`; materialized views and foreign tables are rejected from that exposed schema. This is an invariant: extend the checks deliberately if a product exposes another schema through the Data API. New `public` objects created by the migration role (`postgres`) start with no API-role privileges and must opt in explicitly. Product migrations must remain owned by that role unless the default-privilege tests are extended for an intentional alternative owner.

`force row level security` protects the table owner from accidentally bypassing policies, but it does not constrain Supabase's `service_role`, which has `BYPASSRLS`. Service-role credentials therefore remain server-only and are never used by the request-scoped client factories.

Local API defaults are `public` and `graphql_public`, a 1,000-row response limit, PostgreSQL 17, one-hour JWTs, and email sign-up enabled without local email confirmation. Product auth policy is configured separately from this database baseline.

Private schemas, idempotency keys, revision columns, RPC functions, and audit tables are optional product patterns. They are not installed by this neutral baseline.

## Verification

`npm run db:verify` starts only the local Postgres service required by the checks. It resets from migrations, runs `db lint`, executes policy tests, compares local generated types with `src/types/database.generated.ts`, and stops the isolated stack. The script redacts local credentials from failure output. A missing Docker daemon exits with a distinct `NOT RUN` message and is never treated as a pass.
