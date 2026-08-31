# Product specification

## Goal

Provide a polished, secure starting point for personal web applications without repeating repository policy, account checks, authentication plumbing, database safety, deployment setup, and cross-model review automation.

## Primary user

The repository owner creates a new repository from this GitHub template, fills in project-specific ownership and environment values, then delivers work through small GitHub Issues and squash-merged pull requests.

## Standard stack

- Next.js App Router with strict TypeScript
- Supabase Postgres and Auth
- Vercel Git integration for preview and production deployment
- Cloudflare as registrar and authoritative DNS
- Claude and Codex as equal implementers and external operators under account-bound authority
- Opposite-model evaluator and auditor roles that remain independent and read-only

## Required qualities

- Every generated website includes public Terms of Use at `/terms` and a Privacy Policy at `/privacy`, reachable from a shared footer without login. The template ships explicit unreviewed customization outlines; each app must finalize them against its actual service/data practices before public release.
- Secure by default, especially at browser/server and anonymous/authenticated boundaries
- Reproducible on Windows and GitHub Actions
- Issue-driven and resumable after interruption
- Reviewable by a second model with bounded evidence
- Clear separation between reusable template behavior and product-specific choices
- Explicit separation of operator label, execution role, model family, authenticated account, service mode, and exact target
- Provider use constrained by a frozen Issue purpose, protected-main authority, guarded receipts, and exact-Head review for high-risk writes

## Non-goals

- A universal framework generator supporting every frontend or cloud provider
- Automatic production deployment, DNS mutation, or database migration without an account-bound preflight, one-time claim, and finalized result
- OS-level isolation between local AI tools running as the same user
- A default billing, roles, organization, or audit-log product schema
- General Linear access: it remains explicit-user-purpose-only and every read/write fails closed because no Linear operation is registered, regardless of purpose or stable IDs
