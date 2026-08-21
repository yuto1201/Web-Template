# Deployment boundary

Application deployment is introduced in Issue #6 and DNS routing in Issue #7. Until then, this file records the required boundary:

- Vercel Git integration owns preview and production application deployments.
- Cloudflare remains the registrar and authoritative DNS provider.
- Initial application DNS records are DNS-only and point to values supplied by the verified Vercel project.
- Production environment variables are never copied to preview automatically.
- Codex verifies Vercel scope/project and Cloudflare account/zone immediately before changes.
- Deployment and DNS changes are reported separately so either layer can be diagnosed without guessing.

Project-specific domains, environment IDs, and recovery instructions are added only after the corresponding personal resources exist.
