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
- Codex as primary developer and sole external-service operator
- Claude as independent evaluator or optional local implementation partner

## Required qualities

- Secure by default, especially at browser/server and anonymous/authenticated boundaries
- Reproducible on Windows and GitHub Actions
- Issue-driven and resumable after interruption
- Reviewable by a second model with bounded evidence
- Clear separation between reusable template behavior and product-specific choices

## Non-goals

- A universal framework generator supporting every frontend or cloud provider
- Automatic production deployment, DNS mutation, or database migration without a Codex preflight
- OS-level isolation between local AI tools running as the same user
- A default billing, roles, organization, or audit-log product schema
