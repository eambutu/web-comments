import { createClient } from '@supabase/supabase-js';
import { defaultServerOrigin, errorText, signInAccount, signUpAccount, type Config } from './client';

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
  const playground = element('a','Try the playground');
  playground.href='/playground';
  card.replaceChildren(element('h2','Set up Web Comments in Chrome'),playground,download,steps,signup);
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
function accountSignup() {
  const form = element('form');
  form.className='stack';
  const username = element('input');
  username.name='username';username.autocomplete='username';username.required=true;
  username.minLength=3;username.maxLength=32;username.pattern='[A-Za-z][A-Za-z0-9_\\-]{2,31}';
  username.title='Start with a letter. Use only letters, numbers, underscores or hyphens.';
  username.autocapitalize='none';username.spellcheck=false;
  const usernameLabel = element('label','Username');
  usernameLabel.append(username);
  const password = element('input');
  password.name='password';password.type='password';password.autocomplete='new-password';
  password.required=true;password.minLength=12;
  const passwordLabel = element('label','Password');
  passwordLabel.append(password);
  const submit=element('button','Create account');submit.className='primary';
  form.append(usernameLabel,passwordLabel,element('p','Use at least 12 characters. Save your password so you can sign in again.'),submit);
  form.onsubmit=async event => {
    event.preventDefault();submit.disabled=true;showStatus('');
    try {
      await signUpAccount(location.origin,username.value,password.value);
      const download=element('a','Download Chrome extension');
      download.href='/downloads/chrome-extension.zip';download.className='download';
      card.replaceChildren(element('h2','Your account is ready'),
        element('p','Open Web Comments in Chrome and sign in with the username and password you just chose.'),download);
    } catch (error) { showStatus(errorText(error)); }
    finally { submit.disabled=false; }
  };
  card.replaceChildren(element('h2','Create your account'),form);
}
async function start() {
  if (location.pathname === '/signup') { accountSignup(); return; }
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
      const inputs = ['Username or email','Password'].map((name,index) => {
        const label=element('label',name),input=element('input');
        input.type=index===0?'text':'password';input.required=true;
        input.autocomplete=index===0?'username':'current-password';
        if (index===0) { input.autocapitalize='none';input.spellcheck=false; }
        label.append(input);form.append(label);
        return input;
      });
      const submit=element('button','Sign in');submit.className='primary';form.append(submit);
      form.onsubmit = async event => {
        event.preventDefault();submit.disabled=true;
        try {
          await signInAccount(db,config.origin,inputs[0].value,inputs[1].value);
          await render();
        } catch (error) { showStatus(errorText(error)); }
        finally { submit.disabled=false; }
      };
      const signup=element('a','Create a private account');
      signup.href='/signup';signup.target='_blank';signup.rel='noopener';
      card.append(element('h2',consent?'Sign in to authorize ChatGPT':'Sign in to view this page'),form,signup);
      return;
    }
    if (consent) {
      const {data,error} = await db.auth.oauth.getAuthorizationDetails(id!);
      if (error) throw error;
      if ('redirect_url' in data) { location.assign(data.redirect_url); return; }
      if (data.client.id !== config.clientId) throw new Error('This OAuth client is not configured for Web Comments.');
      card.append(element('h2','Connect ChatGPT'),
        element('p',`Allow ${data.client.name} to read your saved pages and comments and write replies to @AI questions.`),
        element('p',`Signed in as ${session.user.app_metadata.web_comments_username ?? data.user.email}`));
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
