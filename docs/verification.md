# Verification and evidence

## Required for every pull request

1. `npm run check`
2. Issue-specific acceptance checks
3. Independent cross-model review
4. Clean diff check and confirmation that unrelated user files were not staged
5. CI result on the pull request
6. For authenticated operations, protected-main authority digest, declared purpose, service mode, exact account/target, fresh preflight, one-time claim, and finalized result receipt

## Evidence quality

Evidence states what was actually observed. Keep these categories separate:

- Local repository: branch, commit, diff, build, tests
- GitHub connector: authenticated user, remote Issue/PR/check/merge state
- Provider connector or CLI: authenticated scope and resulting resource state
- Browser: rendered behavior and interaction result

Do not infer one category from another. For example, a local Git remote does not prove which GitHub connector identity is authenticated, and a configured plugin does not prove its account connection works.

Keep operator label, execution role, model family, account identity, service mode, and exact target separate. Claude and Codex have equal account-bound authority in operator roles; evaluator and auditor roles remain read-only, and opposite-model review remains independent. All repository-content-derived high-risk writes must show a fresh authoritative exact-Head gate. Candidate-branch ownership bytes are never accepted as the authority that delivers that branch.

## Failure handling

- Preserve the first useful error and the command that produced it.
- Fix causes rather than weakening a check.
- If a provider or Docker-dependent check cannot run, state that clearly and leave the Issue open unless its acceptance criteria permit a deferred environment check.
- A retry without changed inputs is not new evidence.
- After an ambiguous provider result, do not repeat the mutation. Read provider state, finalize the observed outcome, and resume only the missing phase under a new authorization if needed.

## Redaction

Keep only public identifiers, masked hints or SHA-256 fingerprints where required, redacted receipt IDs/digests, timestamps, commit SHAs, migration names, deployment IDs, and URLs intended for sharing. Never store raw personal email addresses, full secrets, tokens, cookies, or authentication responses.
