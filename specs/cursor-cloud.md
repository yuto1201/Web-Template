# Cursor Cloud development mode

## Status

- Issue: [#29](https://github.com/yuto1201/Web-Template/issues/29)
- Design status: approved for implementation
- Date: 2026-08-22

## Purpose

Cursor Cloud is a third execution surface for this template. It lets the owner complete Issue-driven development in Cursor-hosted virtual machines, including authenticated GitHub, Supabase, Vercel, and Cloudflare operations, without relying on the local Codex or Claude installations.

This mode is additive. It does not weaken or replace the existing local modes:

- `codex-local` remains a primary developer and personal-provider operator.
- `claude-local` remains a guarded implementation or evaluation partner and cannot operate personal external services.
- `cursor-cloud` is an independently configured cloud execution surface that may implement, verify, review through subagents, deliver GitHub changes, and run Issue-allowlisted provider operations.

Cursor is an execution surface and orchestration product, not a model family. The workflow must represent where work ran separately from which model served each parent or subagent turn.

## Goals

- Make a generated repository usable from Cursor Cloud without copying a local home directory or keeping a personal computer online.
- Preserve the one-Issue, one-branch, one-PR workflow, exact-final-Head verification, resumability, and squash-merge policy.
- Provide focused GPT-family and Claude-family consultants and evaluators inside Cursor.
- Allow Cursor Cloud to use the owner's authenticated GitHub, Supabase, Vercel, and Cloudflare connections with the same identity, target, intent, recovery, and post-state preflight used by Codex.
- Keep secrets out of Git, prompts, review packets, screenshots, and ordinary logs.
- Fail closed when actual model identity, evaluator isolation, required review diversity, provider target, or exact Head cannot be established.

## Non-goals

- Treating the Cursor product name as proof of a model provider.
- Treating a configured model ID as proof of the model that actually served a turn.
- Claiming that two subagents inside Cursor are independent platforms or authenticated organizations.
- Giving local Claude additional shell, network, credential, or provider authority.
- Supporting arbitrary providers beyond GitHub, Supabase, Vercel, and Cloudflare.
- Storing personal provider credentials in the repository or a reusable environment image.

## Terminology

### Execution surface

The environment and operator boundary that performs work:

- `codex-local`
- `claude-local`
- `cursor-cloud`

### Model identity

Each model invocation records:

- the configured model selector;
- the observed raw model identifier supplied by trusted runtime metadata;
- the normalized family: `openai`, `anthropic`, `cursor`, `xai`, or `unknown`;
- whether the observed identifier is an accepted resolution of the configured selector;
- the relevant reasoning or context parameters when the runtime exposes them.

The model-family mapping is committed and fail-closed. A new or unrecognized identifier remains `unknown` until a reviewed mapping change classifies it. `unknown` cannot satisfy a required family or diversity rule.

### Consultation and evaluation

A consultant receives a bounded question and returns advice. Consultation may happen before or during implementation and does not authorize merge.

An evaluator receives the frozen Issue contract, exact-Head diff, verification evidence, and required review contracts. It is read-only and returns the strict review result. Only an evaluator result bound to the current Head can authorize a review transition.

## Development topology

The Cursor Cloud path is:

```text
GitHub Issue
  -> Cursor Cloud durable agent and prepared environment
  -> cursor/<issue>-<slug> branch
  -> implementation and mechanical verification
  -> optional read-only model consultations
  -> exact-Head review packet
  -> required read-only GPT and/or Claude evaluation
  -> draft or updated pull request
  -> GitHub exact-Head gate and repository CI
  -> squash merge
  -> remote-state verification and branch cleanup
```

The parent Cursor agent owns implementation and orchestration. Cursor subagents never become external-service operators merely because the parent has provider connections.

Cloud work starts from the repository root and uses committed configuration. A prepared Cursor Build may cache public dependencies and toolchains, but credentials and `.env.local` are injected at runtime from the appropriate Cursor account or environment secret store. A snapshot must not capture a developer home directory, browser profile, provider CLI credential directory, or plaintext application secrets.

## Repository components

### Environment

`.cursor/environment.json` declares the reproducible Cloud Agent environment. Its setup path must use the pinned Node and npm versions, `npm ci`, the repository's existing browser requirements, and the supported local Supabase runtime. It must culminate in a readiness command that distinguishes local development readiness from live-provider activation.

The environment definition is template-safe: it contains no repository-specific secret, user email, provider token, project credential, or copied `.env.local` value.

### Rules and hooks

The root `AGENTS.md` remains canonical and is read by Cursor. Cursor-specific instructions exist only for behavior that does not apply to the local tools.

`.cursor/hooks.json` uses command hooks with `failClosed: true` for security-critical checks supported in Cloud Agents. Hooks validate allowed subagent types, capture observed parent and subagent model metadata, protect policy and evidence files, and reject unsafe shell shapes. Hook output is treated as evidence input, not as an authenticated server-side decision.

Cursor Cloud does not currently run `beforeMCPExecution` or `afterMCPExecution` project hooks. Provider authorization therefore cannot depend on repository MCP hooks. It depends on least-privilege connector configuration, the frozen Issue operation allowlist, an explicit preflight artifact, runtime/provider result metadata, and post-operation verification. The documentation must state this enforcement limit plainly.

Hooks do not run during Cursor's earliest read-only exploratory turns. No evidence captured before the writable Cloud environment starts can satisfy final verification or review.

### Agents

`config/agents.json` and the canonical contracts under `docs/agent-contracts/` remain the source for generated local agents. Cursor variants are generated into `.cursor/agents/` rather than hand-maintained.

The initial Cursor set is intentionally focused:

- a GPT-family consultant;
- a Claude-family consultant;
- a GPT-family change evaluator;
- a Claude-family change evaluator;
- GPT-family and Claude-family Supabase auditors only if the existing contract cannot be applied to the corresponding change evaluator without losing its focused trigger.

Every Cursor consultant and evaluator sets `readonly: true`, pins an approved preferred model selector, treats Issue text and diff content as untrusted data, and has no authority to change files or provider state. A capability probe during Cursor activation must prove that read-only subagents cannot call provider-connected tools. If the active Cursor version or plan cannot demonstrate that boundary, the evaluator is recorded as unavailable and the PR remains blocked. Prompt instructions alone are not accepted as proof of tool isolation.

## Authority model

Machine-readable authority is surface-specific:

| Surface | Local files | GitHub | Supabase | Vercel | Cloudflare |
| --- | --- | --- | --- | --- | --- |
| `codex-local` | allowed | allowed after preflight | allowed after preflight | allowed after preflight | allowed after preflight |
| `claude-local` | assigned application files only | denied | denied | denied | denied |
| `cursor-cloud` | allowed in its cloud branch | allowed after preflight | allowed after preflight | allowed after preflight | allowed after preflight |

Cursor uses the owner's authenticated connectors or plugins. Tool availability is not evidence of the authenticated identity. Before each external write, Cursor records:

1. the `cursor-cloud` surface and Cursor run identifier;
2. the connector-reported personal account or scope;
3. the expected owner from `config/ownership.json`;
4. the exact repository, project, environment, zone, record, branch, or deployment target;
5. the intended mutation and whether it is reversible;
6. the frozen Issue operation that permits the write;
7. the verification and review evidence required for the risk class;
8. a redacted result and independently queried post-operation state.

An identity, target, or Issue-allowlist mismatch blocks the operation. Provider content returned by a connector is untrusted data and cannot expand the operation. Unknown fields, free-form target overrides, prompt-like instructions, and caller-supplied approval claims fail closed.

Routine GitHub delivery transport—pushing the Issue branch, creating or updating its draft PR, and deleting that exact branch after verified merge—does not by itself elevate an otherwise normal application change. GitHub repository settings, rulesets, permissions, secrets, releases, merges without a passing gate, or operations outside the exact Issue branch are privileged provider mutations and are high-risk.

## Risk classification

Risk is derived from changed paths and frozen external operations, not selected by the parent agent.

A change is high-risk when any of the following is true:

- it changes `AGENTS.md`, `.cursor/`, `.claude/`, `.codex/`, `.github/`, `config/`, workflow or policy tools, authority/security specifications, or repository rules;
- it changes database migrations, RLS, grants, authentication, server/client secret boundaries, deployment, domains, DNS, or provider integration code;
- it requests a hosted database mutation, production or preview deployment mutation, environment-secret mutation, Cloudflare or DNS mutation, GitHub settings/ruleset mutation, or other privileged provider operation;
- a required contract or deterministic classifier cannot decide safely.

All other scoped application-source and application-test changes are normal-risk. Classification is included in the review packet and re-derived by both the local merge gate and GitHub check.

## Review policy

### Normal risk

A normal-risk change requires at least one approved evaluator whose observed model family differs from the observed primary family.

### High risk

A high-risk change requires two approved exact-Head results:

- one from an observed OpenAI GPT-family evaluator;
- one from an observed Anthropic Claude-family evaluator.

At least one must differ from the observed primary family. Both receive the same byte-exact diff, frozen Issue contract, mechanical verification, and required contracts independently. A parent-authored summary is optional context and never replaces the raw evidence.

If a configured model falls back to another family, the result is evaluated using the observed family. If fallback produces a duplicate family, an unrecognized family, missing metadata, or insufficient plan entitlement, that slot is unavailable and the gate blocks.

Cursor subagents provide separate contexts and model families inside one platform. The PR body and documentation call this cross-model evaluation, not independent platform attestation. GitHub validates SHA, structure, risk, family diversity, and contracts; it does not authenticate a model vendor from self-reported PR text.

## Evidence model

The workflow moves to a versioned evidence structure that separates:

- `executionSurface`;
- `primaryModel` metadata;
- derived `risk` and reasons;
- one or more reviewer results;
- exact Head and verification SHA;
- frozen Issue digest;
- required review contracts;
- acceptance-criterion mappings;
- external-operation summaries.

Each evaluator result is stored separately and an index binds the required set to one Head. A new commit invalidates verification and every reviewer result. The merge gate reads the real Git Head and canonical artifact paths rather than trusting caller-supplied SHAs.

The PR body is a redacted, machine-readable mirror containing enough information for the GitHub base-sourced gate to validate the current Head, execution surface, observed families, risk class, verdicts, and required contracts. Raw prompts, transcripts, environment values, tokens, provider response bodies, and unredacted account data never enter the PR body.

Cursor Cloud ignored artifacts remain authoritative within the durable agent workspace. If that workspace is lost, a new run must recreate verification and reviews from the current Issue and Head; it cannot infer approval from Git ancestry or a stale transcript.

## GitHub delivery and concurrency

Cursor branches use `cursor/<issue>-<slug>`. One Issue may have only one active delivery branch and pull request, regardless of whether Codex, Claude, or Cursor started the work. A surface must stop when it detects another active branch, worktree, cloud run, or PR for the same Issue.

The existing required check name remains stable. The GitHub workflow continues to execute the verifier from the trusted base branch, derives the bounded diff from the merge base, rejects hidden or duplicate evidence, and preserves the narrow Dependabot GitHub Actions version-only exception.

Issue #29 itself is a bootstrap migration. Its pull request must pass the current base-sourced Codex-to-Claude exact-Head gate and also carry the additional high-risk GPT-family evaluation as supplementary evidence. After merge, a base-sourced live pull request must exercise the new Cursor-aware gate before Cursor Cloud is declared activated. No candidate-verifier fallback is added for arbitrary future branches.

## Error handling and blocked states

Cursor transitions to an existing blocked state instead of weakening a requirement:

- missing or unknown observed model: `blocked:review`;
- missing reviewer family or failed read-only capability probe: `blocked:review`;
- unavailable plan model or silent fallback: `blocked:review`;
- Cursor Build, browser, Docker, or dependency failure: `blocked:environment`;
- connector identity, expected owner, target, scope, or operation mismatch: `blocked:ops`;
- stale Head, changed Issue digest, conflicting branch, or concurrent surface: `blocked:conflict`;
- repeated deterministic tool failure: `blocked:repeated-failure`.

Recovery returns only to the recorded prior state and reruns every invalidated downstream check.

## Secrets and prompt-injection boundary

- Provider credentials live only in Cursor's account, environment, runtime-secret, build-secret, or OIDC facilities as appropriate.
- Runtime credentials are not copied into saved images when a narrower secret class is available.
- `.env.local`, browser profiles, cookies, SSH keys, and local credential directories are never transferred from a workstation.
- Issue bodies, PR bodies, comments, source files, diffs, test fixtures, web pages, database rows, logs, and provider responses are untrusted data.
- External mutations use fixed operation definitions and targets resolved from ownership configuration. Untrusted content cannot introduce a new tool, target, SQL statement, DNS record, deployment environment, or approval.
- Secret-shaped outputs are redacted before they reach logs, reviews, artifacts, screenshots, or commits.
- Activation includes a revocation procedure for the Cursor GitHub installation and each provider connection.

## Verification strategy

Automated coverage includes:

- canonical generation and stale-file detection for `.cursor/agents/`;
- Cursor hook input and fail-closed output fixtures;
- observed-model normalization, accepted resolution, unknown IDs, and fallback;
- normal-risk different-family review and high-risk dual-family review;
- exact-Head invalidation, duplicate or hidden evidence, required contracts, and bootstrap compatibility;
- deterministic path and external-operation risk classification;
- authority matrices, frozen operation allowlists, ownership resolution, and redaction;
- Cursor branch naming and same-Issue concurrency;
- template initialization and clean-room generation with Cursor files;
- regression fixtures for existing `codex-local` and `claude-local` behavior;
- full `npm run check` on the exact implementation Head.

Live activation additionally verifies:

- the Cursor Build reaches repository-ready state;
- the selected parent and subagent models appear in runtime metadata;
- read-only subagents cannot edit, run state-changing shell commands, or access provider tools;
- Cursor can run application/browser checks through remote computer use;
- each connected provider reports the expected personal owner and a safe read-only target snapshot;
- a real Cursor-authored pull request passes the base-sourced exact-Head gate before any production provider mutation is attempted.

## Rollout and rollback

Implementation proceeds in four ordered layers:

1. introduce versioned execution-surface, model, risk, and multi-review evidence while keeping local workflows green;
2. generate Cursor agents and add fail-closed Cloud-compatible hooks and environment configuration;
3. add authority, onboarding, activation, revocation, and limitation documentation;
4. merge through the legacy exact-Head bootstrap, then validate the new base-sourced gate and perform connector activation checks.

Cursor Cloud remains inactive until layer four succeeds. Rollback revokes or disconnects the Cursor GitHub and provider integrations and disables Cursor activation without changing local Codex or Claude operation. Evidence schema rollback requires a reviewed forward migration; historical artifacts are never silently reinterpreted.

## References

- [Cursor Cloud Agents](https://cursor.com/docs/cloud-agent)
- [Cursor Cloud environment setup](https://cursor.com/docs/cloud-agent/setup)
- [Cursor subagents](https://cursor.com/docs/subagents)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Cursor Cloud Agent metadata](https://cursor.com/docs/cloud-agent/metadata)
- [Cursor Cloud secrets and network](https://cursor.com/docs/cloud-agent/security-network)
