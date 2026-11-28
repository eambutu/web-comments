import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function moduleFrom(path) {
  const {outputFiles}=await build({entryPoints:[path],write:false,bundle:true,format:'esm',platform:'browser'});
  return import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].contents).toString('base64'));
}
test('the toolbar choice is remembered, with per-tab activation and a keyboard toggle',async()=>{
  const {registerInlineAction}=await moduleFrom('src/inline-action.ts');
  const handlers={},local={},session={},sent=[],behaviors=[],panels=[];
  const event=name=>({addListener(fn){handlers[name]=fn;}});
  const storage=data=>({async get(key){return {[key]:data[key]};},async set(value){Object.assign(data,value);},async remove(key){delete data[key];}});
  const tab={id:7,url:'https://research.example/article'};
  globalThis.chrome={
    storage:{local:storage(local),session:storage(session)},
    sidePanel:{async setPanelBehavior(input){behaviors.push(input.openPanelOnActionClick);},async open({tabId}){panels.push(tabId);}},
    action:{onClicked:event('toolbar')},commands:{onCommand:event('shortcut')},
    contextMenus:{onClicked:event('menu'),async removeAll(){},create(){}},
    runtime:{onMessage:event('message'),onInstalled:event('installed')},
    tabs:{onRemoved:event('removed'),async sendMessage(id,message,frame){sent.push([id,message.active,frame.frameId]);}},
  };
  const settle=()=>new Promise(r=>setImmediate(r));
  try {
    registerInlineAction();await settle();
    assert.deepEqual(behaviors,[true]);
    await handlers.menu({menuItemId:'wc-use-inline'},tab);
    assert.equal(local.wcInlineAction,true);assert.equal(behaviors.at(-1),false);
    assert.deepEqual(sent.at(-1),[7,true,0]);
    function restore(id,url) {
      return new Promise(resolve=>handlers.message({type:'wc-inline-restore'},{tab:{id},frameId:0,url},resolve));
    }
    assert.equal(await restore(7,tab.url),true);
    assert.equal(await restore(7,'https://elsewhere.example'),false);
    assert.equal(await restore(8,tab.url),false);
    handlers.toolbar(tab);await settle();assert.deepEqual(sent.at(-1),[7,false,0]);
    handlers.shortcut('toggle-in-page',tab);await settle();assert.deepEqual(sent.at(-1),[7,true,0]);
    const fallback=await new Promise(resolve=>handlers.message({type:'wc-inline-open-panel'},
      {tab,frameId:0,url:tab.url},resolve));
    assert.equal(fallback,true);assert.equal(panels.at(-1),7);assert.equal(await restore(7,tab.url),false);
    assert.equal(local.wcInlineAction,true);
    await handlers.menu({menuItemId:'wc-use-panel'},tab);
    assert.equal(behaviors.at(-1),true);assert.deepEqual(sent.at(-1),[7,false,0]);
  } finally {delete globalThis.chrome;}
});

test('inline quotes survive whitespace changes and leave ambiguous passages unattached',async()=>{
  const {inlineQuoteIndex}=await moduleFrom('src/inline-anchors.ts');
  const quote='chosen words';
  const before='Another example: chosen words were rejected.\nAcross the page: ';
  const after=' were selected here.';
  const anchor={kind:'html',start:before.length,end:before.length+quote.length,exact:quote,prefix:before,suffix:after,occurrences:2};
  const changed='A new introduction.\n'+before+'chosen\n   words'+after;
  const match=inlineQuoteIndex(changed).range(anchor);
  assert.equal(changed.slice(match.start,match.end),'chosen\n   words');
  assert.equal(inlineQuoteIndex('Another example: chosen words were rejected.').range(anchor),null);
  assert.equal(inlineQuoteIndex('one x and another x').range({...anchor,exact:'x',prefix:'',suffix:'',start:5}),null);
});
