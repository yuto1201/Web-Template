# Verification and evidence

## Required by risk

Risk is derived from the protected-base policy and the actual merge-base diff. It cannot be selected in the PR body or lowered by editing candidate configuration.

- Low: only the exact historical-plan Markdown files allowlisted in protected policy, `npm run check:docs` once at final Head, no independent reviewer. README and new documentation default to normal; normative `specs/**` stays high.
- Normal: focused tests or `npm run check:fast` during editing, then one final `npm run check`, Issue-specific acceptance checks, and one different observed reviewer family at the exact Head.
- High: the full normal gate plus every relevant database/auth, browser, macOS, template, deployment, or domain integration and approved OpenAI and Anthropic family reviews at the exact Head.

Every tier still needs a clean diff, confirmation that unrelated user files were not staged, and required CI on the pull request. Successful CI on the exact unchanged Head satisfies the before-merge rerun; rerun local full verification only after code or generated artifacts change. Completion audit is reserved for high-risk, template-release, or milestone work.

For authenticated operations, evidence also requires the protected-main authority digest, declared purpose, service mode, exact account/target, fresh preflight, one-time claim, and finalized result receipt. Such work cannot be low risk.

## Evidence quality

Evidence states what was actually observed. Keep these categories separate:

- Local repository: branch, commit, diff, build, tests
- GitHub connector: authenticated user, remote Issue/PR/check/merge state
- Provider connector or CLI: authenticated scope and resulting resource state
- Browser: rendered behavior and interaction result

Do not infer one category from another. For example, a local Git remote does not prove which GitHub connector identity is authenticated, and a configured plugin does not prove its account connection works.

Keep operator label, execution role, model identity, account identity, service mode, and exact target separate. Claude and Codex have equal account-bound authority in operator roles; evaluator and auditor roles remain read-only. Normal risk needs an independent opposite-family review, while high risk needs both OpenAI and Anthropic. All repository-content-derived high-risk writes must show a fresh authoritative exact-Head gate. Candidate-branch ownership bytes are never accepted as the authority that delivers that branch.

Batch reviewer findings into one revision pass where possible and target no more than two review rounds. Oversized work above 30 changed files or 3,000 changed lines should be split into independently safe Issues or carry a written atomicity justification; those thresholds never waive a security check.

## Failure handling

- Preserve the first useful error and the command that produced it.
- Fix causes rather than weakening a check.
- If a provider or Docker-dependent check cannot run, state that clearly and leave the Issue open unless its acceptance criteria permit a deferred environment check.
- A retry without changed inputs is not new evidence.
- After an ambiguous provider result, do not repeat the mutation. Read provider state, finalize the observed outcome, and resume only the missing phase under a new authorization if needed.

## Redaction

Keep only public identifiers, masked hints or SHA-256 fingerprints where required, redacted receipt IDs/digests, timestamps, commit SHAs, migration names, deployment IDs, and URLs intended for sharing. Never store raw personal email addresses, full secrets, tokens, cookies, or authentication responses.
