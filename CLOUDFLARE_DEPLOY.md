# Deploy EzioCloud to Cloudflare Workers + D1

EzioCloud has a separate Cloudflare deployment path; the existing managed WebDev/MySQL runtime remains intact. The Cloudflare version serves the React/Vite app as Workers Static Assets, routes tRPC through its native Fetch adapter (no Express body-parser in the Worker), uses D1 for Drive connection tokens and shared Notes & Links, and uses Fetch-based Google API calls. Cloudflare uploads and downloads stream file bytes rather than base64-encoding them in tRPC JSON; uploads use Workers' [FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/request/#set-the-content-length-header) so the runtime emits the `Content-Length` Google requires for a [resumable upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

## Before going public

- **Never commit secrets.** Set `JWT_SECRET`, `LOCAL_AUTH_USERS_JSON`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` as **runtime Worker secrets**, not GitHub source values or Cloudflare build-only variables.
- **Replace every demo password** with a new, long, unique password for Imira and each member. Do not reuse credentials shared in earlier preview/testing.
- Enable the **Google Drive API** in Google Cloud. Add the final site origin with a trailing `/` as an authorized redirect URI, then set the exact same URI in `GOOGLE_REDIRECT_URI`. If the OAuth consent screen is still in Testing, add the intended Google account as a test user.
- D1 is a **new database**. Existing WebDev users, OAuth tokens, and links are not migrated. Reconnect Google Drive and re-enter any shared links after deployment.
- Google Drive continues to hold the files; D1 stores only the connection tokens and shared Notes & Links data. All three EzioCloud logins share one Google Drive workspace.
- Workers Free has a **10 ms CPU budget per request** ([current limits](https://developers.cloudflare.com/workers/platform/limits/)). The 20 MiB file-transfer paths stream bytes to reduce CPU and memory overhead, but token refresh, database calls, and real Google API behavior still need validation on your target Cloudflare plan. Cloudflare's Free request-body limit is 100 MB, so the 20 MiB upload cap is below that platform limit.

## 1. Create and bind D1

From the repository root, install exactly the committed dependencies and create the D1 database:

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler d1 create eziocloud-db --binding DB --update-config
```

If Wrangler does not update the config automatically, copy the database ID it returns into the `DB` entry in `wrangler.jsonc`, replacing the local placeholder UUID. Keep `database_name` as `eziocloud-db` and `migrations_dir` as `drizzle/d1`. Commit the real D1 ID in the repository; it is an identifier, not a secret.

Apply the migration locally first, then to the new remote database:

```sh
pnpm exec wrangler d1 migrations apply eziocloud-db --local
pnpm exec wrangler d1 migrations apply eziocloud-db --remote
```

Review the target database before applying the remote migration.

## 2. Configure runtime secrets

For a local Worker preview, copy `.dev.vars.example` to `.dev.vars`, replace all placeholders with test-only values, and never commit `.dev.vars`.

For a manually managed Worker, set each secret with Wrangler:

```sh
pnpm exec wrangler secret put JWT_SECRET
pnpm exec wrangler secret put LOCAL_AUTH_USERS_JSON
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put GOOGLE_REDIRECT_URI
```

`LOCAL_AUTH_USERS_JSON` is a JSON object mapping usernames to passwords, for example `{"imira":"new-admin-password","pahan":"new-member-password","buddi":"new-member-password"}`. Use your own unique values. For GitHub-connected deployments, the same **runtime** secrets can be entered in the Worker dashboard under **Settings → Variables & Secrets**. Do not put them in Workers Builds' build-variable section; build variables are not available to the app at request time.

## 3. Preview and deploy manually

```sh
pnpm run preview:cloudflare
pnpm run deploy:cloudflare
```

The preview script applies the frontend build and starts Wrangler locally; make sure the local D1 migration and `.dev.vars` are configured first. The production deploy script builds the app and deploys the Worker plus static assets.

`wrangler.jsonc` configures the D1 binding, SPA fallback, and `/api/*` Worker-first routing.

## 4. Deploy automatically from GitHub

Cloudflare [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) integrates directly with GitHub and can deploy on pushes:

1. Push this project to your GitHub repository. Include `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `wrangler.jsonc`, `drizzle/d1/`, and `cloudflare-assets/`. **Do not commit `.dev.vars`.**
2. In Cloudflare, open **Workers & Pages**, create/import a Worker from the Git repository, and select the branch to deploy.
3. Set the **Root directory** to the repository root, **Build command** to `pnpm run build:cloudflare`, and **Deploy command** to `pnpm exec wrangler deploy`. Wrangler reads the Worker name, static asset config, and D1 binding from `wrangler.jsonc`; it uses the version pinned by `package.json`/`pnpm-lock.yaml`.
4. Before the first production build, replace the D1 placeholder in `wrangler.jsonc` with the real database ID, and apply the remote migration. Configure the five runtime secrets in the Worker dashboard under **Settings → Variables & Secrets**.
5. Add the deployed site's root URL to Google Cloud's authorized redirect URIs and set the matching `GOOGLE_REDIRECT_URI` secret. Confirm the Google Drive API is enabled and the OAuth account is an allowed tester if consent is in Testing mode.
6. Keep branch preview deployments disabled until you have configured a **separate preview D1 database and preview secrets**; otherwise branch builds can write to production data.

For Cloudflare's current setup screens and build settings, see the official [Git integration guide](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/) and [build configuration reference](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

## Current boundaries

- The Cloudflare D1 database is separate from the existing WebDev MySQL database; no user, link, or Drive-token data is copied automatically.
- All logins still share the same Google Drive connection; files are not partitioned into per-user Drives.
- The UI caps uploads and downloads at 20 MiB per file. Test real Google Drive transfers and monitor Worker CPU limits after deployment.
- No GitHub repository was created or pushed, and no Cloudflare resource was created or deployed as part of this preparation. You control those account-level steps.
