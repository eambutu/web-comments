import { htmlDocument } from './html-document';
import { inlineComments } from './inline-page';
import { authTokens, browserAuthMessage, browserAuthResult, challengePattern, extensionSignInPath } from './extension-auth';

const source=()=>({url:location.href,title:document.title || location.hostname});
let body=document.body;
let page=htmlDocument(body,source);
function currentPage() {
  if (body!==document.body) {
    page.dispose();
    body=document.body;
    page=htmlDocument(body,source);
  }
  return page;
}
let inline:ReturnType<typeof inlineComments>|undefined;
function setInline(active:boolean) {
  if (active && !inline && document.contentType==='text/html' && location.pathname!==extensionSignInPath) {
    inline=inlineComments(range=>currentPage().capture(range));
  } else if (!active && inline) {
    inline();
    inline=undefined;
  }
}
let activationChanged=false;
chrome.runtime.onMessage.addListener((message,_sender,respond) => {
  if (message.type === 'wc-html-capture') respond(currentPage().capture());
  if (message.type === 'wc-html-highlights') respond(currentPage().highlight(message.threads,message.focus));
  if (message.type === 'wc-inline-active') {
    activationChanged=true;
    setInline(message.active===true);
    respond(true);
  }
});
void chrome.runtime.sendMessage({type:'wc-inline-restore'}).then(active=>{
  if (!activationChanged && active===true) setInline(true);
}).catch(()=>{});
let currentUrl=location.href;
function navigated() {
  if (currentUrl===location.href) return;
  currentUrl=location.href;
  if (inline) { setInline(false);setInline(true); }
}
// Navigation API observes pushState/replaceState as well as hash and history traversal.
const navigation=(window as Window & {navigation?:EventTarget}).navigation;
navigation?.addEventListener('currententrychange',navigated);
window.addEventListener('pageshow',navigated);

if (window===window.top && location.pathname===extensionSignInPath) {
  window.addEventListener('message',event=>{
    const {data}=event;
    if (event.source!==window || event.origin!==location.origin || data?.type!==browserAuthMessage
        || typeof data.state!=='string' || !challengePattern.test(data.state)) return;
    const tokens = authTokens(data.tokens);
    if (!tokens) return;
    void chrome.runtime.sendMessage({type:browserAuthMessage,state:data.state,tokens})
      .then(answer=>answer?.ok===true,()=>false)
      .then(ok=>window.postMessage({type:browserAuthResult,state:data.state,ok},location.origin));
  });
}
