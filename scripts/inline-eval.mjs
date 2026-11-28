import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify, parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { evalBackend } from '../tests/inline-backend.mjs';

const {values}=parseArgs({options:{sites:{type:'string',default:'tests/inline-sites.json'},
  out:{type:'string',default:'dist/inline-evals'},cache:{type:'string',default:'.cache/inline-evals'},
  browser:{type:'string'},offline:{type:'boolean',default:false},live:{type:'boolean',default:false}}});
assert.ok(!(values.live && values.offline),'Choose either live pages or an offline replay');
const out=resolve(values.out),cache=resolve(values.cache);
await Promise.all([mkdir(out,{recursive:true}),mkdir(cache,{recursive:true})]);
const cases=JSON.parse(await readFile(values.sites,'utf8'));
const resources=new Map();
const run=promisify(execFile);
for (const item of values.live?[]:cases) {
  for (const [index,path] of item.resources.entries()) {
    const url=new URL(path,item.revision).href;
    const file=join(cache,createHash('sha256').update(url).digest('hex'));
    let body;
    try {body=await readFile(file);} catch (error) {
      if (error.code!=='ENOENT') throw error;
      if (values.offline) throw Error('Missing cached resource '+url);
      const {stdout}=await run('curl',['--fail','--silent','--show-error','--location','--max-time','45',url],{encoding:'buffer',maxBuffer:12*1024*1024});
      body=stdout;await writeFile(file,body);
    }
    const contentType=index===0?'text/html; charset=utf-8':path.endsWith('.css')?'text/css':path.endsWith('.png')?'image/png':'image/jpeg';
    resources.set(index===0?item.url:new URL('/'+path,item.url).href,{body,contentType});
  }
}
const stress={name:'Nested scroll and repeated text',url:'https://inline-eval.example.test/article',
  selector:'#target',quote:'the same passage',stress:true,comment:'This comment belongs to the second occurrence.',
  reply:'Check it again after the page reflows.'};
resources.set(stress.url,{contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><title>Nested scroll evaluation</title>
<style>body{font:18px/1.6 system-ui;margin:40px}main{max-width:620px}#scroller{overflow:auto;height:235px;border:1px solid #aaa;padding:15px}
p{margin:32px 0}button{background:orange!important} .space{height:260px}</style><main><h1>Reading notes</h1>
<div id="scroller"><p>First example includes the same passage before a different result.</p><div class="space"></div>
<p id="target">Second example includes <em>the same passage</em> beside the intended result.</p><div class="space"></div></div>
<p contenteditable="true" id="editable">Editable sample</p><a href="#editable">Jump to editable sample</a></main>`});
cases.push(stress);
const backend=await evalBackend();
const profile=await mkdtemp(join(tmpdir(),'web-comments-inline-'));
const ext=resolve('dist/extension');
const report=[];
let context;
function escape(value) { return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
try {
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,
    executablePath:values.browser??process.env.CHROMIUM_PATH,viewport:{width:1360,height:850},ignoreDefaultArgs:['--disable-extensions'],
    args:['--headless=new','--disable-extensions-except='+ext,'--load-extension='+ext]});
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');
  const setup=await context.newPage();
  await setup.goto(new URL('inline.html',worker.url()).href);
  await setup.evaluate(({api,key,session})=>chrome.storage.local.set({wcConfig:{origin:api,supabaseUrl:api,publishableKey:key,clientId:null},
    ['sb-'+new URL(api).hostname.split('.')[0]+'-auth-token']:JSON.stringify(session)}),
    {api:backend.api,key:backend.key,session:backend.session});
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if (url.origin===backend.api || url.protocol==='chrome-extension:') return route.continue();
    // Replay the document and pinned layout assets. Publisher scripts, trackers,
    // videos and other unlisted subresources never run during this evaluation.
    const match=resources.get(url.href);
    if (!match) return values.live?route.continue():route.abort();
    const headers=match.contentType.startsWith('text/html')?{'Content-Security-Policy':"script-src 'none'; object-src 'none'"}:{};
    return route.fulfill({...match,headers});
  });
  for (const [index,item] of cases.entries()) {
    const page=await context.newPage();
    page.on('pageerror',error=>console.error('Page error',error.message));
    page.setDefaultTimeout(9000);
    const cdp=await context.newCDPSession(page);
    const result={name:item.name,url:item.url,mode:item.stress?'controlled':values.live?'live':'pinned',checks:[],screenshots:[]};
    report.push(result);
    try {
      await evaluatePage(page,cdp,setup,item,result,index);
      console.log('PASS '+item.name+' ('+result.checks.join(', ')+')');
    } catch (error) {
      result.error=String(error);
      await page.screenshot({path:join(out,'failure-'+index+'.png')}).catch(()=>{});
      throw error;
    } finally {await page.close();}
  }
} finally {
  await context?.close();await backend.close();await rm(profile,{recursive:true,force:true});
  await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  const entries=report.map(r=>'<section><h2>'+escape(r.name)+'</h2><p>'+escape(r.error??r.checks.join(' · '))+'</p>'+
    r.screenshots.map(f=>'<a href="'+f+'"><img alt="'+escape(r.name)+'" src="'+f+'"></a>').join('')+'</section>').join('');
  await writeFile(join(out,'index.html'),'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>In-page comment evaluations</title><style>body{max-width:1100px;margin:2rem auto;padding:0 1rem;font:16px system-ui;color:#203c35}section{margin:2rem 0}img{max-width:100%;max-height:620px;border:1px solid #afc4ba;margin-right:1rem}</style><h1>In-page comment evaluations</h1>'+entries);
}

async function selectQuote(page,selector,quote) {
  const element=page.locator(selector).filter({hasText:quote}).first();
  await element.evaluate((node,quote)=>{
    node.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
    if (!node.closest('#scroller')) window.scrollBy({top:window.innerHeight*.15,behavior:'instant'});
    const start=node.textContent.indexOf(quote);
    if (start<0) throw Error('The selection text changed');
    const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);
    const range=document.createRange();
    let offset=0;
    for (let text=walker.nextNode();text;text=walker.nextNode()) {
      const end=offset+text.length;
      if (start>=offset && start<end) range.setStart(text,start-offset);
      if (start+quote.length>offset && start+quote.length<=end) {range.setEnd(text,start+quote.length-offset);break;}
      offset=end;
    }
    const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);
  },quote);
}

// The outer page moves and sizes the iframe after its contents change. Chromium's
// actionability check in a child frame only waits for the button in that frame.
async function clickInCard(frame,name) {
  const button=frame.getByRole('button',{name,exact:true});
  await button.waitFor();
  const element=await frame.frameElement();
  let previous='',stable=0;
  for (let i=0;i<25 && stable<3;i++) {
    const next=JSON.stringify(await element.boundingBox());
    stable=next===previous?stable+1:0;previous=next;
    await new Promise(resolve=>setTimeout(resolve,32));
  }
  await button.click();
}

// Use Chromium's DOM inspection to operate actual buttons inside the closed
// extension shadow root. The publisher's JavaScript has no access to these nodes.
async function control(cdp,selector) {
  const doc=await cdp.send('DOM.getDocument');
  const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'[data-web-comments-overlay]'});
  assert.ok(nodeId,'Overlay should be mounted');
  const {node}=await cdp.send('DOM.describeNode',{nodeId,depth:1,pierce:true});
  const {nodeIds}=await cdp.send('DOM.pushNodesByBackendIdsToFrontend',{backendNodeIds:[node.shadowRoots[0].backendNodeId]});
  const button=await cdp.send('DOM.querySelector',{nodeId:nodeIds[0],selector});
  if (!button.nodeId) return null;
  const box=await cdp.send('DOM.getBoxModel',{nodeId:button.nodeId}).catch(()=>null);
  if (!box) return null;
  const [x,y,, ,right,bottom]=box.model.border;
  return {x:(x+right)/2,y:(y+bottom)/2};
}

async function evaluatePage(page,cdp,setup,item,result,index) {
  await page.goto(item.url,{waitUntil:'domcontentloaded'});
  // Restore a tab explicitly enabled by the user. This uses the normal worker
  // and document startup path without automating browser-chrome context menus.
  await setup.evaluate(async url=>{
    const tab=(await chrome.tabs.query({url}))[0];
    if (!tab?.id) throw Error('Missing eval tab');
    await chrome.storage.session.set({['wc-inline-tab:'+tab.id]:new URL(url).origin});
  },page.url());
  await page.reload({waitUntil:'domcontentloaded'});
  const frame=()=>page.frames().find(f=>f.url().startsWith('chrome-extension:') && f.url().includes('/inline.html#'));
  await page.waitForSelector('[data-web-comments-overlay]',{state:'attached'});
  const card=frame()??await page.waitForEvent('framenavigated',{predicate:f=>f.url().includes('/inline.html#')});
  await card.getByText('Select a passage and choose',{exact:false}).waitFor();
  await clickInCard(card,'Close conversation');
  async function click(selector) {
    let point;
    for (let i=0;i<35 && !point;i++) {
      point=await control(cdp,selector);
      if (!point) await new Promise(resolve=>setTimeout(resolve,80));
    }
    assert.ok(point,'Expected visible '+selector);await page.mouse.click(point.x,point.y);
  }
  await selectQuote(page,item.selector,item.quote);
  await click('.add');
  const editor=card.getByRole('textbox',{name:'New comment'});
  await editor.waitFor();
  assert.equal(await card.locator('blockquote').textContent(),item.quote);
  const body=item.comment??'Evaluation note for '+item.name;
  const reply=item.reply??'Follow-up on this passage.';
  await editor.fill(body);
  await clickInCard(card,'Post comment');
  await card.locator('.message').getByText(body,{exact:true}).waitFor();
  await card.getByLabel('Reply',{exact:true}).fill(reply);
  await clickInCard(card,'Post reply');
  await card.locator('.message').getByText(reply,{exact:true}).waitFor();
  assert.equal(await card.getByLabel('Reply',{exact:true}).inputValue(),'');
  result.checks.push('select, post and reply');
  await page.waitForFunction(quote=>[...(CSS.highlights.get('web-comments-inline')??[])].some(r=>r.toString()===quote),item.quote);
  assert.equal(await page.locator('body').innerText().then(s=>s.includes(body)),false);
  const frameBounds=await (await card.frameElement()).boundingBox();
  const passage=await page.evaluate(()=>[...CSS.highlights.get('web-comments-inline')][0].getBoundingClientRect().toJSON());
  assert.ok(frameBounds && frameBounds.width<=322 && frameBounds.height<800);
  assert.ok(Math.abs(frameBounds.y-passage.y)<frameBounds.height+80,'Conversation should be near its passage');
  result.checks.push('anchored card and highlight');
  const screenshot=async suffix=>{
    const file=String(index+1)+'-'+suffix+'.png';
    await page.screenshot({path:join(out,file)});result.screenshots.push(file);
  };
  await screenshot('desktop');
  await page.setViewportSize({width:390,height:780});
  await page.waitForFunction(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(()=>ok(true)))));
  const narrow=await (await card.frameElement()).boundingBox();
  assert.ok(narrow && narrow.x>=0 && narrow.x+narrow.width<=390 && narrow.y>=0 && narrow.y+narrow.height<=780);
  await screenshot('narrow');result.checks.push('narrow viewport');
  await page.setViewportSize({width:1360,height:850});
  await page.reload();
  const reopened=page.frame({url:/chrome-extension:.*\/inline.html/})??await page.waitForEvent('framenavigated',{predicate:f=>f.url().includes('/inline.html#')});
  await clickInCard(reopened,'Close conversation');
  await selectQuote(page,item.selector,item.quote);
  await page.evaluate(()=>document.getSelection().removeAllRanges());
  await click('.marker');
  await reopened.getByText(body,{exact:true}).waitFor();
  await clickInCard(reopened,'Close conversation');
  const point=await page.evaluate(()=>{
    const range=[...CSS.highlights.get('web-comments-inline')][0];
    for (const rect of range.getClientRects()) {
      const y=rect.top+rect.height/2;
      for (let x=rect.left+2;x<rect.right;x+=8) {
        const element=document.elementFromPoint(x,y);
        if (element && !element.closest('a,button,[data-web-comments-overlay]')) return {x,y};
      }
    }
  });
  assert.ok(point,'The quote should have visible clickable text');
  await page.mouse.click(point.x,point.y);
  await reopened.getByText(body,{exact:true}).waitFor();
  result.checks.push('reload, open from marker and from highlighted text');
  if (item.stress) {
    await clickInCard(reopened,'Close conversation');
    await page.evaluate(()=>{
      const target=document.querySelector('#target');
      target.innerHTML='Second example includes <b>the  same passage</b> beside the intended result.';
    });
    await page.waitForFunction(()=>[...(CSS.highlights.get('web-comments-inline')??[])].some(r=>r.startContainer.parentElement.closest('#target')));
    await page.locator('#scroller').evaluate(node=>{node.scrollTop=0;});
    await page.waitForFunction(()=>document.querySelector('#target').getBoundingClientRect().top>document.querySelector('#scroller').getBoundingClientRect().bottom);
    await new Promise(resolve=>setTimeout(resolve,160));
    assert.equal(await control(cdp,'.marker'),null);
    await page.locator('#target').scrollIntoViewIfNeeded();
    await click('.marker');await reopened.getByText(body,{exact:true}).waitFor();
    // Keep the decoy. Losing the selected occurrence must leave its thread unmatched.
    await page.locator('#target').evaluate(node=>node.replaceChildren(document.createTextNode('This passage has been removed.')));
    await reopened.getByText('The original passage could not be located.').waitFor();
    assert.equal(await control(cdp,'.marker'),null);
    result.checks.push('duplicate quote, DOM replacement, scroll clipping, missing passage');
  }
  await clickInCard(reopened,'Resolve thread');
  await reopened.getByRole('button',{name:'Reopen thread'}).waitFor();
  assert.equal(await control(cdp,'.marker'),null);
  await clickInCard(reopened,'Reopen thread');
  await reopened.getByRole('button',{name:'Resolve thread'}).waitFor();
  result.checks.push('resolve and reopen');
  if (item.stress) {
    await clickInCard(reopened,'Close conversation');
    await selectQuote(page,'#editable','Editable sample');
    await page.waitForFunction(()=>new Promise(ok=>requestAnimationFrame(()=>requestAnimationFrame(()=>ok(true)))));
    assert.equal(await control(cdp,'.add'),null);
    const previous=reopened.url();
    const nextCard=page.waitForEvent('framenavigated',{predicate:f=>f.url().includes('/inline.html#') && f.url()!==previous});
    await page.evaluate(()=>{history.pushState({},'', '/another-article');});
    const next=await nextCard;
    await next.getByText('Select a passage and choose',{exact:false}).waitFor();
    assert.equal(await next.getByRole('button',{name:item.quote}).count(),0);
    assert.equal(await control(cdp,'.marker'),null);
    assert.equal(await page.evaluate(()=>CSS.highlights.get('web-comments-inline')?.size??0),0);
    result.checks.push('editable fields, single-page navigation');
  }
}
