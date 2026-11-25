import { createClient } from '@supabase/supabase-js';
import { errorText, type Config } from './client';

const app = document.getElementById('app')!;
const title = document.createElement('h1'); title.textContent='Web Comments';
const card = document.createElement('section'); card.className='card stack';
const status = document.createElement('p'); status.className='status';
app.replaceChildren(title,card,status);
function element<K extends keyof HTMLElementTagNameMap>(name:K,text?:string) {
  const node = document.createElement(name);
  if (text) node.textContent=text;
  return node;
}
async function start() {
  const config:Config = await (await fetch('/config.json')).json();
  const db = createClient(config.supabaseUrl,config.publishableKey);
  const consent = location.pathname === '/oauth/consent';
  const id = new URLSearchParams(location.search).get('authorization_id');
  const pageId = location.pathname.match(/^\/p\/([0-9a-f-]{36})\/?$/i)?.[1];
  if (!consent && !pageId) {
    card.replaceChildren(element('p','Open the Chrome side panel to annotate a page, or use a copied page link.'));
    return;
  }
  if (consent && !id) throw new Error('The OAuth authorization ID is missing.');
  async function render() {
    status.textContent='';
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
        } catch (error) { status.textContent=errorText(error); }
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
        if (error) { status.textContent=error.message;approve.disabled=deny.disabled=false; }
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
void start().catch(error => {status.textContent=errorText(error);});
