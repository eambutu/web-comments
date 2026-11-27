# Setup and operations

Use Node.js 22 or later with npm. For full local development, also install the Supabase CLI and start Docker. Use a separate development Supabase project if Docker is unavailable.

From a fresh machine, clone the repository and run the commands below in its root.

```sh
git clone https://github.com/eambutu/web-comments.git
cd web-comments
```

## Quick start without Supabase

The test suite uses PGlite and local fixtures. The sample playground can also run without a database. Its accounts and import flows require Supabase.

```sh
npm ci --include=dev
npm run check
npm test

PUBLIC_ORIGIN=http://localhost:8787 npm run build
PUBLIC_ORIGIN=http://localhost:8787 SUPABASE_URL=http://127.0.0.1:54321 \
  SUPABASE_PUBLISHABLE_KEY=sample-only npm start
```

Open `http://localhost:8787/playground` and choose **Try sample**. In this mode a database-backed `/healthz` check can return `503`. Use `/playground` as the sample smoke check.

## Run the full app locally

1. From the repo root, run `supabase init` to generate `supabase/config.toml` if it does not exist. The repo tracks SQL migrations and the signup template. Keep machine-specific CLI configuration and local credentials out of commits.
2. In the generated configuration, enable email signup and confirmation, set the code length to six, and point the confirmation template at the file in this repo. Update the existing sections instead of adding a second copy.

   ```toml
   [auth.email]
   enable_signup = true
   enable_confirmations = true
   otp_length = 6

   [auth.email.template.confirmation]
   subject = "Confirm your Web Comments account"
   content_path = "./supabase/templates/confirm-signup.html"
   ```

3. Start Supabase and apply migrations in order. Use the local API URL, public key, and mail inbox shown by the CLI. The local mail inbox is commonly on port `54324`.

   ```sh
   supabase start
   supabase migration up --local
   supabase status
   ```

4. Copy `.env.example` to `.env`. Set `SUPABASE_URL` to the local API URL, `SUPABASE_PUBLISHABLE_KEY` to the local publishable key or legacy anon key, and `PUBLIC_ORIGIN` to `http://localhost:8787`. Leave `MCP_OAUTH_CLIENT_ID` empty for browser and extension work. Open the app at the exact origin you configured.

   ```sh
   cp .env.example .env
   # Edit .env before running these commands.
   node --env-file=.env build.mjs
   node --env-file=.env dist/server.js
   ```

5. Open `http://localhost:8787/signup`, create a disposable account, and enter the code from the local inbox. Check `/healthz` for `{"ok":true}` and open `/library`. For extension testing, load `dist/extension` through `chrome://extensions`.

For a remote development project, use its API URL and publishable key in the same `.env` file. If you use `supabase link` and `supabase db push --linked`, verify the linked project before pushing. Use the Supabase dashboard for the hosted Auth settings. [Supabase local development guide](https://supabase.com/docs/guides/local-development) · [Local email templates](https://supabase.com/docs/guides/local-development/customizing-email-templates)

## Environment variables

| Variable | Where it is used | Value |
|---|---|---|
| `SUPABASE_URL` | Server startup | The Supabase API origin. This is the project’s HTTP API URL. |
| `SUPABASE_PUBLISHABLE_KEY` | Server startup and browser clients | The public publishable key or legacy anon key. `/config.json` exposes this value by design. |
| `PUBLIC_ORIGIN` | Build and server startup | The exact origin where users open Web Comments. Production uses HTTPS. Local development can use HTTP on `localhost` or `127.0.0.1`. |
| `RENDER_EXTERNAL_URL` | Build and server startup | Render supplies this automatically. The app uses it when `PUBLIC_ORIGIN` is empty. |
| `PORT` | Server startup | The listening port. Defaults to `8787`. Render supplies its own value. |
| `MCP_OAUTH_CLIENT_ID` | Server startup | The registered Supabase OAuth client ID for the ChatGPT app. Required for live MCP access. |

The build embeds the app origin into the extension. A build without an origin asks for the server address on first launch. If Chrome saved a previous server, choose **Change server** from the extension’s signed-out screen. `npm start` runs the existing build and expects environment variables from its caller. Use the `node --env-file` commands above when storing values in `.env`.

Builds produce `dist/server.js`, browser assets under `dist/web`, and an unpacked extension under `dist/extension`. The build also creates the ZIP served at `/downloads/chrome-extension.zip`. Rebuild after changing the public origin or frontend files. Restart the server after changing runtime configuration.

## Set up a hosted Supabase project

1. Choose a dedicated project. Apply every file in [`supabase/migrations/`](../supabase/migrations/) in order. A linked CLI project tracks applied versions. If using the SQL Editor, record which versions were applied before later adopting CLI-based migration management.
2. Confirm the migrations created the private `web-comments` bucket and Realtime publication entries for the page, thread, and message tables. The application uses row-level security and authenticated RPCs for account-scoped access.
3. Enable email and password signup with email confirmation. In **Authentication → Email Templates → Confirm signup**, paste the [signup template](../supabase/templates/confirm-signup.html), which uses `{{ .Token }}`. Use **Confirm your Web Comments account** as the subject. A user enters the code on the signup page, so this flow does not need a redirect entry.
4. Configure a sender for your audience and verify an actual confirmation email in an approved test inbox. Supabase’s built-in sender limits delivery to project team addresses. Configure custom SMTP for public signup. The test suite can pass before email delivery is ready.

The API server and browser clients use the publishable key and the signed-in user’s session. Keep service-role and SMTP credentials in the service that needs them. The current email flow does not require the legacy username Edge Function. Older builds that still sign in with a username depend on [that function](../supabase/functions/web-comments-enroll/index.ts) and `POST /auth/username-login`. [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates) · [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)

## Deploy the web service

The shared installation uses the `main` branch of [eambutu/web-comments](https://github.com/eambutu/web-comments), the [Web Comments Render service](https://dashboard.render.com/web/srv-dc3miht6e07s73cu5l3g), and the [Web Comments Supabase project](https://supabase.com/dashboard/project/zjkscalnknxzwtrnlaya). Verify the active account, service, and target branch before working on a hosted deployment.

- Use a Render Node web service running Node.js 22 or later. Build with `npm ci --include=dev && npm run build` and start with `npm start`.
- Set the Supabase variables and use Render’s external URL or set `PUBLIC_ORIGIN` explicitly. For a change that adds a required table or RPC, apply the reviewed migration before releasing code that uses it.
- For a runtime release, check which commit Render is building. The public-repo setup has needed a manual **Deploy latest commit** after a push. Wait for the selected commit to become live before verifying the app. A documentation-only push needs no manual runtime release.
- Check `/healthz`, `/library`, and `/playground` after deployment. For extension changes, also download the ZIP and inspect its manifest. `/healthz` verifies that the public database health RPC answers. Verify email delivery, Storage uploads, and ChatGPT separately.

## Connect ChatGPT

The browser library and extension work without an MCP connection. On the hosted app, check the `clientId` in [`/config.json`](https://web-comments-rysl.onrender.com/config.json) for the current configuration. A null value means the server will return `503` on `/mcp`.

1. In Supabase Auth, enable the **OAuth Server**, set the **Site URL** to the app’s public HTTPS origin, and set the **Authorization Path** to `/oauth/consent`. These settings are for the OAuth flow.
2. Start creating a custom OAuth app in the ChatGPT workspace that will use it. Copy the exact redirect URI shown in the setup UI. Register a predefined OAuth client in Supabase with that URI. Use the client type the ChatGPT setup expects. A public client uses PKCE. Store a confidential client’s secret in the ChatGPT app configuration.
3. Set `MCP_OAUTH_CLIENT_ID` on the web service to the registered client’s ID and deploy the settings. Point the ChatGPT app at `https://YOUR-APP-ORIGIN/mcp`. The implementation expects the configured client ID. Dynamic client registration is outside this setup.
4. Sign in on the consent screen with the same Web Comments account that owns the test page. Enable the app in a conversation, paste a saved link with an `@AI` question, and approve the write if prompted. Verify the answer appears beneath its own question. ChatGPT access depends on the plan and workspace settings for custom MCP apps and write tools.

[Connect an app in ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt/) · [OAuth for custom apps](https://developers.openai.com/apps-sdk/build/auth/)

## Verification checklist

| Area | What to verify |
|---|---|
| Local checks | `npm run check` and `npm test` pass. The tests run without hosted credentials and cover page isolation, imports, review snapshots, and extension sign-in handoff. |
| Playground | Select sample text, post a note and an `@AI` question, preview a reply, and switch to the PDF. Reload to verify sample-only data clears. |
| Signup | A real test email contains six digits. Verify the code, then sign in again with the same email and password. Use an authorized test inbox. |
| Library | Import an article and a PDF, annotate a passage, switch between documents, and reload. Verify the same thread and highlight return. A second account should see its own library. |
| Extension | In a Chrome profile that permits unpacked extensions, load `dist/extension`, sign in through the ordinary browser tab, and capture both HTML and PDF selections. Use the playground for shared-UI checks when installation is blocked. |
| ChatGPT | Use a disposable question in a configured app. Confirm the full document and discussion are read, one answer appears under the question, retries preserve that answer, and incomplete snapshots leave questions pending. |

### Troubleshooting

| Symptom | Where to check |
|---|---|
| npm cache is unwritable | Use a writable cache, for example `npm --cache /tmp/web-comments-npm-cache ci --include=dev`. |
| Invalid server configuration | The browser address and `origin` in `/config.json` must match, including the scheme and port. A saved Chrome server can override the build default. |
| `/healthz` returns `503` | Check the project URL, publishable key, and migration that provides `wc_public_health`. Check the database API is reachable from the running server. |
| Email arrives with a link instead of a code | Check **Confirm signup** is using the repo template and test the most recent email. Email delivery and rate limits are controlled by Supabase. |
| Import fails for a public-looking link | Check for a document-level login wall, anti-automation response, redirects, size limits, or a source that requires JavaScript to render. Use a direct public article or PDF URL. |
| Highlight cannot be matched | Check that the visible text still contains the saved passage. PDF anchors are also tied to the original binary’s hash. |
| ChatGPT returns `503` or `401` | A `503` indicates the configured client ID is missing. A `401` indicates the bearer token failed access checks. Verify the registered client, token issuer, consent, and signed-in owner. |
