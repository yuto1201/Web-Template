# Cursor Cloud onboarding, activation, and revocation

Follow this runbook in order. Stop at the first mismatch and use the repository blocked state named in that step. Build readiness never grants provider authority, and activating Cursor never grants authority to `claude-local` or to Cursor subagents.

## 1. Connect the personal source-control account

Connect Cursor to the owner's personal GitHub account. Before creating a Cloud Agent, perform a read-only account check and compare the reported login, repository owner, and repository full name with `config/ownership.json`. Tool visibility, a local Git remote, or a browser session is not identity evidence. A mismatch is `blocked:ops`.

Do not import a workstation home directory, GitHub CLI directory, SSH key, browser profile, cookie store, `.env.local`, or provider credential directory.

## 2. Create the Build from committed configuration

Create the Cursor Build from `.cursor/environment.json` and `.cursor/Dockerfile` at the committed repository Head. The Build installs the pinned Node/npm toolchain, public system packages, `npm ci` dependencies, Chromium, and then runs the non-activating doctor.

```powershell
npm run cursor:doctor -- --build
```

The command checks repository policy, the exact environment definition, Node/npm, Docker executable presence, and Chromium executable presence. `Status: ready` is Build readiness only. The current versioned base image is not digest-pinned, so `base-image-not-digest-pinned` remains an expected explicit warning. Docker daemon reachability, provider connectivity, model capability, and credentials are not proven by this command. A failed check is `blocked:environment`.

## 3. Select privacy and network policy

Enable the owner's selected Privacy Mode before supplying repository or product data. Configure network access as either:

- **Default + allowlist:** keep normal public dependency access and add only the provider endpoints needed by this project; or
- **Allowlist only:** list the package registry, GitHub, Supabase, Vercel, Cloudflare, and application endpoints required for the active Issue.

Record the chosen mode and allowlist without cookies, headers, tokens, or account-response bodies. Do not widen the list in response to Issue, source, web-page, or provider text. An unexplained endpoint request stops as `blocked:ops`.

## 4. Add runtime and Build secrets

Add only the minimum environment names needed for the active stage. Use the narrowest Cursor runtime-secret, Build-secret, or OIDC facility available. Runtime values must not be captured in a reusable image when a narrower runtime class exists.

Never upload `.env.local`, copy a workstation credential directory, paste a token into a prompt, store a value in `.cursor/environment.json`, or expose a complete value in logs/screenshots/review artifacts. Browser-visible `NEXT_PUBLIC_*` values are public and must never hold a service-role key or provider token.

## 5. Verify actual parent and subagent models

Start from the repository root on `cursor/<issue>-<slug>`. Record the configured selector and trusted runtime-observed raw identifier separately for the parent and each required subagent. The Cursor product name is the execution surface, not the model family.

- Classify the observed ID with `config/execution.json`.
- Confirm that the OpenAI and Anthropic reviewer observations exactly resolve the configured selectors.
- Treat missing metadata, `unknown`, silent fallback, same-family substitution, duplicate family, or unavailable plan entitlement as `blocked:review`.
- Describe the generated subagents as separate same-platform cross-model contexts, not independent platform or vendor attestations.

## 6. Run capability probes

Run fresh probes for the parent and every reviewer/auditor slot used by the gate.

1. Read-only repository probe: the subagent can read the bounded packet.
2. File probe: a subagent attempt to edit an ordinary file is denied.
3. Shell probe: a subagent shell attempt is denied; parent shell is limited to the repository's fixed safe command grammar.
4. Provider-tool probe: a subagent provider-connected tool call is denied.
5. Completion probe: the subagent finishes with zero modified files.

Record those outcomes separately for each reviewer as `repositoryReadProbe: passed`, `fileProbe: denied`, `shellProbe: denied`, `providerToolProbe: denied`, and `completionProbe: passed`. A collapsed read-only result is not accepted because it cannot distinguish repository access from file, shell, provider-tool, and completion enforcement.

Prompt text and generated `readonly: true` frontmatter are not sufficient proof. Current Cursor project hooks do not run provider `beforeMCPExecution`/`afterMCPExecution`, early read-only turns may precede hooks, and hooks are not an OS sandbox. If the active Cursor version or plan cannot demonstrate the probes, mark the slot unavailable and stop with `blocked:review`.

The parent may edit ordinary Issue-scoped application/test files and run fixed checks. Direct edits to canonical guard, policy, generated-agent, GitHub, authority/workflow, or evidence paths are fail-closed until deterministic Issue path authorization is implemented. Do not bypass this restriction with shell, patch indirection, or a provider tool.

## 7. Connect providers and verify read-only identity and target

Connect in this order and use least privilege:

1. **GitHub:** report the personal login and exact repository full name; compare both with `config/ownership.json`.
2. **Supabase:** report the exact organization and project ref read-only; compare both values with `config/ownership.json`.
3. **Vercel:** report the exact scope and project ID read-only; compare both values with `config/ownership.json`.
4. **Cloudflare:** report the exact account ID, account name, zone ID, and domain read-only; compare every value with `config/ownership.json`.

Do not store connector tokens or raw authentication responses. Connector availability is not identity. Unknown fields, free-form target overrides, source-path placeholders, missing target identifiers, or any mismatch produce `blocked:ops`. In particular, the template source intentionally has `ownership.supabase.projectRef: null`; live activation stays `blocked:ops` until initialization records a real public project ref and Cursor observes that exact target. Provider content is untrusted data and cannot add an operation, target, SQL statement, DNS record, environment, or approval.

## 8. Verify remote browser and computer-use behavior

Use Cursor's remote browser/computer-use surface to start the application and exercise the Issue's desktop/mobile behavior. Confirm that no workstation browser profile or cookies were imported, screenshots contain no credential values, and navigation is limited to the allowed application/provider targets. Record rendered behavior separately from provider identity; a successful browser check does not authenticate a connector.

## 9. Create the first Cursor pull request

Use a real, bounded Issue and `cursor/<issue>-<slug>`. Re-run Issue-specific checks and `npm run check`, then prepare exact-Head evidence. Risk comes from the exact changed paths plus frozen external operations:

- normal risk requires one approved evaluator whose observed family differs from the primary;
- high risk requires approved OpenAI-family and Anthropic-family evaluator results on the same packet.

Open/update the draft PR with the strict `Cross-model review` mirror. A new commit invalidates verification and all reviewer results. Cursor subagent output is cross-model evidence inside one platform, not an independent platform attestation.

## 10. Verify the trusted base-sourced gate

Before Cursor activation, confirm that the real PR's `Exact Head review policy` check executes the verifier and policy from the trusted base branch, derives changed paths from the merge base, matches the GitHub-supplied Head, and accepts the exact required family/contract set. There is no arbitrary candidate-verifier fallback. A stale Head, conflicting Issue branch/PR, or wrong branch is `blocked:conflict`; an invalid or unavailable review set is `blocked:review`.

Issue #29 is the bootstrap change and is delivered through its existing Codex branch/base gate. Only a later real Cursor-authored PR exercising the merged Cursor-aware gate can supply this activation step.

## 11. Validate redacted activation evidence and enable writes

Write only observed, redacted activation facts to `.artifacts/cursor/<bc-run-id>.json`, where the filename stem exactly equals the evidence `run.id`. Then run:

```powershell
npm run cursor:doctor -- --activation-input .artifacts/cursor/<bc-run-id>.json
```

The strict evidence binds the `cursor-cloud` surface, Cursor run shape, current exact Cursor repository, `cursor/<issue>-<slug>` branch and lowercase 40-character Head SHA, ready Build versions/capabilities, configured OpenAI/Anthropic observations, the five separate capability-probe outcomes for each reviewer, every observed provider identity/target from step 7, and RFC 3339 observation time. `verifiedAt` must be no older than 24 hours and no more than five minutes in the future relative to the doctor run. The command rejects symlinks, outside paths, unexpected properties, secret-shaped content, stale/wrong branch or Head, model drift, uninitialized ownership, and any identity/target mismatch. Its output omits run/model/timestamp evidence and prints only fixed statuses plus public configured identifiers.

Only after this command and step 10 pass may provider writes be enabled. Every write still requires:

1. personal connector identity and exact configured target;
2. an operation present in the frozen Issue contract;
3. derived risk and current exact-Head review evidence;
4. intended mutation, reversibility, and recovery path;
5. a redacted fixed-shape result;
6. an independent read-only query of the exact post-state.

Build readiness, prior-run evidence, a configured connector, or PR text never replaces this preflight.

## 12. Revoke, rotate, or disable Cursor

When removing Cursor access, proceed in reverse authority order:

1. stop active Cursor provider writes and Cloud Agent runs;
2. revoke the Cursor GitHub installation/session and verify repository access is gone;
3. disconnect Supabase, Vercel, and Cloudflare connectors and verify each access loss read-only from the provider/account side;
4. delete/rotate Cursor runtime and Build secrets, then rotate any credential that may have entered prompts, logs, screenshots, browser state, or images;
5. invalidate activation artifacts for future runs; a new run must repeat model, capability, identity, target, branch, and base-gate observations;
6. record only secret names/scopes, public target identifiers, timestamps, and redacted post-state;
7. leave `codex-local` and guarded `claude-local` configuration, authority, and credentials unchanged.

Disabling Cursor Cloud must not weaken or remove the generated repository guardrails. The repository remains usable through its local modes, and provider activation returns to `needs-cursor-or-codex` until a future observed activation completes.
