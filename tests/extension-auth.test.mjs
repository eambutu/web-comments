import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('the extension accepts a browser sign-in only from its own pending tab, once',async () => {
  const origin = 'https://comments.example';
  const supabaseUrl = 'https://demo.supabase.co';
  const panel = 'chrome-extension://example/panel.html';
  const tabId = 17;
  const user = {id:randomUUID(),aud:'authenticated',email:'test@example.test'};
  const browserStorage = {'wcConfig':{origin,supabaseUrl,publishableKey:'fixture',clientId:null}};
  const pending = {};
  let handleMessage;
  let opened;
  const notifications = [];
  const storage = data => ({
    async get(key) { return {[key]:data[key]}; },
    async set(values) { Object.assign(data,values); },
    async remove(key) { delete data[key]; },
  });

  const sandbox = {
    console, URL, URLSearchParams, Headers, Response, WebSocket, Blob, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, atob, btoa, crypto:webcrypto,
    async fetch(url) {
      assert.equal(url,supabaseUrl+'/auth/v1/user');
      return Response.json(user);
    },
    chrome:{
      sidePanel:{async setPanelBehavior() {}},
      action:{onClicked:{addListener() {}}},
      commands:{onCommand:{addListener() {}}},
      contextMenus:{onClicked:{addListener() {}}},
      tabs:{
        async create({url}) { assert.equal(url,'about:blank');return {id:tabId}; },
        async update(id,{url}) { assert.equal(id,tabId);opened=new URL(url); },
        onRemoved:{addListener() {}},
      },
      storage:{local:storage(browserStorage),session:storage(pending)},
      runtime:{
        onInstalled:{addListener() {}},
        getURL:()=>panel,
        onMessage:{addListener(listener) { handleMessage=listener; }},
        async sendMessage(message) { notifications.push(message.type); },
      },
    },
  };
  vm.runInNewContext(await readFile(new URL('../dist/extension/background.js',import.meta.url),'utf8'),sandbox);

  async function dispatch(message,sender) {
    return new Promise(resolve=>{
      const handling=handleMessage(message,sender,reply=>resolve(reply?.ok));
      if (handling!==true) resolve(undefined);
    });
  }
  assert.equal(await dispatch({type:'wc-open-sign-in',signUp:true},{url:panel}),true);
  assert.equal(opened.origin,origin);
  assert.equal(opened.pathname,'/extension/sign-in');
  assert.equal(opened.searchParams.get('mode'),'signup');
  const state=new URLSearchParams(opened.hash.slice(1)).get('state');
  assert.match(state,/^[0-9a-f]{32}$/);

  const jwt = ['{}',JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600})]
    .map(part=>Buffer.from(part).toString('base64url')).join('.')+'.fixtureSignature';
  const message={type:'wc-browser-auth',state,tokens:{access_token:jwt,refresh_token:'fixture-refresh'}};
  const sender={tab:{id:tabId},frameId:0,url:opened.href,origin};
  assert.equal(await dispatch(message,{...sender,tab:{id:tabId+1}}),false);
  assert.equal(await dispatch(message,{...sender,origin:'https://elsewhere.example'}),false);
  assert.equal(await dispatch(message,{...sender,frameId:1}),false);
  assert.equal(await dispatch({...message,state:'0'.repeat(32)},sender),false);
  assert.equal(await dispatch(message,sender),true);
  assert.equal(await dispatch(message,sender),false);
  assert.equal(JSON.parse(browserStorage['sb-demo-auth-token']).user.id,user.id);
  assert.deepEqual(notifications,['wc-session-updated']);
});
