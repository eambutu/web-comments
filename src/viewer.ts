import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import { errorText, extensionClient, upload, type Config } from './client';
import { hash, type Capture, type PDFAnchor, type Thread } from './model';
import './viewer.css';

const source = new URL(location.href).searchParams.get('url') ?? '';
const status = document.getElementById('status')!;
const pages = document.getElementById('pages')!;
const file = document.querySelector<HTMLInputElement>('#file')!;
const original = document.querySelector<HTMLAnchorElement>('#source')!;
if (/^(https?|file):\/\//.test(source)) original.href = source;
else original.remove();
GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.mjs');

let documentData: {capture:Capture; bytes:ArrayBuffer}|null = null;
let selection:PDFAnchor|null = null;
let operation = 0;
let observer:IntersectionObserver|null = null;
let pdf:PDFDocumentProxy|null = null;
let knownThreads:Thread[] = [];

function highlights(threads:Thread[], focus?:string) {
  knownThreads = threads;
  pages.querySelectorAll('.markers').forEach(layer => layer.replaceChildren());
  const missing:string[] = [];
  for (const thread of threads) {
    const anchor = thread.anchor;
    if (anchor.kind !== 'pdf' || !documentData || anchor.binaryHash !== documentData.capture.binaryHash) {
      missing.push(thread.id);
      continue;
    }
    const sheet = pages.querySelector<HTMLElement>(`.sheet[data-page="${anchor.page}"]`);
    const markers = sheet?.querySelector('.markers');
    if (!markers) { missing.push(thread.id); continue; }
    for (const rect of anchor.rects) {
      const marker = document.createElement('span');
      marker.className = 'marker';
      marker.style.cssText = `left:${rect.x*100}%;top:${rect.y*100}%;width:${rect.w*100}%;height:${rect.h*100}%`;
      markers.append(marker);
    }
    if (thread.id === focus) sheet?.scrollIntoView({block:'center',behavior:'smooth'});
  }
  return missing;
}

async function load(getBytes:()=>Promise<ArrayBuffer>) {
  const current = ++operation;
  observer?.disconnect();
  void pdf?.destroy().catch(() => undefined);
  pdf = null; documentData = null; selection = null; pages.replaceChildren();
  status.textContent = 'Opening PDF…';
  try {
    const bytes = await getBytes();
    if (operation !== current) return;
    const binaryHash = await hash(bytes);
    const loading = getDocument({
      data: bytes.slice(0), cMapUrl:chrome.runtime.getURL('cmaps/'),cMapPacked:true,
      standardFontDataUrl:chrome.runtime.getURL('standard_fonts/'), isEvalSupported:false,
    });
    loading.onPassword = (update:(password:string)=>void,reason:number) => {
      const password = prompt(reason === 2 ? 'Incorrect password. Enter the PDF password.' : 'Enter the PDF password.');
      if (password === null) void loading.destroy();
      else update(password);
    };
    const doc = await loading.promise;
    if (operation !== current) { await doc.destroy(); return; }
    pdf = doc;
    const text:string[] = [];
    const issues:string[] = [];
    const renders = new Map<Element,()=>Promise<void>>();
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        observer?.unobserve(entry.target);
        void renders.get(entry.target)?.().catch(error => {
          if (operation === current) status.textContent = 'A page could not be displayed. '+errorText(error);
        });
      }
    },{rootMargin:'400px'});
    for (let number=1; number<=doc.numPages; number++) {
      if (operation !== current) return;
      try {
        const page = await doc.getPage(number);
        const viewport = page.getViewport({scale:1.25});
        const extracted = await page.getTextContent({includeMarkedContent:false});
        const items = extracted.items.flatMap(item => 'str' in item ? [item] : []);
        const body = items.map((item,index) => {
          const next = items[index+1];
          const separate = item.hasEOL || (next && Math.abs(next.transform[5]-item.transform[5]) > 3);
          return item.str + (separate ? '\n' : '');
        }).join('');
        if (!body.trim()) issues.push(`Page ${number} has no extractable text and may require OCR.`);
        else if (body.includes('\uFFFD')) issues.push(`Page ${number} has unrecognized characters.`);
        text.push(`## Page ${number}\n\n${body}`);
        const sheet = document.createElement('section');
        sheet.className = 'sheet';sheet.dataset.page = String(number);
        sheet.setAttribute('aria-label',`Page ${number}`);
        sheet.style.width = `${viewport.width}px`;sheet.style.height = `${viewport.height}px`;
        sheet.style.setProperty('--scale-factor',String(viewport.scale));
        const markers = document.createElement('div'); markers.className='markers';
        sheet.append(markers);
        pages.append(sheet);
        renders.set(sheet,async () => {
          const canvas = document.createElement('canvas');
          const pixelRatio = Math.min(window.devicePixelRatio,2);
          canvas.width = Math.ceil(viewport.width*pixelRatio);canvas.height = Math.ceil(viewport.height*pixelRatio);
          canvas.style.width = '100%';canvas.style.height = '100%';
          sheet.prepend(canvas);
          const layer = document.createElement('div'); layer.className='textLayer';sheet.append(layer);
          await Promise.all([
            page.render({canvasContext:canvas.getContext('2d')!,viewport,transform:[pixelRatio,0,0,pixelRatio,0,0]}).promise,
            new TextLayer({textContentSource:extracted,container:layer,viewport}).render(),
          ]);
        });
        observer.observe(sheet);
      } catch (error) {
        if (operation !== current) return;
        issues.push(`Page ${number} could not be read.`);
        text.push(`## Page ${number}\n\n[Extraction failed]`);
      }
    }
    if (operation !== current) return;
    const lastSegment = new URL(source).pathname.split('/').pop();
    const metadata = await doc.getMetadata().catch(() => null);
    const info = metadata?.info as {Title?:string}|undefined;
    if (operation !== current) return;
    const title = info?.Title?.trim() || lastSegment || 'PDF document';
    document.title = title;
    documentData = {bytes,capture:{url:source,title,text:text.join('\n\n'),kind:'pdf',
      complete:issues.length === 0,note:issues.join(' '),anchor:null,binaryHash}};
    highlights(knownThreads);
    status.textContent = issues.length ? 'Capture incomplete. '+issues.join(' ') : `${doc.numPages} pages`;
  } catch (error) {
    if (operation === current) status.textContent = 'Could not open PDF. '+errorText(error);
  }
}

document.addEventListener('selectionchange', () => {
  const active = getSelection();
  if (!active || active.isCollapsed || !active.rangeCount || !documentData) {
    if (document.hasFocus()) selection = null;
    return;
  }
  selection = null;
  const range = active.getRangeAt(0);
  const pageFor = (node:Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('.sheet');
  const sheet = pageFor(range.startContainer);
  const exact = active.toString();
  if (!sheet || sheet !== pageFor(range.endContainer) || !exact.trim() || exact.length > 6000) return;
  const box = sheet.getBoundingClientRect();
  const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({
    x:(rect.left-box.left)/box.width,y:(rect.top-box.top)/box.height,w:rect.width/box.width,h:rect.height/box.height,
  }));
  if (!rects.length || rects.length > 150) return;
  selection = {kind:'pdf',exact,page:Number(sheet.dataset.page),binaryHash:documentData.capture.binaryHash!,rects};
});
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
  if (message.type === 'wc-pdf-highlights') { respond(highlights(message.threads,message.focus)); return; }
  if (message.type !== 'wc-pdf-capture') return;
  void (async () => {
    const data = documentData;
    if (!data) throw new Error('Open a PDF in the viewer first.');
    const capture = {...data.capture,anchor:selection};
    if (message.uploadPdf) {
      const {db,user} = await signedInClient();
      capture.pdfPath = `${user.id}/${capture.binaryHash}.pdf`;
      await upload(db,capture.pdfPath,new Blob([data.bytes],{type:'application/pdf'}));
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
