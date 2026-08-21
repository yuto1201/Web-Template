# Authentication policy

## Trusted identity path

The browser and request-scoped server clients use only the Supabase publishable key. Next.js `proxy.ts` creates a fresh client for each request, calls `auth.getClaims()` immediately, and copies rotated cookies plus no-cache headers to the response. Protected Server Components call `getClaims()` again before loading data; neither `getSession()` nor `user_metadata` authorizes access.

Supabase SSR session cookies intentionally remain readable to the browser client so it can rotate refresh tokens; `HttpOnly` is not enabled. This follows the provider's SSR model and makes XSS prevention, CSP review, dependency hygiene, and browser bundle secret scanning part of the session boundary.

Authenticated routes are dynamic and must never use ISR. The session-bearing Supabase client is never stored at module scope, which keeps Vercel Fluid compute from sharing one user's state with another request.

## Redirect boundary

`APP_ORIGIN` is the one approved application origin. It must be HTTPS except on localhost and cannot include credentials, a path, query, or fragment. Auth callbacks exchange a PKCE code and redirect only to the allowlisted `/` or `/account` paths. Request `Host`, forwarded headers, absolute `next` values, protocol-relative values, backslashes, queries, and fragments cannot choose a destination.

## Signup modes

`AUTH_SIGNUP_MODE` is required and accepts exactly:

- `disabled`: the application renders no public create-account action and the server action rejects direct invocation;
- `public`: email/password account creation is available.

The committed local provider configuration is also deny-by-default (`auth.enable_signup = false`). The email provider remains enabled so invited/admin-created users can sign in; its narrower `auth.email.enable_signup` flag does not override the global signup denial. Integration tests first prove direct signup fails, then create users through the ephemeral local admin key, which is held only in process memory and redacted from output. For a private or invited product, keep the application and hosted provider signup modes disabled. The application flag does not replace provider configuration because callers can address the Auth API directly. Public mode requires an intentional provider change and same-browser PKCE email confirmation verification before release; token-hash templates, cross-device confirmation, password recovery, production SMTP, and CAPTCHA are product additions rather than hidden defaults.

Password sign-in runs in a Server Action, following the SSR reference shape. That makes provider IP throttling share the application's egress address. Before production, enable provider CAPTCHA and add an application/firewall rate limit keyed by client identity plus normalized email; an in-memory function counter is not a valid distributed control.

## Verification

`npm run auth:verify` starts an isolated local Auth + Data API stack, resets migrations, obtains ephemeral local keys without printing them, creates two synthetic users through the local admin boundary, signs in with the publishable key, persists one real session through an `@supabase/ssr` cookie adapter, rotates its refresh token, verifies the no-store header and claims in a fresh request-scoped client, and proves through PostgREST that the second user cannot read or forge the first user's row. Missing Docker is reported as `NOT RUN`, never passed, and the stack is stopped on success or failure.
