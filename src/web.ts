import { createClient } from '@supabase/supabase-js';
import { errorText, type Config } from './client';

const app = document.getElementById('app')!;
const title = document.createElement('h1'); title.textContent='Web Comments';
const card = document.createElement('section'); card.className='card stack';
const status = document.createElement('p'); status.className='status';
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
  const address=element('label','Server address');
  const value=element('input');
  value.readOnly=true;value.value=config.origin;
  address.append(value);
  const copy=element('button','Copy address');
  copy.onclick=async () => {
    try { await navigator.clipboard.writeText(config.origin); showStatus('Server address copied.'); }
    catch { value.select(); showStatus('Select and copy the server address.'); }
  };
  const steps=element('ol');
  steps.append(
    element('li','Unzip the download. In Chrome, open chrome://extensions, turn on Developer mode, and choose Load unpacked. Select the extracted folder.'),
    element('li','Open Web Comments from the toolbar and paste the server address.'),
    element('li',config.setupAvailable
      ? 'Create your account using your one-time setup code.'
      : 'Sign in with your Web Comments account.'),
  );
  card.replaceChildren(element('h2','Set up Web Comments in Chrome'),download,steps,address,copy);
}
async function start() {
  const response = await fetch('/config.json');
  if (!response.ok) throw new Error('The server could not load Web Comments configuration.');
  const config:Config = await response.json();
  const db = createClient(config.supabaseUrl,config.publishableKey);
  const consent = location.pathname === '/oauth/consent';
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
    card.replaceChildren();
    if (!session) {
      const form = element('form'); form.className='stack';
      const inputs = ['Email','Password'].map(name => {
        const label=element('label',name),input=element('input');
        input.type=name.toLowerCase();input.required=true;
        input.autocomplete=name==='Email'?'username':'current-password';
        label.append(input);form.append(label);
        return input;
      });
      const submit=element('button','Sign in');submit.className='primary';form.append(submit);
      form.onsubmit = async event => {
        event.preventDefault();submit.disabled=true;
        try {
          const {error} = await db.auth.signInWithPassword({email:inputs[0].value,password:inputs[1].value});
          if (error) throw error;
          await render();
        } catch (error) { showStatus(errorText(error)); }
        finally { submit.disabled=false; }
      };
      card.append(element('h2',consent?'Sign in to authorize ChatGPT':'Sign in to view this page'),form);
      return;
    }
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
