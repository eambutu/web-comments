import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanArticle, importDocument, importUrl, isPublicAddress } from '../dist/import-document.js';

test('document imports accept public addresses and reject non-public connections',async () => {
  assert.equal(importUrl('https://example.org/read#paragraph').href,'https://example.org/read');
  for (const url of ['file:///a.pdf','https://name:pass@example.org','https://example.org:9443']) {
    assert.throws(()=>importUrl(url),/public/);
  }
  for (const address of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::2']) {
    assert.equal(isPublicAddress(address),false,address);
  }
  assert.equal(isPublicAddress('8.8.4.4'),true);
  await assert.rejects(importDocument('http://127.0.0.1'),/unavailable for public imports/);
});

test('article snapshots preserve readable HTML and omit executable or remote content',() => {
  const article=cleanArticle(`<!doctype html><html><head><title>A useful article</title></head>
    <body><script>doNotInclude()</script><main>
    <h1>The complete article begins here</h1><p>A short opening paragraph sets the context.</p>
    <h2 onclick="doNotInclude()">A section heading</h2>
    <p>Some readable prose with a <a href="/notes">reference</a> and <a href="javascript:doNotInclude()">unsafe link</a>.</p>
    <figure><img src="https://example.org/track" alt="An illustration"><figcaption>Notes on the illustration</figcaption></figure>
    <iframe src="https://example.org/embed"></iframe>
    </main></body></html>`,new URL('https://example.org/articles/test'));
  assert.match(article.html,/<p>A short opening paragraph sets the context\.<\/p>/);
  assert.match(article.html,/<h2>A section heading<\/h2>/);
  assert.match(article.html,/href="https:\/\/example.org\/notes"/);
  assert.match(article.html,/An illustration/);
  assert.doesNotMatch(article.html,/script|onclick|javascript:|<img|\/track|<iframe/);
});
