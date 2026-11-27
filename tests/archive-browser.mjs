import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { articleSnapshots } from '../dist/import-document.js';

const url=new URL('https://publication.example/research/story');
const source=`<html lang="en"><head><title>Field report</title>
<link rel="stylesheet" href="/css/article.css"><script>document.title='Publisher script ran'</script></head>
<body class="publication"><nav>Publisher navigation only</nav><article><h1>Field report</h1><p>First observations appear in the field notes.</p>
<p>A <a href="#results">link to the results</a> and a <a href="/more">related article</a>.</p>
<h2 id="results">Results</h2><p>The resulting measurement is <em>consistent across samples</em> in this section.</p>
<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><defs><path id="dot" d="M0 0 5 5"/></defs>
<use href="#dot"/><use href="https://publication.example/external.svg#dot"/></svg>
<figure><img src="plot.png" alt="A plot"><figcaption>Measured values</figcaption></figure></article></body></html>`;
const css='@import "theme.css" screen; @font-face{font-family:Fixture;src:url("../fonts/fixture.woff2")} body.publication{font-family:Fixture,serif}';
const image=await sharp({create:{width:32,height:20,channels:3,background:'#285c50'}}).png().toBuffer();
const assets=new Map([
  ['/css/article.css',{body:Buffer.from(css),contentType:'text/css'}],
  ['/css/theme.css',{body:Buffer.from('h1{color:rgb(35,62,99)}'),contentType:'text/css'}],
  ['/fonts/fixture.woff2',{body:await readFile('node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2'),contentType:'font/woff2'}],
  ['/research/plot.png',{body:image,contentType:'image/png'}],
]);
async function verify(mode) {
  const snapshot=await articleSnapshots(source,url,async address=>{
    const asset=assets.get(address.pathname);
    return asset?{...asset,url:address}:null;
  },mode);
  if (mode==='reader') assert.equal(snapshot.archive,null);
  else assert.equal(snapshot.archive.missingAssets,0);

  const socket=createServer();
  socket.listen(0,'127.0.0.1');
  await once(socket,'listening');
  const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const service=spawn(process.execPath,['dist/server.js'],{stdio:['ignore','pipe','pipe'],
    env:{...process.env,ARTICLE_LAYOUT_MODE:mode,PORT:String(port),PUBLIC_ORIGIN:origin,SUPABASE_URL:origin,SUPABASE_PUBLISHABLE_KEY:'local-fixture'}});
  let browser;
  try {
    await Promise.race([once(service.stdout,'data'),once(service,'exit').then(()=>{throw Error('Local service exited during startup');}),
      new Promise((_,reject)=>setTimeout(()=>reject(Error('Service startup timed out')),10000).unref())]);
    const config=await (await fetch(origin+'/config.json')).json();
    assert.equal(config.articleMode,mode);
    const policy=(await fetch(origin+'/archive-frame')).headers.get('Content-Security-Policy');
    assert.match(policy,/script-src 'none'/);
    assert.match(policy,/sandbox allow-same-origin/);

    browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
    const page=await browser.newPage({viewport:{width:1440,height:960}});
    page.setDefaultTimeout(7000);
    const owner=randomUUID(),id=randomUUID(),version=randomUUID();
    const exp=Math.floor(Date.now()/1000)+3600;
    const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
    const token=b64({alg:'HS256',typ:'JWT'})+'.'+b64({sub:owner,exp,role:'authenticated',aud:'authenticated'})+'.fixture';
    const user={id:owner,aud:'authenticated',role:'authenticated',email:'reader@example.test',email_confirmed_at:new Date().toISOString(),
      app_metadata:{provider:'email'},user_metadata:{}};
    await page.addInitScript(session=>localStorage.setItem('sb-127-auth-token',JSON.stringify(session)),{
      access_token:token,refresh_token:'fixture',token_type:'bearer',expires_at:exp,expires_in:3600,user,
    });
    const storage=new Map(),threads=[],messages=[],outside=[],saved=[];
    let row;
    let imports=0,downloads=0;
    let deployedMode=mode;
    await page.routeWebSocket('**/realtime/v1/websocket*',()=>{});
    // Exercise the built Library and Supabase client against local API responses.
    await page.route('**/*',async route=>{
      const req=route.request(),address=new URL(req.url()),path=address.pathname;
      const json=(data,status=200)=>route.fulfill({status,json:data});
      if (address.origin!==origin) { outside.push(req.url());return route.abort(); }
      if (path==='/config.json' && deployedMode!==mode) return json({...config,articleMode:deployedMode});
      if (path==='/api/import') {
        imports++;
        assert.deepEqual(req.postDataJSON(),{url:url.href,mode});
        return json(snapshot);
      }
      if (path==='/auth/v1/user') return json(user);
      if (path.startsWith('/storage/v1/object/')) {
        const key=path.split('/web-comments/')[1];
        assert.match(key,new RegExp('^'+owner+'/archives/[a-f0-9]{64}\\.json$'));
        if (req.method()==='POST') {
          const form=await new Response(req.postDataBuffer(),{headers:{'content-type':req.headers()['content-type']}}).formData();
          const blob=Array.from(form.values()).find(value=>value instanceof Blob);
          assert.ok(blob);
          storage.set(key,await blob.text());
          return json({Key:key});
        }
        downloads++;
        if (!storage.has(key)) return json({code:'NoSuchKey',message:'Object not found',statusCode:'404'},404);
        return route.fulfill({contentType:'application/json',body:storage.get(key)});
      }
      if (path==='/rest/v1/rpc/wc_save_import') {
        const capture=req.postDataJSON();
        assert.equal(storage.has(owner+'/archives/'+capture.capture_fingerprint+'.json'),mode!=='reader');
        saved.push(capture);
        row={page_id:id,version_id:version,owner,imported_at:new Date().toISOString(),wc_pages:{source_url:url.href},
          wc_versions:{title:capture.document_title,kind:'html',complete:capture.is_complete,extraction_note:capture.note,
            fingerprint:capture.capture_fingerprint,content_hash:capture.document_hash,inline_text:capture.document_text,text_path:capture.snapshot_path,pdf_path:null},snapshot_html:capture.snapshot_html};
        return json({page_id:id,version_id:version});
      }
      if (path==='/rest/v1/rpc/wc_add_message') {
        const input=req.postDataJSON();
        assert.equal(input.version,version);
        const thread=randomUUID();
        threads.push({id:thread,version_id:version,anchor:input.selection,resolved:false});
        messages.push({id:input.message_id,thread_id:thread,body:input.message,role:'user',question:false});
        return json({thread_id:thread});
      }
      if (path==='/rest/v1/wc_library') return json(row?[row]:[]);
      if (path==='/rest/v1/wc_pages') return json(row?[{id,latest_version:version}]:[]);
      if (path==='/rest/v1/wc_threads') return json(threads);
      if (path==='/rest/v1/wc_messages') return json(messages);
      return route.continue();
    });

    await page.goto(origin+'/library');
    await page.getByLabel('Import a link').fill(url.href);
    await page.getByRole('button',{name:'Import',exact:true}).click();
    const comment=page.getByRole('button',{name:'Comment on selection'});
    await comment.waitFor();
    const framed=page.frameLocator('iframe[title="Saved article layout"]');
    const switcher=page.getByRole('group',{name:'Article view'});
    const reader=page.locator('.reader-content');
    if (mode==='both') {
      assert.equal(await page.getByRole('button',{name:'Reader',exact:true}).getAttribute('aria-pressed'),'true');
      await page.getByRole('button',{name:'Saved layout',exact:true}).click();
    } else assert.equal(await switcher.count(),0);
    const heading=framed.getByRole('heading',{name:'Field report'});
    if (mode!=='reader') {
      await heading.waitFor();
      assert.equal(await heading.evaluate(node=>getComputedStyle(node).color),'rgb(35, 62, 99)');
      const offline=await framed.locator('body').evaluate(async body=>{
        const doc=body.ownerDocument;
        await doc.fonts.ready;
        await doc.querySelector('img').decode();
        return {scripts:doc.querySelectorAll('script').length,title:doc.title,loaded:doc.querySelector('img').naturalWidth,
          glyphs:[...doc.querySelectorAll('svg use')].map(node=>node.getAttribute('href')),
          fonts:[...doc.fonts].filter(font=>font.family==='Fixture' && font.status==='loaded').length};
      });
      assert.deepEqual(offline,{scripts:0,title:'Field report',loaded:32,glyphs:['#dot'],fonts:1});
      await framed.getByRole('link',{name:'link to the results'}).click();
      assert.equal(await heading.evaluate(node=>node.ownerDocument.location.hash),'#results');
      assert.equal(await reader.count(),0);
    } else assert.equal(await page.locator('iframe').count(),0);
    const passage=mode==='archive'?'Publisher navigation only':'consistent across samples';
    const current=mode==='reader'?reader:framed;
    await current.getByText(passage,{exact:true}).evaluate(node=>{
      const range=node.ownerDocument.createRange();range.selectNodeContents(node);
      const selection=node.ownerDocument.getSelection();selection.removeAllRanges();selection.addRange(range);
    });
    await comment.click();
    await page.getByLabel('New comment').fill('Checked in the saved layout.');
    await page.getByRole('button',{name:'Post comment'}).click();
    await page.getByText('Checked in the saved layout.').waitFor();
    const anchor=threads[0].anchor;
    assert.equal(saved[0].document_text.includes('Publisher navigation only'),mode==='archive');
    assert.equal(saved[0].document_text.slice(anchor.start,anchor.end),passage);
    assert.equal(saved[0].capture_fingerprint,saved.at(-1).capture_fingerprint);
    assert.equal(storage.size,mode==='reader'?0:1);
    await page.reload();
    await comment.waitFor();
    async function checkHighlight(locator) {
      await page.getByRole('button',{name:passage}).click();
      assert.equal(await locator.evaluate(node=>[...node.ownerDocument.defaultView.CSS.highlights.get('web-comments')][0].toString()),passage);
    }
    await checkHighlight(mode==='reader'?reader:heading);
    if (mode!=='both') {
      assert.equal(await switcher.count(),0);
      assert.equal(await reader.count(),mode==='reader'?1:0);
      assert.equal(downloads,mode==='reader'?0:1);
      assert.deepEqual(outside,[]);
      return;
    }
    assert.equal(await page.getByRole('button',{name:'Saved layout',exact:true}).getAttribute('aria-pressed'),'true');
    await page.getByRole('button',{name:'Reader',exact:true}).click();
    await checkHighlight(reader);
    assert.equal(await page.locator('iframe').count(),0);
    // Flip the deployed setting on an already-saved dual-format document.
    // Each mode's actual server config is also exercised on a separate process.
    const storedFingerprint=row.wc_versions.fingerprint;
    const readsBefore=downloads;
    deployedMode='reader';
    await page.reload();
    await checkHighlight(reader);
    assert.equal(downloads,readsBefore);
    assert.equal(await switcher.count(),0);
    await reader.getByText(passage,{exact:true}).evaluate(node=>node.ownerDocument.getSelection().selectAllChildren(node));
    await comment.click();
    await page.getByRole('button',{name:'Cancel'}).click();
    assert.equal(saved.at(-1).capture_fingerprint,storedFingerprint);
    deployedMode='archive';
    await page.reload();
    await checkHighlight(heading);
    assert.equal(await reader.count(),0);
    assert.equal(await switcher.count(),0);
    deployedMode='both';
    // A mismatched or missing archive leaves the reader and pinned version usable.
    const [key,original]=[...storage][0];
    storage.set(key,JSON.stringify({...JSON.parse(original),html:'<html><body>Another article</body></html>'}));
    await page.reload();
    await page.getByText('The saved layout did not match this document version.').waitFor();
    assert.equal(await page.getByRole('button',{name:'Saved layout',exact:true}).count(),0);
    await checkHighlight(page.locator('.reader-content'));
    storage.delete(key);
    await page.reload();
    await page.getByText('The saved layout could not be loaded.',{exact:false}).waitFor();
    const before=saved.length;
    const other=page.locator('.reader-content').getByText('First observations appear in the field notes.');
    await other.evaluate(node=>{
      const selection=node.ownerDocument.getSelection();selection.selectAllChildren(node);
    });
    await comment.click();
    await page.getByLabel('New comment').fill('The original version still has its reader.');
    await page.getByRole('button',{name:'Post comment'}).click();
    await page.getByText('The original version still has its reader.').waitFor();
    assert.equal(saved.length,before);
    // A pre-archive version reopens without requesting any object from Storage.
    const priorDownloads=downloads;
    const digest=value=>createHash('sha256').update(value).digest('hex');
    const first=saved[0];
    deployedMode='archive';
    row.wc_versions.fingerprint=digest(JSON.stringify([first.document_hash,'html',first.is_complete,first.note,null,digest(first.snapshot_html)]));
    await page.reload();
    await comment.waitFor();
    assert.equal(await page.getByRole('button',{name:'Saved layout',exact:true}).count(),0);
    assert.equal(await page.locator('.archive-status').count(),0);
    assert.equal(downloads,priorDownloads);
    await checkHighlight(page.locator('.reader-content'));
    assert.equal(imports,1);
    assert.deepEqual(outside,[]);
  } finally {
    await browser?.close();
    service.kill();
  }
}

for (const mode of ['both','reader','archive']) {
  await verify(mode);
  console.log('Verified browser import, annotations and reopen with ARTICLE_LAYOUT_MODE='+mode);
}
