import { htmlDocument } from './html-document';

const page = htmlDocument(document.body, () => ({url:location.href,title:document.title || location.hostname}));
chrome.runtime.onMessage.addListener((message,_sender,respond) => {
  if (message.type === 'wc-html-capture') respond(page.capture());
  if (message.type === 'wc-html-highlights') respond(page.highlight(message.threads,message.focus));
});
