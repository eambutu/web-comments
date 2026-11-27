# Working on Web Comments

## Start here

- Read the [README](README.md) for the user flows, the [setup guide](docs/setup.md) for service setup, and the [architecture guide](docs/architecture.md) for code and data boundaries.
- Verify the checkout and existing changes with `git status --short --branch`. The default branch of the shared [GitHub repository](https://github.com/eambutu/web-comments) is `main`.
- Use Node.js 22 or later. Run `npm ci --include=dev`, `npm run check`, and `npm test` from the repo root. Both checks run without live service credentials. `npm test` rebuilds `dist` before executing its fixtures.
- Start with the [sample-only setup](docs/setup.md#quick-start-without-supabase) for reader and panel UI. Use a local or separate development Supabase project for accounts, library imports, Storage, and RLS. For hosted work, verify which project and Render service are authorized targets.

## Find the right code

| Area | Entry points |
|---|---|
| Library and imports | [Web library](src/library.tsx), [library data access](src/library-data.ts), [importer](server/import-document.ts) |
| Shared commenting | [Document panel](src/document-panel.tsx), [side panel](src/side-panel.tsx), [comment store](src/comment-store.ts) |
| Capture and anchors | [HTML extraction](src/html-document.ts), [PDF rendering and text](src/pdf-document.ts), [models](src/model.ts) |
| Signup and extension handoff | [Account form](src/account-form.tsx), [browser auth helpers](src/client.ts), [web routes](src/web.ts), [extension service worker](src/background.ts) |
| MCP review | [HTTP and token checks](server/index.ts), [tools and prompt](server/review.ts), [review RPCs](supabase/migrations/20261126174114_web_comments_private_accounts.sql) |
| Builds and database changes | [Build entry points](build.mjs), [migrations](supabase/migrations/), [tests](tests/) |

## Preserve the existing behavior

- Keep the library, playground, and Chrome extension on the shared panel and capture code where their behavior is the same. The playground’s sample mode uses in-memory comments and sample replies.
- Keep reads and writes scoped to the authenticated account. The public browser config deliberately contains a publishable key. Keep user tokens, service-role keys, SMTP credentials, and test inbox content out of commits, command output, and screenshots.
- Preserve import limits, redirect and network-address validation, DNS pinning, and HTML sanitization. Test safety changes against local fixtures and approved public URLs.
- Add a forward migration for schema changes and test it in PostgreSQL. [The integration suite](tests/review.test.mjs) explicitly lists migration files in order, so add new migrations there when extending that suite.
- Keep MCP reads tied to a fixed document and discussion snapshot. Reply writes depend on reading both complete streams and use the original question ID for idempotency.

## Hand off with evidence

- Match the checks to the change. The [verification checklist](docs/setup.md#verification-checklist) separates local tests, real Auth email, Chrome installation, and live ChatGPT acceptance.
- For live work, confirm which commit is running before reporting deployment success. Let the user know what you tested with real services and what used fixtures. Verify email delivery and ChatGPT OAuth with their own end-to-end checks.
- The hosted library and playground are on the [Web Comments service](https://web-comments-rysl.onrender.com). [`/config.json`](https://web-comments-rysl.onrender.com/config.json) reports whether an MCP client ID is configured. The connector or CLI access available to a previous agent may differ from your session. Identify unavailable admin access and give the exact outstanding dashboard action.
