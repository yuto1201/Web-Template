# Verification and evidence

## Required for every pull request

1. `npm run check`
2. Issue-specific acceptance checks
3. Risk-derived exact-Head cross-model review using runtime-observed model identities
4. Clean diff check and confirmation that unrelated user files were not staged
5. CI result on the pull request

## Evidence quality

Evidence states what was actually observed. Keep these categories separate:

- Local repository: branch, commit, diff, build, tests
- Execution: `codex-local`, `claude-local`, or `cursor-cloud`, plus run identifier
- Model: configured selector, raw runtime-observed ID, normalized family, fallback, and exposed parameters
- Cursor Build: committed environment, pinned runtime, Docker/Chromium executable availability
- GitHub connector: authenticated user, remote Issue/PR/check/merge state
- Provider connector or CLI: authenticated scope and resulting resource state
- Browser: rendered behavior and interaction result

Do not infer one category from another. A local Git remote does not prove which GitHub connector identity is authenticated; a configured plugin does not prove its connection works; Cursor Cloud does not prove a Cursor model family; a configured model does not prove the served model; and two Cursor subagents do not prove independent platforms.

Normal risk needs one approved reviewer family different from the observed primary family. High risk needs approved OpenAI and Anthropic family results, independently bound to the same Issue digest, exact Head, byte-exact diff, verification SHA, risk reasons, and contracts. Unknown/fallback/duplicate family evidence, stale Head, missing capability probes, or a single high-risk result leaves `blocked:review`.

## Cursor verification layers

1. `npm run cursor:doctor -- --build` verifies repository and Build readiness without reading `.env`, enumerating environment values, contacting providers, or granting provider authority.
2. Live onboarding observes actual parent/reviewer models; separate repository-read, file-denial, shell-denial, provider-tool-denial, and clean-completion probes for every reviewer; remote browser/computer-use; and every expected personal connector identity/target.
3. `npm run cursor:doctor -- --activation-input .artifacts/cursor/<file>.json` validates strict redacted evidence against the current `cursor/<issue>-<slug>` branch and exact Head SHA, configured models, a timestamp no older than 24 hours or more than five minutes in the future, and the exact public GitHub, Supabase, Vercel, and Cloudflare identifiers in `config/ownership.json`. Missing configured targets such as a null Supabase project ref block activation.
4. A real Cursor-authored PR must pass the trusted base-sourced exact-Head gate before provider writes are enabled.
5. Every provider write records its frozen Issue operation, redacted result, and independently queried post-state.

Build readiness and live activation are separate. A generated clean-room repository retains provider activation status `needs-cursor-or-codex` until layer 2–4 evidence exists.

## Failure handling

- Preserve the first useful error and the command that produced it.
- Fix causes rather than weakening a check.
- If a provider or Docker-dependent check cannot run, state that clearly and leave the Issue open unless its acceptance criteria permit a deferred environment check.
- Map Cursor failures without weakening requirements: environment/build to `blocked:environment`, model/read-only evidence to `blocked:review`, connector identity/target to `blocked:ops`, and branch/Head/concurrency to `blocked:conflict`.
- A retry without changed inputs is not new evidence.

## Redaction

Keep only public identifiers, last-four style fingerprints when useful, timestamps, commit SHAs, migration names, deployment IDs, and URLs intended for sharing. Never store full secrets or authentication responses.

Do not store raw prompts, transcripts, unredacted connector responses, complete account data, environment values, tokens, cookies, screenshots containing credentials, or provider response bodies in Git, PR text, or review artifacts.
