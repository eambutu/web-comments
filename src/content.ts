import { htmlDocument } from './html-document';
import { authTokens, browserAuthMessage, browserAuthResult, challengePattern, extensionSignInPath } from './extension-auth';

const page = htmlDocument(document.body, () => ({url:location.href,title:document.title || location.hostname}));
chrome.runtime.onMessage.addListener((message,_sender,respond) => {
  if (message.type === 'wc-html-capture') respond(page.capture());
  if (message.type === 'wc-html-highlights') respond(page.highlight(message.threads,message.focus));
});

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
