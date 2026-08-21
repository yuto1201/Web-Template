# macOS workstation onboarding

This runbook moves development to a fresh Mac without copying machine-local build output or credentials. It applies to Apple Silicon (`arm64`) and Intel (`x64`). The repository remains the source of truth; the old workstation is not cloned as a filesystem image.

## 1. Finish on the old workstation

Before leaving the old machine:

1. Make every intended change part of a reviewed and merged pull request.
2. Confirm `git status --short` is empty and record the current `main` commit SHA.
3. Record only the **names** of required environment variables from `.env.example`. Do not put values in an Issue, PR, screenshot, shell history, or migration note.
4. Keep the old machine available until the Mac passes the completion gate below.

Do not copy `node_modules/`, `.next/`, `.artifacts/`, `.vercel/`, `.supabase/`, browser profiles, SSH private keys, cookies, or home-directory credential folders. Reauthenticate providers on the Mac through their supported sign-in flows. Re-enter `.env.local` values from the authoritative secret source instead of transferring the file through Git, chat, or cloud storage.

## 2. Install machine prerequisites

Install the Xcode command-line tools:

```bash
xcode-select --install
```

Install a Node version manager that honors `.node-version` or `.nvmrc` (`fnm`, `mise`, `asdf`, or `nvm` are suitable). The example below uses `nvm`; when using another manager, use its equivalent install and activate commands. Then install the repository-pinned versions:

```bash
nvm install
nvm use
npm install --global npm@11.6.2
node --version
npm --version
git --version
```

Expected versions are Node `24.13.0` and npm `11.6.2`. The lockfile contains native packages for both Darwin ARM64 and Darwin x64; never copy `node_modules` from Windows or between CPU architectures.

Install Docker Desktop for the Mac's CPU architecture and start it before DB/Auth verification. A global Supabase CLI is not required because the pinned CLI is installed from `package-lock.json`.

## 3. Clone and build from clean state

Use a fresh clone, then run all commands from the repository root:

```bash
git clone https://github.com/OWNER/REPOSITORY.git
cd REPOSITORY
npm ci
npx playwright install chromium
cp .env.example .env.local
npm run workstation:doctor
npm run check
npm run test:e2e
```

Replace only the values in `.env.local` that are required for the selected local or hosted target. `workstation:doctor` checks only whether the file exists; it never reads or prints its contents.

For a generated application, run template initialization before `npm ci`, exactly as described in the root README. For this golden source repository, do not rerun initialization.

## 4. Re-establish account boundaries

Authentication state is machine-specific. Verify each surface independently on the Mac:

- Codex performs authenticated operations for the personal GitHub repository and personal Supabase, Vercel, and Cloudflare targets.
- Claude may implement or evaluate local files, but the company Claude account must not access provider connectors, CLIs, hosted databases, deployments, DNS, or personal secrets.
- `gh auth status` reports only the local GitHub CLI identity. It may intentionally differ from the GitHub account connected to Codex. Do not merge or unify the accounts merely to remove that difference.
- The committed `.codex/` and `.claude/` project files are repository policy. Home-directory `.codex`, `.claude`, `.config/gh`, Supabase, Vercel, and Cloudflare credential directories are not project files and must not be copied from the old workstation.

Before the first authenticated write from the Mac, Codex must recheck the live identity, exact target, intended mutation, local evidence, and resulting remote state as required by [the authority runbook](authority.md).

## 5. Complete the migration gate

With `.env.local` re-entered and Docker Desktop running:

```bash
npm run workstation:doctor -- --require-env --require-docker
npm run check
npm run test:e2e
npm run db:verify
npm run auth:verify
npm run db:stop
git status --short
```

The migration is complete only when the doctor, repository checks, browser checks, DB policy, and Auth integration pass, `git status --short` is empty, and provider identities have been verified on the Mac. Until the DB/Auth commands are run on that Mac, their status remains unverified rather than passed.

GitHub-hosted macOS CI verifies the fresh install, doctor, full repository checks, and browser smoke on macOS. It does not provide Docker Desktop, so the strict Docker path and DB/Auth integration remain a required gate on the target Mac itself.

## Recovery guide

| Symptom | Corrective action |
|---|---|
| Node or npm mismatch | Re-enter the version manager environment, reinstall Node from `.nvmrc`, and pin npm `11.6.2`. |
| Native module or SWC error | Delete only `node_modules`, then rerun `npm ci` on the Mac; never reuse the Windows installation. |
| Chromium executable missing | Run `npx playwright install chromium`, then retry `npm run test:e2e`. |
| Docker CLI passes but daemon fails | Open Docker Desktop, wait for the engine to become ready, and rerun the strict doctor. |
| Supabase port collision | Stop the other stack or choose a non-overlapping `supabaseBase` during template initialization. |
| Wrong GitHub identity | Stop before writing. Verify the Codex connector and `gh auth status` separately; use the authorized personal surface for the operation. |
