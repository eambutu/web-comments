import { extensionClient, type Config } from './client';
import { authTokens, browserAuthMessage, challengePattern, extensionSignInPath } from './extension-auth';

void chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true});

type PendingLogin = {origin:string;state:string;expiresAt:number};
const loginKey = (tab:number) => 'wc-pending-login:'+tab;
const completing = new Set<number>();

async function readConfig() {
  return (await chrome.storage.local.get('wcConfig')).wcConfig as Config|undefined;
}

async function openLogin(signUp:boolean) {
  const config = await readConfig();
  if (!config) throw new Error('Connect your server first.');
  const url = new URL(extensionSignInPath,config.origin);
  const state = crypto.randomUUID().replaceAll('-','');
  if (signUp) url.searchParams.set('mode','signup');
  url.hash = 'state='+state;
  const {id} = await chrome.tabs.create({url:'about:blank'});
  if (id===undefined) throw new Error('Could not open a Chrome sign-in tab.');
  await chrome.storage.session.set({[loginKey(id)]:{origin:url.origin,state,expiresAt:Date.now()+30*60_000}});
  await chrome.tabs.update(id,{url:url.href});
}

async function finishLogin(message:{state?:unknown;tokens?:unknown},sender:chrome.runtime.MessageSender) {
  const id = sender.tab?.id;
  const tokens = authTokens(message.tokens);
  if (id===undefined || sender.frameId!==0 || !sender.url || typeof message.state!=='string'
      || !challengePattern.test(message.state) || !tokens || completing.has(id)) return false;

  completing.add(id);
  try {
    const key = loginKey(id);
    const ticket = (await chrome.storage.session.get(key))[key] as PendingLogin|undefined;
    const url = new URL(sender.url);
    if (!ticket || ticket.expiresAt <= Date.now() || ticket.state!==message.state || url.origin!==ticket.origin
        || sender.origin!==ticket.origin || url.pathname!==extensionSignInPath) return false;
    const config = await readConfig();
    if (!config || config.origin!==ticket.origin) return false;

    const db = extensionClient(config,false);
    const {error} = await db.auth.setSession(tokens);
    if (error) return false;
    await chrome.storage.session.remove(key);
    void chrome.runtime.sendMessage({type:'wc-session-updated'}).catch(()=>{});
    return true;
  } finally {
    completing.delete(id);
  }
}

chrome.runtime.onMessage.addListener((message,sender,respond) => {
  if (message?.type==='wc-open-sign-in' && sender.url===chrome.runtime.getURL('panel.html')) {
    void openLogin(message.signUp===true).then(()=>respond({ok:true}),()=>respond({ok:false}));
    return true;
  }
  if (message?.type===browserAuthMessage) {
    void finishLogin(message,sender).then(ok=>respond({ok}),()=>respond({ok:false}));
    return true;
  }
});
chrome.tabs.onRemoved.addListener(tab=>{void chrome.storage.session.remove(loginKey(tab));});
