import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import sharp from 'sharp';
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

test('article snapshots preserve links, figures, and explicit line breaks without executing publisher markup',async () => {
  const requests=[];
  const bytes=await sharp({create:{width:3,height:2,channels:3,background:'red'}}).png().toBuffer();
  const article=await cleanArticle(`<!doctype html><html><head><title>A useful article</title>
    <base href="/articles/"><style>.lines {white-space: pre-line} .lines .name {display:block}</style></head>
    <body><script>doNotInclude()</script><main>
    <h1>The complete article begins here</h1><p>A short opening paragraph<br>sets the context.</p>
    <h2 id="methods" onclick="doNotInclude()">A section heading</h2>
    <p>Some readable prose with a <a href="notes">reference</a>, a <a href="#methods">section link</a>
    and an <a href="javascript:doNotInclude()">unsafe link</a>.</p>
    <div class="lines" style="color:purple"><span class="name">First</span>
Second</div>
    <ol start="3" reversed><li value="5">Example<ul><li>A nested item</li></ul></li></ol>
    <figure><img src="image.png" onerror="doNotInclude()" alt="An illustration"><figcaption>Notes on the illustration</figcaption></figure>
    <iframe src="https://example.org/embed"></iframe>
    </main></body></html>`,new URL('https://example.org/page/test'),async url=>{
    requests.push(url.href);
    return bytes;
  });
  const {document}=parseHTML(article.html);
  assert.equal(article.title,'The complete article begins here');
  assert.equal(document.querySelector('p br').outerHTML,'<br>');
  assert.equal(document.querySelector('h2').textContent,'A section heading');
  assert.equal(document.querySelector('a[href^="#"]').getAttribute('href'),'#'+document.querySelector('h2').id);
  assert.equal(document.querySelector('a[target="_blank"]').getAttribute('href'),'https://example.org/articles/notes');
  assert.equal(document.querySelector('.snapshot-space-pre-line .snapshot-block').textContent,'First');
  assert.equal(document.querySelector('ol[reversed] > li > ul li').textContent,'A nested item');
  assert.equal(document.querySelector('ol').getAttribute('start'),'3');
  assert.equal(document.querySelector('ol > li').getAttribute('value'),'5');
  assert.deepEqual(requests,['https://example.org/articles/image.png']);
  assert.equal(document.querySelector('img').getAttribute('alt'),'An illustration');
  assert.match(document.querySelector('img').getAttribute('src'),/^data:image\/webp;base64,/);
  assert.equal(document.querySelector('figcaption').textContent,'Notes on the illustration');
  assert.equal(article.complete,false);
  assert.doesNotMatch(article.html,/script|onclick|onerror|javascript:|<iframe|style=|image\.png/);
});

test('conventional article containers keep the title and use alt text when an image is unavailable',async () => {
  const url=new URL('https://example.org/post');
  const html=`<html><head><title>Publisher title</title></head><body>
    <div class="menu"><p>Site navigation</p></div>
    <div class="post"><h1>Original heading</h1><div>Article author</div>
    <p>Opening paragraph with prose.</p><p>A second interesting paragraph.</p><p>A third paragraph with an image.</p>
    <figure><img src="missing.png" alt="Missing diagram"><figcaption>Diagram notes</figcaption></figure></div>
    </body></html>`;
  const article=await cleanArticle(html,url,async()=>null);
  assert.equal(article.title,'Original heading');
  assert.match(article.html,/<h1>Original heading<\/h1><div>Article author<\/div>/);
  assert.match(article.html,/<em>Missing diagram<\/em><figcaption>Diagram notes<\/figcaption>/);
  assert.doesNotMatch(article.html,/Site navigation|<img/);
  assert.match(article.note,/images could not be saved/);
});
