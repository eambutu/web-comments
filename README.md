# Web Comments

A Chrome side panel for annotating webpages and PDFs. Save a selection, include `@AI` in any message you want answered, and paste the copied link or ID into the ChatGPT conversation you want to use. ChatGPT reads the saved version and discussion through MCP, then writes replies under the individual questions.

## From installation to your first reply

Web Comments needs a Supabase project and a running Web Comments service. The Chrome extension uses the service address to find your Supabase project. ChatGPT connects to the same service over HTTPS.

1. Complete the Supabase and service setup below.
2. Download the Chrome extension and load it in Chrome. Choose **Sign up** in the side panel to create a private account with a username and password.
3. Connect the service as a custom OAuth app in ChatGPT using the verification steps below.
4. In Chrome, select text on a webpage, click **Comment on selection**, and post a question such as `@AI What is the main point of this paragraph?`
5. Click **Copy link**, paste it into a ChatGPT conversation with the app enabled, and ask ChatGPT to answer the pending questions. Look for its reply in the same Chrome thread.

## Try it in a browser

Open `/playground` on the service website. **Try sample** lets you select text, comment, and preview example replies without signing in. Sample threads clear on reload. **My account** uses the same private account and commenting tools as the Chrome extension. Save a question there and use **Copy link** to try the ChatGPT workflow without installing anything.

## Set up Supabase and deploy the service

1. Create a dedicated Supabase project. Apply the SQL files in `supabase/migrations/` in order through the Supabase SQL Editor or run `supabase db push --linked`. The migrations set up the database, private Storage, Realtime, and account access.
2. Deploy the `web-comments-enroll` Supabase Edge Function with `supabase functions deploy web-comments-enroll --no-verify-jwt`. It accepts registration and password sign-in before a user has a session. Supabase provides the Auth admin key inside the function. The hosted service uses the publishable key and the signed-in user's token for review access.
3. Deploy the service using Node.js 22 or later. Use `npm ci --include=dev && npm run build` to build and `npm start` to start. Fill in the settings shown in `.env.example`. Set `PUBLIC_ORIGIN` to the service's public HTTPS origin or use Render's `RENDER_EXTERNAL_URL`.

   ```sh
   npm ci --include=dev
   npm run build
   node --env-file=.env dist/server.js
   ```

4. Choose **Download Chrome extension** on the service website. Extract the ZIP. In Chrome 120 or later, open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**. Select the folder containing `manifest.json`. Open the Web Comments toolbar action and create an account from the side panel, or create it on the website and then sign in from Chrome. Reload tabs that were open before you loaded the extension.
5. To add ChatGPT, enable the **OAuth Server** in Supabase Auth. Set the Auth **Site URL** to the service's public HTTPS origin and the **Authorization Path** to `/oauth/consent`. Register a predefined OAuth client for ChatGPT using the redirect URI shown during ChatGPT app setup. Set the service's `MCP_OAUTH_CLIENT_ID` to that client's ID. A public client uses PKCE. If you register a confidential client, add its secret in the ChatGPT app configuration. Leave dynamic registration off. You can create an account and annotate pages before setting up ChatGPT.

Each account sees only its own saved pages, PDFs, and comments. Users with an existing email account can keep signing in with it. New username accounts use a password and have no email recovery. Save the credentials in your password manager.

The extension download uses `PUBLIC_ORIGIN` or Render’s `RENDER_EXTERNAL_URL` from build time as its default server. A build without either setting prompts for the address. **Change server** remains available from the sign-in screen.

For PDFs, choose **Open as PDF** in the panel and select text on one page. If the source requires authentication and the viewer cannot fetch it, download the PDF and choose **Open downloaded PDF** while the viewer is open for that source URL. For a local PDF, start from its Chrome tab. You can enable **Allow access to file URLs** in the extension details for direct loading, or use the file picker. **Open saved PDF** loads the latest saved binary for that source from private Storage.

## Verify ChatGPT access first

Create one disposable annotation with an `@AI` question. In ChatGPT, enable Developer mode if your account or workspace supports it. Create a custom app using `https://YOUR-MCP-HOST/mcp`, choose OAuth and predefined client credentials, and sign in on the consent page as the same Supabase user. Use the redirect URI and authentication method shown by the setup UI. See the [ChatGPT connection instructions](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt/) and [OAuth configuration](https://developers.openai.com/apps-sdk/build/auth/).

Select Web Comments in a conversation and paste a copied page link. The app treats a link sent by itself as a request to review the whole saved page and reply to its pending `@AI` questions. Add a message if you want to narrow the review. MCP clients that expose prompts can also select **Review Web Comments** and provide the link or page ID.

Verify that the app can call the three read tools and the write tool, and that the disposable reply appears beneath its question. If the app cannot be added or write calls cannot be approved, check your ChatGPT plan or workspace permissions for custom MCP apps and write tools.

Then repeat with two annotated documents. Reopen them and verify that the highlights and threads restore separately. Use a link for one and an ID for the other. Include an early question whose answer depends on a later section and an ordinary note in a different thread. Repeat the same review to check for duplicate replies, then add a new `@AI` follow-up and confirm it stays pending until a fresh review. Try an incomplete capture and confirm the app explains the gap and leaves its questions pending.

## How capture and review work

- Capture reads the current tab's rendered DOM or the PDF viewer's text layer. Clicking **Comment on selection** saves the version used for the anchor, and both **Copy** actions capture the document again. Identical captures reuse the latest version. Large text snapshots and PDFs are kept in private Supabase Storage.
- Embedded frames, canvas content, and detectable loading gaps are reported as incomplete. PDF pages with missing or malformed text are flagged. Scan-only PDFs need a text layer from OCR before review. The extension cannot reliably detect every site-specific omission, including offscreen virtualized content and text contained only in images.
- The MCP server freezes the version and discussion at resolution. Fetch both streams in order using their `next_cursor` until `complete` is true. The server records that the chunks were fetched. ChatGPT uses the tool instructions to synthesize across the fetched material.
- A reply is an immutable assistant message linked to its question and the reviewed version. A unique database constraint makes retries idempotent. A new question in the same thread has its own pending status.
- Sign-in and ownership are separate from the page reference. Use a dedicated Supabase project because its OAuth server issues user-scoped tokens for that Supabase project.

Run `npm run check` for TypeScript and `npm test` for the local account, migration, and review integration tests. Those tests run locally against PostgreSQL through PGlite. Account-level ChatGPT acceptance requires your deployed service and custom app connection.
