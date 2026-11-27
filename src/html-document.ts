import { locate, type Capture, type HTMLAnchor, type Thread } from './model';

type Span = {node:Text; start:number; end:number};
function collect(root:HTMLElement) {
  const spans:Span[] = [];
  const chunks:string[] = [];
  let offset = 0;
  let previousBlock:Element|null = null;
  let lineBreak = false;
  const issues = new Set<string>();
  const append = (text:string) => { chunks.push(text); offset += text.length; };
  function walk(node:Node, block:Element|null) {
    if (node instanceof Text) {
      if (!node.data.trim() && (!offset || block !== previousBlock || lineBreak)) return;
      if (!node.data.length) return;
      if (offset && (lineBreak || block !== previousBlock)) append('\n');
      const start = offset;
      append(node.data);
      spans.push({node,start,end:offset});
      previousBlock = block;
      lineBreak = false;
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.matches('script,style,noscript,template,svg,select,textarea,input,button,[hidden]')) return;
    const css = getComputedStyle(node);
    if (css.display === 'none' || css.visibility !== 'visible' || css.contentVisibility === 'hidden') return;
    if (node instanceof HTMLBRElement) { lineBreak = true; return; }
    if (node.matches('iframe,frame,object,embed,canvas')) {
      const box = node.getBoundingClientRect();
      if (box.width > 1 && box.height > 1) issues.add('Visible embedded frames or canvas content was omitted.');
      return;
    }
    if (node.shadowRoot) {
      issues.add('Shadow DOM content may be incomplete.');
      for (const child of node.shadowRoot.childNodes) walk(child,node);
      return;
    }
    if (node instanceof HTMLImageElement && node.alt) {
      // Alternate text preserves image descriptions in the saved text.
      append(`\n[Image: ${node.alt}]\n`);
    }
    const nextBlock = /^(block|list-item|table|flex|grid|flow-root)/.test(css.display) ? node : block;
    for (const child of node.childNodes) walk(child,nextBlock);
  }
  walk(root,null);
  const text = chunks.join('');
  if (!text.trim()) issues.add('No readable document text was found.');
  if (document.readyState !== 'complete') issues.add('The page was still loading.');
  const busySelector = root === document.body ? 'main [aria-busy="true"], main[aria-busy="true"]' : '[aria-busy="true"]';
  if (root.matches('[aria-busy="true"]') || root.querySelector(busySelector)) {
    issues.add('The document reports that content is still loading.');
  }
  return {text,spans,issues};
}

function currentAnchor(text:string, spans:Span[], range:Range|null):HTMLAnchor|null {
  if (!range || range.collapsed || !range.startContainer.isConnected || !range.endContainer.isConnected) return null;
  const selected = spans.filter(span => range.intersectsNode(span.node));
  if (!selected.length) return null;
  const first = selected[0], last = selected.at(-1)!;
  const start = first.start + (range.startContainer === first.node ? range.startOffset : 0);
  const end = range.endContainer === last.node ? last.start+range.endOffset : last.end;
  const exact = text.slice(start,end);
  if (!exact.trim() || exact.length > 6000) return null;
  return {kind:'html', exact,start,end,prefix:text.slice(Math.max(0,start-100),start),suffix:text.slice(end,end+100)};
}
function highlight(root:HTMLElement, threads:Thread[], focus?:string) {
  const {text,spans} = collect(root);
  const missing:string[] = [];
  const ranges:Range[] = [];
  for (const thread of threads) {
    if (thread.anchor.kind !== 'html') { missing.push(thread.id); continue; }
    const start = locate(text,thread.anchor);
    const end = start+thread.anchor.exact.length;
    const first = spans.find(span => span.start <= start && start < span.end);
    const last = spans.find(span => span.start < end && end <= span.end);
    if (!first || !last || first.node.getRootNode() !== last.node.getRootNode()) { missing.push(thread.id); continue; }
    const range = document.createRange();
    range.setStart(first.node,start-first.start);
    range.setEnd(last.node,end-last.start);
    ranges.push(range);
    if (thread.id === focus) first.node.parentElement?.scrollIntoView({block:'center',behavior:'smooth'});
  }
  CSS.highlights.set('web-comments',new Highlight(...ranges));
  return missing;
}
export function htmlDocument(root:HTMLElement, source:() => {url:string;title:string}) {
  let retained: {url:string;range:Range}|null = null;
  function selectedRange() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    return root.contains(range.startContainer) && root.contains(range.endContainer) ? range : null;
  }
  function rememberSelection() {
    const range = selectedRange();
    if (range && !range.collapsed) {
      retained = {url:source().url,range:range.cloneRange()};
    } else if (document.hasFocus() && (range || root === document.body)) {
      retained = null;
    }
  }
  document.addEventListener('selectionchange',rememberSelection);
  return {
    capture():Capture {
      const {text,spans,issues} = collect(root);
      const {url,title} = source();
      const selected = selectedRange();
      const range = selected && !selected.collapsed ? selected : retained?.url === url ? retained.range : null;
      return {url,title,text,kind:'html',complete:issues.size === 0,note:[...issues].join(' '),
        anchor:currentAnchor(text,spans,range)};
    },
    highlight:(threads:Thread[],focus?:string) => highlight(root,threads,focus),
    dispose:() => document.removeEventListener('selectionchange',rememberSelection),
  };
}
