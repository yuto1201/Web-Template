# Template acceptance criteria

The template is complete only when all of the following are evidenced:

- A fresh clone installs and passes the documented local checks on the pinned Node/npm major versions.
- The Next.js application builds with strict TypeScript and keeps server-only values out of browser bundles.
- Supabase migrations apply in order to a clean database and pass RLS/grant tests for anonymous and authenticated roles.
- Sign-in, sign-out, refresh, and protected-route behavior work with real Supabase sessions.
- Pull requests receive CI and independent cross-model review before squash merge.
- Preview deployment works without production-only secrets.
- Production deployment is linked to the verified personal Vercel scope.
- Cloudflare DNS ownership is verified before records are created, and routing works without an unintended proxy layer.
- A new repository can be instantiated from the template with stale identifiers detected by automated checks.
- The final audit records GitHub, Supabase, Vercel, and Cloudflare ownership without recording credentials.

Each active Issue may add stricter acceptance criteria. Passing an individual Issue does not imply the template-level criteria are complete.
