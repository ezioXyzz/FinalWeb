# EzioCloud

A private Google Drive workspace with a neon-glass interface, local sign-in, role-aware settings, and a shared Notes & Links collection. Developed by **imira_H**.

## Features

- Google Drive file browsing, upload, and download (20 MiB maximum per file).
- Search, including the `/` keyboard shortcut.
- Shared Notes & Links collection available to every signed-in account.
- Imira-only settings and Notes & Links management; members can browse the collection and upload/download files.
- A separate Cloudflare Workers + D1 deployment path; the existing managed WebDev/MySQL runtime is retained.

All accounts in this app use one shared Google Drive connection. The Drive files remain in Google Drive; D1 stores the Drive connection tokens and shared link records. A new Cloudflare D1 database starts empty and does not import data from the managed WebDev database.

## Cloudflare deployment

Follow **[CLOUDFLARE_DEPLOY.md](./CLOUDFLARE_DEPLOY.md)** for D1 creation/migrations, runtime secrets, Google OAuth configuration, local preview, and GitHub-connected Workers Builds.

The repository includes `.dev.vars.example` with placeholders for local testing. Never commit `.dev.vars`, production credentials, or real passwords. Use unique passwords and rotate any OAuth client secret that may have been exposed before deployment.

## Verify the project

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm run build:cloudflare
```

The Cloudflare build uses `wrangler.jsonc` and `drizzle/d1/`. Replace the placeholder D1 database ID and apply the remote migration before the first production deployment.
