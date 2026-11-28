import { htmlThreadRanges } from './html-document';
import { cardPosition, readingColumn, visibleLine } from './inline-geometry';
import { inlineQuoteIndex } from './inline-anchors';
import type { CardToPage, PageToCard } from './inline-protocol';
import type { Capture, Thread } from './model';

const highlightName='web-comments-inline';
const draftHighlight='web-comments-inline-draft';
const css=`
  :host { all:initial; }
  button { position:absolute; pointer-events:auto; box-sizing:border-box; cursor:pointer;
    font:600 13px/1.2 system-ui,sans-serif; color:white; background:#185e56; border:1px solid white;
    border-radius:18px; padding:7px 12px; box-shadow:0 2px 8px #102e3038; white-space:nowrap; }
  button:focus-visible { outline:3px solid #1769c2; outline-offset:2px; }
  .launcher { bottom:10px; right:12px; }
  .marker { width:27px; height:27px; padding:0; border-radius:50% 50% 50% 2px; }
  iframe { position:absolute; pointer-events:auto; box-sizing:border-box; background:white; color-scheme:light;
    border:1px solid #adc4bc; border-radius:12px; box-shadow:0 5px 24px #15372f38; }
  [hidden] { display:none!important; }
`;
type Active={type:'overview'}|{type:'draft';range:Range}|{type:'thread';id:string};

export function inlineComments(capture:(range:Range)=>Capture) {
  const host=document.createElement('div');
  host.setAttribute('data-web-comments-overlay','');
  host.style.cssText='all:initial!important;position:fixed!important;inset:0!important;display:block!important;pointer-events:none!important;z-index:2147483647!important;';
  const shadow=host.attachShadow({mode:'closed'});
  const sheet=new CSSStyleSheet();sheet.replaceSync(css);
  shadow.adoptedStyleSheets=[sheet];
  const abort=new AbortController();
  const {signal}=abort;
  // getRandomValues is also available on plain HTTP pages.
  const ticket=Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
  let port:chrome.runtime.Port|undefined;
  let active:Active|null={type:'overview'};
  let pending:PageToCard={type:'overview'};
  let threads:Thread[]=[],ranges=new Map<string,Range>();
  const markers=new Map<string,HTMLButtonElement>();
  let selected:Range|null=null,raf=0,reindex=0,cardHeight=180;
  let unavailable=false;
  let returnFocus:HTMLElement|null=null;
  function button(label:string,cls:string,click:()=>void) {
    const node=document.createElement('button');
    node.type='button';node.textContent=label;node.className=cls;
    node.addEventListener('click',click);
    shadow.append(node);
    return node;
  }
  const launcher=button('Comments','launcher',()=>{
    if (unavailable) {
      void chrome.runtime.sendMessage({type:'wc-inline-open-panel'}).catch(()=>{});
    } else if (active && !frame.hidden) dismiss();
    else show({type:'overview'});
  });
  launcher.setAttribute('aria-label','Web Comments');
  const add=button('+ Comment','add',()=>{
    if (!selected) return;
    const snapshot=capture(selected);
    if (snapshot.anchor?.kind==='html') {
      const count=inlineQuoteIndex(snapshot.text).count(snapshot.anchor.exact);
      if (count>1) snapshot.anchor.occurrences=count;
      active={type:'draft',range:selected.cloneRange()};
      CSS.highlights.set(draftHighlight,new Highlight(active.range));
      selected=null;document.getSelection()?.removeAllRanges();
      present({type:'draft',capture:snapshot});
    }
  });
  add.setAttribute('aria-label','Comment on selection');add.hidden=true;
  add.addEventListener('mousedown',event=>event.preventDefault());
  const frame=document.createElement('iframe');
  frame.title='Web Comments conversation';
  frame.referrerPolicy='no-referrer';
  frame.src=chrome.runtime.getURL('inline.html')+'#'+ticket;
  shadow.append(frame);

  function present(message:PageToCard) {
    pending=message;
    port?.postMessage(message);
    returnFocus=shadow.activeElement instanceof HTMLButtonElement?shadow.activeElement:launcher;
    frame.hidden=false;
    frame.focus({preventScroll:true});
    drawSoon();
  }
  function show(target:Exclude<Active,{type:'draft'}>) {
    selected=null;
    CSS.highlights.delete(draftHighlight);active=target;present(target);
  }
  function dismiss() {
    CSS.highlights.delete(draftHighlight);
    active=null;pending={type:'overview'};frame.hidden=true;
    (returnFocus?.isConnected && !returnFocus.hidden?returnFocus:launcher).focus({preventScroll:true});
    drawSoon();
  }
  function selectionChanged() {
    const selection=document.getSelection();
    if (selection?.rangeCount && !selection.isCollapsed) {
      const range=selection.getRangeAt(0);
      const fields='input,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
      const inField=[range.startContainer,range.endContainer].some(node=>
        (node instanceof Element?node:node.parentElement)?.closest(fields));
      const text=range.toString();
      selected=!inField && !document.activeElement?.matches('input,textarea') && document.body.contains(range.commonAncestorContainer)
        && text.trim() && text.length<=6000 ? range.cloneRange() : null;
    } else selected=null;
    drawSoon();
  }
  function place(el:HTMLElement,x:number,y:number) {
    el.style.left=Math.round(x)+'px';el.style.top=Math.round(y)+'px';
  }
  function draw() {
    raf=0;
    const width=document.documentElement.clientWidth;
    const selection=selected && visibleLine(selected,true);
    add.hidden=unavailable || !selection || active?.type==='draft';
    if (selection && !add.hidden) place(add,Math.max(4,Math.min(selection.right+4,width-add.offsetWidth-4)),
      Math.max(4,Math.min(selection.bottom+3,innerHeight-add.offsetHeight-4)));
    const visible:{id:string;box:DOMRect}[]=[];
    for (const [id,marker] of markers) {
      const range=ranges.get(id),box=range && visibleLine(range);
      marker.hidden=!box || (active?.type==='thread' && active.id===id);
      if (box && !marker.hidden) visible.push({id,box});
    }
    // Line-adjacent markers that share a margin stack without covering each other.
    const placed:{x:number;y:number}[]=[];
    for (const {id,box} of visible.sort((a,b)=>a.box.top-b.box.top)) {
      const marker=markers.get(id)!;
      const edge=readingColumn(ranges.get(id)!)?.right??box.right;
      const x=Math.max(4,Math.min((edge+31<=width?edge:box.right)+4,width-31));
      let y=Math.max(2,box.top);
      for (const other of placed) if (Math.abs(other.x-x)<29 && Math.abs(other.y-y)<29) y=other.y+29;
      if (y+27>innerHeight) {marker.hidden=true;continue;}
      place(marker,x,y);placed.push({x,y});
    }
    launcher.setAttribute('aria-expanded',String(!!active && !frame.hidden));
    if (!active || frame.hidden) return;
    const range=active.type==='draft'?active.range:active.type==='thread'?ranges.get(active.id):null;
    const bounds=cardPosition(range??null,cardHeight);
    place(frame,bounds.left,bounds.top);
    frame.style.width=bounds.width+'px';frame.style.height=bounds.height+'px';
  }
  function drawSoon() { if (!raf && !signal.aborted) raf=requestAnimationFrame(draw); }
  function indexThreads() {
    reindex=0;
    ranges=htmlThreadRanges(document.body,threads,'inline');
    const highlights=threads.flatMap(t=>!t.resolved && ranges.has(t.id)?[ranges.get(t.id)!]:[]);
    CSS.highlights.set(highlightName,new Highlight(...highlights));
    port?.postMessage({type:'missing',ids:threads.filter(t=>!ranges.has(t.id)).map(t=>t.id)} satisfies PageToCard);
    drawSoon();
  }
  function changed() {
    if (threads.length && !reindex) reindex=window.setTimeout(indexThreads,120);
    drawSoon();
  }
  function receive(message:CardToPage) {
    switch (message.type) {
      case 'threads': {
        threads=message.threads;
        const unresolved=threads.filter(t=>!t.resolved);
        const keep=new Set(unresolved.map(t=>t.id));
        for (const [id,marker] of markers) if (!keep.has(id)) { marker.remove();markers.delete(id); }
        unresolved.forEach((thread,i)=>{
          let marker=markers.get(thread.id);
          if (!marker) {
            marker=button('','marker',()=>show({type:'thread',id:thread.id}));
            markers.set(thread.id,marker);
          }
          marker.textContent=String(i+1);marker.setAttribute('aria-label','Open comment '+(i+1));
        });
        launcher.textContent=unresolved.length?'Comments ('+unresolved.length+')':'Comments';
        indexThreads();break;
      }
      case 'focus': {
        const range=ranges.get(message.id);
        if (range && !visibleLine(range)) range.startContainer.parentElement?.scrollIntoView({block:'center',inline:'nearest'});
        CSS.highlights.delete(draftHighlight);
        active={type:'thread',id:message.id};drawSoon();break;
      }
      case 'height': cardHeight=Math.max(58,Math.ceil(message.pixels)+2);drawSoon();break;
      case 'overview': CSS.highlights.delete(draftHighlight);active={type:'overview'};drawSoon();break;
      case 'dismiss': dismiss();break;
    }
  }
  function connected(candidate:chrome.runtime.Port) {
    // Chrome can omit sender.url for tabs.connect from an embedded extension page.
    // Only this extension and the ticket for this particular closed-shadow iframe match.
    if (candidate.name!=='wc-inline:'+ticket || candidate.sender?.id!==chrome.runtime.id) return;
    if (candidate.sender.url && candidate.sender.url.split('#')[0]!==chrome.runtime.getURL('inline.html')) return;
    clearTimeout(fallback);
    if (unavailable) {
      unavailable=false;launcher.textContent='Comments';launcher.setAttribute('aria-label','Web Comments');
      launcher.removeAttribute('title');active={type:'overview'};frame.hidden=false;drawSoon();
    }
    port=candidate;
    candidate.onMessage.addListener(receive);
    candidate.onDisconnect.addListener(()=>{if (port===candidate) port=undefined;});
    candidate.postMessage({type:'page',source:location.href} satisfies PageToCard);
    candidate.postMessage(pending);
  }
  chrome.runtime.onConnect.addListener(connected);
  document.documentElement.append(host);
  const mutations=new MutationObserver(changed);
  mutations.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','open']});
  const size=new ResizeObserver(drawSoon);size.observe(document.documentElement);
  document.addEventListener('selectionchange',selectionChanged,{signal});
  document.addEventListener('scroll',drawSoon,{capture:true,passive:true,signal});
  window.addEventListener('resize',changed,{signal});
  document.addEventListener('load',drawSoon,{capture:true,signal});
  document.fonts.addEventListener('loadingdone',drawSoon,{signal});
  document.addEventListener('click',event=>{
    if (event.defaultPrevented || event.button!==0 || !document.getSelection()?.isCollapsed || !(event.target instanceof Element)
      || event.target.closest('a,button,input,textarea,select,[contenteditable]') || event.target===host) return;
    const caret=document.caretRangeFromPoint(event.clientX,event.clientY);
    if (!caret) return;
    for (const [id,range] of ranges) if (markers.has(id) && range.isPointInRange(caret.startContainer,caret.startOffset)
      && Array.from(range.getClientRects()).some(r=>event.clientX>=r.left && event.clientX<r.right && event.clientY>=r.top && event.clientY<r.bottom)) {
      show({type:'thread',id});break;
    }
  },{signal});
  const fallback=window.setTimeout(()=>{
    if (port) return;
    unavailable=true;
    frame.hidden=true;active=null;add.hidden=true;
    launcher.textContent='Use Chrome side panel';
    launcher.setAttribute('aria-label','Open Web Comments in the Chrome side panel');
    launcher.title='The comment card could not load on this page';
    drawSoon();
  },6500);
  selectionChanged();drawSoon();
  return ()=>{
    abort.abort();clearTimeout(fallback);clearTimeout(reindex);cancelAnimationFrame(raf);
    mutations.disconnect();size.disconnect();chrome.runtime.onConnect.removeListener(connected);
    port?.disconnect();CSS.highlights.delete(highlightName);CSS.highlights.delete(draftHighlight);host.remove();
  };
}
