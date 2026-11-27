import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import { errorText } from './client';
import { hash, type Capture, type PDFAnchor, type Thread } from './model';

export function pdfDocument({source,assets,status,pages,onTitle,deriveTitle=false}:{
  source:string;assets:URL;status:HTMLElement;pages:HTMLElement;onTitle?:(title:string)=>void;deriveTitle?:boolean;
}) {
  GlobalWorkerOptions.workerSrc = new URL('pdf.worker.mjs',assets).href;

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
        data: bytes.slice(0), cMapUrl:new URL('cmaps/',assets).href,cMapPacked:true,
        standardFontDataUrl:new URL('standard_fonts/',assets).href, isEvalSupported:false,
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
      let heading = '';
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
          if (number===1 && deriveTitle) {
            const candidates = items.filter(item=>{
              const value=item.str.trim();
              const size=Math.hypot(item.transform[0],item.transform[1]);
              return value.length>=8 && value.length<=160 && /\p{L}/u.test(value)
                && Math.abs(item.transform[1])<size*.15 && item.transform[5]>viewport.height/viewport.scale*.55;
            });
            const largest=candidates.reduce((best,item)=>Math.abs(item.transform[0])>Math.abs(best.transform[0])?item:best,
              candidates[0]);
            heading=largest?.str.trim() ?? '';
          }
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
      const numericName=!lastSegment || /^\d+(?:\.\d+)*(?:v\d+)?(?:\.pdf)?$/i.test(lastSegment);
      const title = info?.Title?.trim() || (numericName ? heading : '') || lastSegment || 'PDF document';
      onTitle?.(title);
      documentData = {bytes,capture:{url:source,title,text:text.join('\n\n'),kind:'pdf',
        complete:issues.length === 0,note:issues.join(' '),anchor:null,binaryHash}};
      highlights(knownThreads);
      status.textContent = issues.length ? 'Capture incomplete. '+issues.join(' ') : `${doc.numPages} ${doc.numPages===1 ? 'page' : 'pages'}`;
    } catch (error) {
      if (operation === current) status.textContent = 'Could not open PDF. '+errorText(error);
    }
  }

  function select() {
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
  }

  document.addEventListener('selectionchange',select);
  return {
    load,
    highlight:highlights,
    capture() {
      if (!documentData) throw new Error('Open a PDF in the viewer first.');
      return {bytes:documentData.bytes,capture:{...documentData.capture,anchor:selection}};
    },
    dispose() {
      operation++;
      document.removeEventListener('selectionchange',select);
      observer?.disconnect();
      void pdf?.destroy().catch(()=>undefined);
    },
  };
}
