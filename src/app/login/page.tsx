import Link from "next/link";
import { getAuthConfiguration } from "@/lib/auth/config";
import { sanitizeRedirectPath } from "@/lib/auth/redirect";
import { loginAction, signupAction } from "./actions";

export const dynamic = "force-dynamic";

const messages: Record<string, string> = {
  auth_callback_failed: "The sign-in link could not be verified. Start again from this page.",
  check_email: "Check your inbox to finish creating the account.",
  invalid_credentials: "The email or password was not accepted.",
  invalid_signup: "Enter a valid email and a password of at least eight characters.",
  signed_out: "You have been signed out.",
  signup_disabled: "Public account creation is disabled for this application.",
  signup_failed: "The account could not be created. Try again later.",
};

type LoginPageProperties = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({ searchParams }: LoginPageProperties) {
  const parameters = await searchParams;
  const nextPath = sanitizeRedirectPath(first(parameters.next));
  const messageKey = first(parameters.error) ?? first(parameters.notice);
  const message = messageKey ? messages[messageKey] : null;
  const { signupMode } = getAuthConfiguration();

  return (
    <main className="auth-shell">
      <section className="auth-intro" aria-labelledby="login-title">
        <Link className="wordmark" href="/" aria-label="Return to the web application baseline">
          <span aria-hidden="true" className="wordmark-mark">W/</span>
          <span>Web application baseline</span>
        </Link>
        <div>
          <p className="eyebrow">Verified session boundary</p>
          <h1 id="login-title">Enter through one trusted door.</h1>
          <p className="hero-lede">
            Credentials are exchanged directly with Supabase Auth. Server access is granted only
            after the returned JWT signature and claims have been verified.
          </p>
        </div>
        <ul className="auth-proof" aria-label="Authentication guarantees">
          <li><span>01</span>PKCE cookie session</li>
          <li><span>02</span>Verified claims</li>
          <li><span>03</span>RLS on every query</li>
        </ul>
      </section>

      <section className="auth-panel" aria-label="Sign in form">
        <div className="auth-panel-heading">
          <p className="section-label">Account access</p>
          <h2>Sign in</h2>
          <p>{signupMode === "public" ? "Sign in or create a public account." : "Access is limited to existing or invited accounts."}</p>
        </div>

        {message ? <p className="form-message" role="status">{message}</p> : null}

        <form className="auth-form">
          <input type="hidden" name="next" value={nextPath} />
          <label>
            <span>Email</span>
            <input name="email" type="email" autoComplete="email" inputMode="email" required maxLength={254} />
          </label>
          <label>
            <span>Password</span>
            <input name="password" type="password" autoComplete="current-password" required minLength={8} maxLength={512} />
          </label>
          <div className="auth-actions">
            <button formAction={loginAction} className="primary-action" type="submit">Sign in</button>
            {signupMode === "public" ? (
              <button formAction={signupAction} className="secondary-action" type="submit">Create account</button>
            ) : null}
          </div>
        </form>

        <p className="auth-footnote">
          Signup mode: <strong>{signupMode}</strong>. This value is explicit server configuration,
          never inferred from the hosted provider.
        </p>
      </section>
    </main>
  );
}
