# Web Comments

Web Comments lets you save a webpage or PDF, annotate a passage, and keep the discussion beside the document. Use the web library in an ordinary browser or capture a page from the Chrome side panel. A connected ChatGPT app can review a saved document and write replies under its pending `@AI` questions.

| Start here | What you can do |
|---|---|
| [Web library](https://web-comments-rysl.onrender.com/library) | Import public URLs, reopen private snapshots, and annotate in the browser. |
| [Playground](https://web-comments-rysl.onrender.com/playground) | Try the shared panel with a sample webpage and PDF, or sign in to save real comments on the sample. |
| [Chrome download](https://web-comments-rysl.onrender.com/downloads/chrome-extension.zip) | Annotate the page you are currently viewing, including pages you can access in your signed-in browser. |

## Save a document and start a thread

1. Open the library and sign in with your Web Comments email and password. For a new account, enter the six-digit code from your confirmation email on the signup page.
2. Paste a public article or direct PDF URL into **Import a link** and click **Import**. Your saved documents appear on the left. For a new article, choose **Reader** or **Saved layout** above the document. The library remembers your choice in this browser. PDFs open with selectable text when the PDF contains a text layer.
3. Select a passage in the middle and click **Comment on selection** on the right. Write a comment and click **Post comment**. Click a thread’s quotation to jump to its passage. Use **Reply** to continue the discussion or **Resolve** to close the thread.
4. Use **Copy link** for the saved Web Comments page or **Copy ID** for its identifier. Both actions save the displayed document version. Page links and IDs require access to the account’s data.

To remove a source, right-click its entry under **Your documents**, touch and hold it on a phone, or choose **Remove** beside its title. Confirm **Remove source**. Importing the same URL again brings its comments back.

The library preserves readable HTML structure or a private copy of the PDF. With both layouts enabled, new HTML imports also offer **Saved layout** when the publisher’s markup, styles, fonts, and images can be bundled. Both views use the same discussion and saved passages. Open the original for video playback and interactive widgets. To add a saved layout to an older reader snapshot, import its URL again. Public import can fail when a site requires a browser login, loads the article with JavaScript, or restricts automated downloads. Use the original source link to refer back to the publisher.

## Try the playground

In **Try sample**, select a passage, post an `@AI` comment, and click **Preview replies** to see a sample answer. Try **Open as PDF** to exercise the PDF viewer. The sample clears on reload. **My account** uses your real account and saves annotations on the sample.

## Use the Chrome side panel

1. Download and extract the ZIP. In Chrome 120 or later, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the folder containing `manifest.json`.
2. Open Web Comments from the toolbar. Choose **Sign up** or **Sign in in browser**. The extension opens a regular browser tab that supports password-manager autofill. When sign-in completes, return to your original tab and open the panel.
3. Select text and use the same comment controls as the library. For a PDF, choose **Open as PDF**. The viewer supports fetching the source, opening a downloaded copy for that source URL, or loading the latest saved binary. Local PDFs opened directly from a file tab require **Allow access to file URLs**. The viewer’s file picker can open a downloaded copy.

Managed Chrome installations may block unpacked extensions. The web library works without extension permissions. To update an unpacked build, replace its files, click **Reload** in `chrome://extensions`, and refresh tabs that were already open.

## Ask ChatGPT to review a saved page

1. Post a comment containing `@AI`, for example `@AI How does this section connect to the conclusion?`. The panel marks it **Awaiting AI**.
2. Click **Copy link**. In a ChatGPT conversation with the Web Comments app enabled, paste the link. The MCP instructions treat a bare Web Comments link as a request to read the full saved document and discussion and reply to pending questions. Add a message to narrow the request. Clients that expose MCP prompts can choose **Review Web Comments**.
3. If ChatGPT asks to approve the write, approve it. The answer appears as **AI reply** beneath its question in the original thread.

ChatGPT requires the [OAuth setup](docs/setup.md#connect-chatgpt) and a client with permission to use custom MCP apps and write tools. Posting `@AI` marks a pending question. Sending the link in ChatGPT starts the review.

## Build and validate

Use Node.js 22 or later and npm.

```sh
npm ci --include=dev
npm run check
npm test
```

`npm test` builds the service, website, and extension before running the local tests. The tests require no hosted accounts. See the setup guide to run the sample playground, connect a development Supabase project, or configure a hosted deployment.

- [Setup and operations](docs/setup.md) covers local development, Supabase Auth and Storage, Render, ChatGPT, and smoke tests.
- [Architecture](docs/architecture.md) maps code entry points, snapshot storage, account boundaries, and MCP tool behavior.
- [Agent handoff](AGENTS.md) gives the first steps and verification checklist for the next agent working in this repo.

## Preview article imports locally

Generate standalone reader pages and a report using the Library's importer, browser sanitizer, and reader styles. The preview command needs no account or database.

```sh
npm run import:preview -- https://example.org/article https://example.org/another
npm run import:preview -- --archive --screenshot --browser /path/to/chromium --focus 'figure:has(img)' https://example.org/article
```

Open `dist/import-previews/index.html` for the pages, screenshots, and measurements. Choose a separate directory with `--out` to keep screenshots from earlier runs. Use `--archive` to compare the reader and saved layout for a live URL or a fixed capture. To replay offline, pass `--source captured.html --assets directory` with the original URL. Organize captured resources as `directory/hostname/path/to/file`. The older `--images directory` option also accepts a flat folder of same-site images.

Run `npm run test:archive` for the browser integration test. Set `CHROMIUM_PATH` to your Chromium executable when using a system installation. It starts the built library in all three deployment modes with local account and Storage fixtures, posts a passage comment, and checks the saved view and highlight after reopening.

For importer changes, keep a set of representative captures. Compare the report and screenshots for each change, and add a regression assertion when a specific structure is lost. The screenshot run checks that the browser decoded every embedded image and that each saved fragment points to a target.
