import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import { AccountForm } from './account-form';
import { defaultServerOrigin, errorText, loadConfig, type Config } from './client';
import { challengePattern, extensionSignInPath, handOffSession } from './extension-auth';

const app = document.getElementById('app')!;
const title = document.createElement('h1'); title.textContent='Web Comments';
const card = document.createElement('section'); card.className='card stack';
const status = document.createElement('p'); status.className='status';
status.setAttribute('role','status');
status.hidden = true;
function showStatus(message:string) {
  status.textContent=message;
  status.hidden=!message;
}
app.replaceChildren(title,card,status);
function element<K extends keyof HTMLElementTagNameMap>(name:K,text?:string) {
  const node = document.createElement(name);
  if (text) node.textContent=text;
  return node;
}
function home(config:Config) {
  const download = element('a','Download Chrome extension');
  download.className='download';
  download.href='/downloads/chrome-extension.zip';
  const preconfigured = defaultServerOrigin === config.origin;
  const steps=element('ol');
  steps.append(
    element('li','Unzip the download. In Chrome, open chrome://extensions, turn on Developer mode, and choose Load unpacked. Select the extracted folder.'),
    element('li',preconfigured ? 'Open Web Comments from the toolbar.' : 'Open Web Comments from the toolbar and paste the server address.'),
    element('li','Create an account or sign in from the Chrome side panel.'),
  );
  const signup = element('a','Create a private account');
  signup.href='/signup';
  const library = element('a','Open your web library');
  library.href='/library';
  const playground = element('a','Try the playground');
  playground.href='/playground';
  card.replaceChildren(library,playground,element('h2','Set up Web Comments in Chrome'),download,steps,signup);
  if (preconfigured) return;
  const address=element('label','Server address');
  const value=element('input');
  value.readOnly=true;value.value=config.origin;
  address.append(value);
  const copy=element('button','Copy address');
  copy.onclick=async () => {
    try { await navigator.clipboard.writeText(config.origin); showStatus('Server address copied.'); }
    catch { value.select(); showStatus('Select and copy the server address.'); }
  };
  card.append(address,copy);
}
let accountRoot:Root|undefined;
function resetCard(...children:Node[]) {
  accountRoot?.unmount();
  accountRoot=undefined;
  card.replaceChildren(...children);
}
function accountForm(props:React.ComponentProps<typeof AccountForm>, ...heading:Node[]) {
  const container=element('div');
  container.className='stack';
  resetCard(...heading,container);
  accountRoot=createRoot(container);
  accountRoot.render(React.createElement(AccountForm,props));
}
async function start() {
  const config=await loadConfig(location.origin);
  const path=location.pathname.replace(/\/$/,'') || '/';
  const query=new URLSearchParams(location.search);
  if (path===extensionSignInPath) {
    const state=new URLSearchParams(location.hash.slice(1)).get('state');
    if (!state || !challengePattern.test(state)) {
      resetCard(element('h2','Sign in from Chrome'),
        element('p','Open Web Comments in the Chrome side panel to start a sign-in.'));
      return;
    }
    const db=createClient(config.supabaseUrl,config.publishableKey,{
      auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    });
    accountForm({db,initialSignUp:query.get('mode')==='signup',async onSignedIn(session) {
      await handOffSession(state,session);
      history.replaceState(null,'',extensionSignInPath);
      resetCard(element('h2','Signed in to Web Comments in Chrome'),
        element('p','Return to your previous tab and open the Web Comments side panel.'));
    }},element('p','Sign in to use Web Comments in the Chrome side panel.'));
    return;
  }

  const db = createClient(config.supabaseUrl,config.publishableKey);
  if (path==='/sign-in' || path==='/signup') {
    async function renderAccount() {
      const {data:{session}}=await db.auth.getSession();
      if (!session) {
        accountForm({db,initialSignUp:path==='/signup',onSignedIn:renderAccount});
        return;
      }
      const library=element('a','Open your library');
      library.href='/library';
      const signOut=element('button','Sign out');
      signOut.onclick=async ()=>{
        const {error}=await db.auth.signOut();
        if (error) showStatus(error.message);
        else await renderAccount();
      };
      resetCard(element('h2','Signed in'),library,signOut);
    }
    await renderAccount();
    return;
  }
  const consent = path === '/oauth/consent';
  const id = new URLSearchParams(location.search).get('authorization_id');
  const pageId = location.pathname.match(/^\/p\/([0-9a-f-]{36})\/?$/i)?.[1];
  if (!consent && !pageId) {
    home(config);
    return;
  }
  if (consent && !id) throw new Error('The OAuth authorization ID is missing.');
  if (consent && !config.clientId) throw new Error('The ChatGPT connection is still being set up.');
  async function render() {
    showStatus('');
    const {data:{session}} = await db.auth.getSession();
    if (!session) {
      accountForm({db,onSignedIn:render},
        element('p',consent?'Sign in to authorize ChatGPT.':'Sign in to view this page.'));
      return;
    }
    resetCard();
    if (consent) {
      const {data,error} = await db.auth.oauth.getAuthorizationDetails(id!);
      if (error) throw error;
      if ('redirect_url' in data) { location.assign(data.redirect_url); return; }
      if (data.client.id !== config.clientId) throw new Error('This OAuth client is not configured for Web Comments.');
      card.append(element('h2','Connect ChatGPT'),
        element('p',`Allow ${data.client.name} to read your saved pages and comments and write replies to @AI questions.`),
        element('p',`Signed in as ${data.user.email}`));
      const actions=element('div');actions.className='actions';
      const approve=element('button','Allow');approve.className='primary';
      const deny=element('button','Deny');
      const decide = async (allow:boolean) => {
        approve.disabled=deny.disabled=true;
        const {error} = await (allow ? db.auth.oauth.approveAuthorization(id!) : db.auth.oauth.denyAuthorization(id!));
        if (error) { showStatus(error.message);approve.disabled=deny.disabled=false; }
      };
      approve.onclick=()=>void decide(true);deny.onclick=()=>void decide(false);
      actions.append(approve,deny);card.append(actions);
      return;
    }
    const {data:page,error} = await db.from('wc_pages').select('source_url,latest_version').eq('id',pageId!).maybeSingle();
    if (error || !page) throw new Error('Page unavailable for this account.');
    const {data:version,error:versionError} = await db.from('wc_versions')
      .select('title, captured_at, complete, extraction_note').eq('id',page.latest_version).single();
    if (versionError) throw versionError;
    const source=page.source_url.startsWith('file:') ? element('p',page.source_url) : element('a','Open source document');
    if (source instanceof HTMLAnchorElement) { source.href=page.source_url;source.rel='noreferrer'; }
    card.append(element('h2',version.title),source,element('p',`Captured ${new Date(version.captured_at).toLocaleString()}`));
    if (!version.complete) card.append(element('p',version.extraction_note));
    const signOut=element('button','Sign out');signOut.className='subtle';
    signOut.onclick=async ()=>{await db.auth.signOut();await render();};
    card.append(signOut);
  }
  await render();
}
void start().catch(error => {showStatus(errorText(error));});
