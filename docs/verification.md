# Verification and evidence

## Required for every pull request

1. `npm run check`
2. Issue-specific acceptance checks
3. Independent cross-model review
4. Clean diff check and confirmation that unrelated user files were not staged
5. CI result on the pull request

## Evidence quality

Evidence states what was actually observed. Keep these categories separate:

- Local repository: branch, commit, diff, build, tests
- GitHub connector: authenticated user, remote Issue/PR/check/merge state
- Provider connector or CLI: authenticated scope and resulting resource state
- Browser: rendered behavior and interaction result

Do not infer one category from another. For example, a local Git remote does not prove which GitHub connector identity is authenticated, and a configured plugin does not prove its account connection works.

## Failure handling

- Preserve the first useful error and the command that produced it.
- Fix causes rather than weakening a check.
- If a provider or Docker-dependent check cannot run, state that clearly and leave the Issue open unless its acceptance criteria permit a deferred environment check.
- A retry without changed inputs is not new evidence.

## Redaction

Keep only public identifiers, last-four style fingerprints when useful, timestamps, commit SHAs, migration names, deployment IDs, and URLs intended for sharing. Never store full secrets or authentication responses.
