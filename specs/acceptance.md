# Template acceptance criteria

The template is complete only when all of the following are evidenced:

- A fresh clone installs and passes the documented local checks on the pinned Node/npm major versions.
- The Next.js application builds with strict TypeScript and keeps server-only values out of browser bundles.
- Generated repositories retain [design-system.md](design-system.md), an initially unconfirmed app-theme record and a representative desktop/mobile confirmation step before individual product-page UI implementation. A bounded nonfunctional preview is allowed before confirmation; bootstrap and independent backend work are not blocked by theme-pending status.
- Shared tokens/components keep all pages, including login, legal and error states, consistent with the user-confirmed direction. Major direction changes require reconfirmation; minor adjustments do not. Trace/link/clean-room checks and model review do not substitute for genuine visual approval or public-release readiness.
- Terms of Use (`/terms`) and Privacy Policy (`/privacy`) are public, provider-independent pages linked from the shared application footer. Route presence, anonymous access, keyboard navigation and mobile/desktop readability have regression coverage.
- Template legal outlines are visibly unreviewed. Generated websites must replace them with app-specific, owner-reviewed content before public release; bootstrap or automated-test success is not legal approval.
- Supabase migrations apply in order to a clean database and pass RLS/grant tests for anonymous and authenticated roles.
- Sign-in, sign-out, refresh, and protected-route behavior work with real Supabase sessions.
- Pull requests receive CI and exact-Head cross-model review before squash merge: normal risk needs one different observed family, while high risk needs approved OpenAI and Anthropic family results.
- Claude and Codex have equal account-bound authority in implementer/external-operator roles, while evaluator/auditor roles remain read-only and cannot self-approve.
- Operator label, execution role, model family, account identity, service mode, and exact target are recorded and validated as independent values.
- Provider authorization is derived from protected `main`, frozen to an Issue purpose and exact target, and cannot be changed by candidate-branch retargeting.
- GitHub, Supabase, Vercel, and Cloudflare remain repository-active only within Issue scope; Linear denies every read and write because no operation is registered, even if an explicit user purpose and stable IDs are later supplied.
- Preflight receipts, one-time execution claims, redacted results, and finalization prove pre/post account and target continuity without automatic switching or ambiguous retries.
- Every repository-content-derived high-risk write reruns the authoritative exact-Head gate; destructive actions also prove exact scope and recovery.
- Cursor Cloud retains its generated environment, hooks, read-only evaluators, surface/model/risk separation, and run-bound provider activation; it uses the same protected personal accounts rather than weakening Claude/Codex parity.
- Preview deployment works without production-only secrets.
- Production deployment is linked to the verified personal Vercel scope.
- Cloudflare DNS ownership is verified before records are created, and routing works without an unintended proxy layer.
- A new repository can be instantiated from the template with stale identifiers detected by automated checks.
- Clean-room initialization replaces or deactivates source account/target identity, detects source IDs and email fingerprints, and remains same-input idempotent.
- The final audit records GitHub, Supabase, Vercel, and Cloudflare ownership without recording credentials.
- Logs, Issues, PRs, receipts, and screenshots contain no raw personal email address, token, cookie, or secret value.

Each active Issue may add stricter acceptance criteria. Passing an individual Issue does not imply the template-level criteria are complete.
