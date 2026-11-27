import { errorText, extensionClient, upload, type Config } from './client';
import { pdfDocument } from './pdf-document';
import './viewer.css';

const source = new URL(location.href).searchParams.get('url') ?? '';
const status = document.getElementById('status')!;
const pages = document.getElementById('pages')!;
const file = document.querySelector<HTMLInputElement>('#file')!;
const original = document.querySelector<HTMLAnchorElement>('#source')!;
if (/^(https?|file):\/\//.test(source)) original.href = source;
else original.remove();



const viewer = pdfDocument({source,assets:new URL(chrome.runtime.getURL('/')),status,pages,
  onTitle:title=>{ document.title=title; }});
const {load,highlight}=viewer;
document.getElementById('open')!.onclick = () => file.click();
async function signedInClient() {
  const config = (await chrome.storage.local.get('wcConfig')).wcConfig as Config|undefined;
  if (!config) throw new Error('Connect Web Comments first.');
  const db = extensionClient(config);
  const {data:{user},error} = await db.auth.getUser();
  if (error || !user) throw new Error('Sign in to Web Comments first.');
  return {db,user};
}
document.getElementById('saved')!.onclick = () => void load(async () => {
  const {db} = await signedInClient();
  const {data:page,error} = await db.from('wc_pages').select('latest_version').eq('source_url',source).maybeSingle();
  if (error) throw error;
  if (!page) throw new Error('There is no saved copy of this PDF.');
  const version = await db.from('wc_versions').select('pdf_path').eq('id',page.latest_version).single();
  if (version.error) throw version.error;
  if (!version.data.pdf_path) throw new Error('There is no saved copy of this PDF.');
  const saved = await db.storage.from('web-comments').download(version.data.pdf_path);
  if (saved.error) throw saved.error;
  return saved.data.arrayBuffer();
});
file.onchange = () => {
  const selected = file.files?.[0];
  if (selected) void load(() => selected.arrayBuffer());
};
const viewerTab = (await chrome.tabs.getCurrent())?.id;
chrome.runtime.onMessage.addListener((message,_sender,respond) => {
  if (viewerTab === undefined || message.targetTab !== viewerTab) return;
  if (message.type === 'wc-pdf-highlights') { respond(highlight(message.threads,message.focus)); return; }
  if (message.type !== 'wc-pdf-capture') return;
  void (async () => {
    const {capture,bytes}=viewer.capture();
    if (message.uploadPdf) {
      const {db,user} = await signedInClient();
      capture.pdfPath = `${user.id}/${capture.binaryHash}.pdf`;
      await upload(db,capture.pdfPath,new Blob([bytes],{type:'application/pdf'}));
    }
    return capture;
  })().then(respond,error => respond({error:errorText(error)}));
  return true;
});
if (/^(https?|file):\/\//.test(source)) void load(async () => {
  const response = await fetch(source,{credentials:'include'});
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}. Open a downloaded copy if the site requires sign-in.`);
  return response.arrayBuffer();
});
else status.textContent = 'Open this viewer from a PDF tab.';
