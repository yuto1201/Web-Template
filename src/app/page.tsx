import Link from "next/link";
import { getPublicEnvironment } from "@/lib/env/public";

const trace = [
  { label: "Code", detail: "Issue-shaped change" },
  { label: "Data", detail: "Row-level boundary" },
  { label: "Runtime", detail: "Preview before production" },
  { label: "Domain", detail: "DNS with an explicit target" },
];

const sequence = [
  ["Define", "Replace the product brief, acceptance criteria, and ownership placeholders."],
  ["Connect", "Create personal provider resources only after Codex verifies the active account."],
  ["Prove", "Keep denied cases, browser behavior, and build output inside the same review packet."],
  ["Release", "Promote one reviewed commit through preview, production, then DNS."],
];

export default function Home() {
  getPublicEnvironment();

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="site-header" aria-label="Site header">
        <Link className="wordmark" href="/" aria-label="Web application baseline home">
          <span aria-hidden="true" className="wordmark-mark">W/</span>
          <span>Web application baseline</span>
        </Link>
        <div className="header-actions">
          <span className="status"><i aria-hidden="true" /> boundary checks ready</span>
          <Link className="header-link" href="/login">Sign in</Link>
        </div>
      </header>

      <main id="main-content">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">Baseline / App Router / strict by default</p>
            <h1 id="hero-title">Start with the boundaries already drawn.</h1>
            <p className="hero-lede">
              A quiet launchpad for web applications that need a real database, repeatable reviews,
              and a production path that never guesses which account it is changing.
            </p>
            <div className="hero-actions">
              <a className="primary-action" href="#launch-sequence">Review the launch sequence</a>
              <a className="text-action" href="#trust-boundary">Inspect the trust boundary <span aria-hidden="true">↘</span></a>
            </div>
          </div>

          <div className="trace" role="group" aria-label="Application delivery path">
            <div className="trace-rail" aria-hidden="true"><span /></div>
            <ol>
              {trace.map((item, index) => (
                <li key={item.label}>
                  <span className="trace-index">0{index + 1}</span>
                  <span className="trace-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
                  <span className="trace-state">checked</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="boundary" id="trust-boundary" aria-labelledby="boundary-title">
          <div>
            <p className="section-label">Trust boundary</p>
            <h2 id="boundary-title">Every value has one side of the glass.</h2>
          </div>
          <dl>
            <div><dt>Public</dt><dd>Publishable browser configuration only</dd></div>
            <div><dt>Server</dt><dd>Secrets stay outside the client module graph</dd></div>
            <div><dt>External</dt><dd>Authenticated provider work stays with Codex</dd></div>
          </dl>
        </section>

        <section className="sequence" id="launch-sequence" aria-labelledby="sequence-title">
          <div className="sequence-heading">
            <p className="section-label">Launch sequence</p>
            <h2 id="sequence-title">Turn the baseline into one specific product.</h2>
          </div>
          <ol>
            {sequence.map(([title, detail], index) => (
              <li key={title}>
                <span className="sequence-index">{String(index + 1).padStart(2, "0")}</span>
                <h3>{title}</h3>
                <p>{detail}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer>
        <p>Ready to become something specific.</p>
        <span>Next.js · Supabase · Vercel · Cloudflare DNS</span>
      </footer>
    </>
  );
}
