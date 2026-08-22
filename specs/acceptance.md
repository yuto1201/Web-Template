# Template acceptance criteria

The template is complete only when all of the following are evidenced:

- A fresh clone installs and passes the documented local checks on the pinned Node/npm major versions.
- The Next.js application builds with strict TypeScript and keeps server-only values out of browser bundles.
- Supabase migrations apply in order to a clean database and pass RLS/grant tests for anonymous and authenticated roles.
- Sign-in, sign-out, refresh, and protected-route behavior work with real Supabase sessions.
- Pull requests receive CI and exact-Head cross-model review before squash merge: normal risk has one different observed family, while high risk has approved OpenAI and Anthropic family results.
- Execution surface, configured model, runtime-observed model, normalized family, fallback, risk, and review results remain distinct evidence fields; unknown or fallback identities cannot satisfy review.
- Same-platform Cursor subagents are described as separate cross-model contexts, never independent platform attestations.
- Preview deployment works without production-only secrets.
- Production deployment is linked to the verified personal Vercel scope.
- Cloudflare DNS ownership is verified before records are created, and routing works without an unintended proxy layer.
- A new repository can be instantiated from the template with stale identifiers detected by automated checks.
- Generated repositories retain `.cursor/environment.json`, `.cursor/hooks.json`, the six generated Cursor agents, `config/execution.json`, and Cursor onboarding without a source provider credential.
- Cursor Build readiness is verified independently from live activation; provider authority remains `needs-cursor-or-codex` until current-branch, model/capability, owner, and target evidence is observed.
- Claude local remains denied authenticated external-service access after Cursor activation, and revoking Cursor leaves both local modes usable.
- The final audit records GitHub, Supabase, Vercel, and Cloudflare ownership without recording credentials.

Each active Issue may add stricter acceptance criteria. Passing an individual Issue does not imply the template-level criteria are complete.
