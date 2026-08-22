# Product specification

## Goal

Provide a polished, secure starting point for personal web applications without repeating repository policy, account checks, authentication plumbing, database safety, deployment setup, and cross-model review automation.

## Primary user

The repository owner creates a new repository from this GitHub template, fills in project-specific ownership and environment values, then delivers small GitHub Issues through local Codex, guarded local Claude, or an activated Cursor Cloud surface and squash-merged pull requests.

## Standard stack

- Next.js App Router with strict TypeScript
- Supabase Postgres and Auth
- Vercel Git integration for preview and production deployment
- Cloudflare as registrar and authoritative DNS
- Codex local as a primary developer and owner-authenticated provider operator
- Claude local as a guarded evaluator, consultant, or assigned implementation partner with no provider authority
- Cursor Cloud as an optional cloud execution surface whose provider authority starts only after live owner-authenticated activation

## Required qualities

- Secure by default, especially at browser/server and anonymous/authenticated boundaries
- Reproducible on Windows and GitHub Actions
- Issue-driven and resumable after interruption
- Reviewable from bounded exact-Head evidence using runtime-observed model families
- Reproducible in a credential-free Cursor Build without copying a workstation home directory or `.env.local`
- Able to disable or revoke Cursor Cloud without changing local Codex/Claude behavior
- Clear separation between reusable template behavior and product-specific choices

## Non-goals

- A universal framework generator supporting every frontend or cloud provider
- Automatic production deployment, DNS mutation, or database migration without a Codex or activated-Cursor provider preflight
- OS-level isolation between local AI tools running as the same user
- Treating Cursor product identity, configured model selectors, or same-platform subagents as independent provider attestations
- Activating Cursor Cloud from Build readiness alone
- A default billing, roles, organization, or audit-log product schema
