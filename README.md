# Web Comments

A personal Chrome side panel for annotating webpages and PDFs. Save a selection, include `@AI` in any message you want answered, and paste the copied link or ID into the ChatGPT conversation you want to use. ChatGPT reads the saved version and discussion through MCP, then writes replies under the individual questions.

## From installation to your first reply

Web Comments needs a Supabase project and a running Web Comments service. The Chrome extension uses the service address to find your Supabase project. ChatGPT connects to the same service over HTTPS.

1. Complete the Supabase and service setup below.
2. Install the Chrome extension, enter your service address in its side panel, and sign in.
3. Connect the service as a custom OAuth app in ChatGPT using the verification steps below.
4. In Chrome, select text on a webpage, click **Comment on selection**, and post a question such as `@AI What is the main point of this paragraph?`
5. Click **Copy link**, paste it into a ChatGPT conversation with the app enabled, and ask ChatGPT to answer the pending questions. Look for its reply in the same Chrome thread.

## Set up Supabase and deploy the service

1. Create a dedicated Supabase project. Apply the SQL in `supabase/migrations/` through the Supabase SQL Editor or use `supabase db push` with a linked project. The migration creates the tables, private Storage bucket, Realtime publication entries, and row-level policies.
2. Create and confirm your one email/password user in **Authentication → Users**. Turn off public sign-ups. Copy the user's ID for `OWNER_USER_ID`.
3. Enable the **OAuth Server** in Supabase Auth. Set the Auth **Site URL** to the service's public HTTPS origin and the **Authorization Path** to `/oauth/consent`. Register a predefined OAuth client for ChatGPT using the exact redirect URI shown during ChatGPT app setup. A public client uses PKCE and no client secret. If using a confidential client, enter its secret in ChatGPT, where the app is configured. The service accepts the single registered client ID. Leave dynamic registration off.
4. From the source directory, run the commands below using Node.js 22 or later. Copy `.env.example` to `.env` and fill in the settings. Use the database connection string from Supabase **Connect**, with SSL enabled. Keep the database credentials in the server environment. Deploy behind HTTPS at `PUBLIC_ORIGIN` and expose `/mcp` along with the discovery and consent routes. Most hosts can use `npm ci && npm run build` to build and `npm start` with host-managed environment variables.

   ```sh
   npm ci
   npm run build
   node --env-file=.env dist/server.js
   ```

5. In Chrome 120 or later, open `chrome://extensions`, turn on **Developer mode**, and click **Load unpacked**. Select the extracted extension directory or `dist/extension` from your build. Open the toolbar action, enter your service origin, and sign in. Reload tabs that were open before the extension was loaded.

For PDFs, choose **Open as PDF** in the panel and select text on one page. If the source requires authentication and the viewer cannot fetch it, download the PDF and choose **Open downloaded PDF** while the viewer is open for that source URL. For a local PDF, start from its Chrome tab. You can enable **Allow access to file URLs** in the extension details for direct loading, or use the file picker. **Open saved PDF** loads the latest saved binary for that source from private Storage.

## Verify ChatGPT access first

Create one disposable annotation with an `@AI` question. In ChatGPT, enable Developer mode if your account or workspace supports it. Create a custom app using `https://YOUR-MCP-HOST/mcp`, choose OAuth and predefined client credentials, and sign in on the consent page as the same Supabase user. Use the redirect URI and authentication method shown by the setup UI. See the [ChatGPT connection instructions](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt/) and [OAuth configuration](https://developers.openai.com/apps-sdk/build/auth/).

Select the app in a conversation and send a request such as:

> Review my Web Comments page at [copied link or ID]. Read all document and discussion chunks. Answer every pending @AI question in its thread. If anything is missing, tell me what I need to supply.

Verify that the app can call the three read tools and the write tool, and that the disposable reply appears beneath its question. If the app cannot be added or write calls cannot be approved, check your ChatGPT plan or workspace permissions for custom MCP apps and write tools.

Then repeat with two annotated documents. Reopen them and verify that the highlights and threads restore separately. Use a link for one and an ID for the other. Include an early question whose answer depends on a later section and an ordinary note in a different thread. Repeat the same review to check for duplicate replies, then add a new `@AI` follow-up and confirm it stays pending until a fresh review. Try an incomplete capture and confirm the app explains the gap and leaves its questions pending.

## How capture and review work

- Capture reads the current tab's rendered DOM or the PDF viewer's text layer. Clicking **Comment on selection** saves the version used for the anchor, and both **Copy** actions capture the document again. Identical captures reuse the latest version. Large text snapshots and PDFs are kept in private Supabase Storage.
- Embedded frames, canvas content, and detectable loading gaps are reported as incomplete. PDF pages with missing or malformed text are flagged. Scan-only PDFs need a text layer from OCR before review. The extension cannot reliably detect every site-specific omission, including offscreen virtualized content and text contained only in images.
- The MCP server freezes the version and discussion at resolution. Fetch both streams in order using their `next_cursor` until `complete` is true. The server records that the chunks were fetched. ChatGPT uses the tool instructions to synthesize across the fetched material.
- A reply is an immutable assistant message linked to its question and the reviewed version. A unique database constraint makes retries idempotent. A new question in the same thread has its own pending status.
- Sign-in and ownership are separate from the page reference. Use a dedicated Supabase project because its OAuth server issues user-scoped tokens for that Supabase project.

Run `npm run check` for TypeScript and `npm test` for the local migration and review integration tests. Those tests do not require a hosted Supabase project. Account-level ChatGPT acceptance requires your deployed service and custom app connection.
