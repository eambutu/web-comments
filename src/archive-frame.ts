import createDOMPurify from 'dompurify';
import type { ArticleArchive } from '../shared/article-archive';

export function mountArchive(frame:HTMLIFrameElement,archive:ArticleArchive) {
  const doc=frame.contentDocument;
  if (!doc?.defaultView || !frame.hasAttribute('sandbox') || frame.sandbox.contains('allow-scripts') ||
      (doc.location.pathname!=='/archive-frame' && doc.URL!=='about:srcdoc')) {
    throw Error('The saved layout frame is unavailable.');
  }
  const purifier=createDOMPurify(doc.defaultView);
  purifier.addHook('uponSanitizeAttribute',(node,event)=>{
    if (event.attrName==='src') {
      event.keepAttr=node.localName==='img' && /^data:image\/(?:jpeg|png|gif|webp|avif|svg\+xml);base64,/i.test(event.attrValue);
    } else if (node.localName==='use' && (event.attrName==='href' || event.attrName==='xlink:href')) {
      event.keepAttr=/^#[\w:.-]{1,255}$/.test(event.attrValue);
    } else if (event.attrName==='xlink:href') {
      event.keepAttr=event.attrValue.startsWith('#');
    } else if (event.attrName==='href') {
      event.keepAttr=event.attrValue.startsWith('#') || node.localName==='a' && /^https?:\/\//i.test(event.attrValue);
    }
  });
  purifier.addHook('afterSanitizeAttributes',node=>{
    if (node.localName==='a' && /^https?:\/\//i.test(node.getAttribute('href') ?? '')) {
      node.setAttribute('target','_blank');
      node.setAttribute('rel','noopener noreferrer');
    }
  });
  const html=purifier.sanitize(archive.html,{
    WHOLE_DOCUMENT:true,RETURN_DOM:true,
    ADD_TAGS:['use'],
    FORBID_TAGS:['script','noscript','iframe','frame','frameset','object','embed','base','meta','link',
      'form','input','textarea','select','button','video','audio','source','track','template','foreignobject',
      'animate','animatemotion','animatetransform','set'],
    FORBID_ATTR:['srcdoc','srcset','background','ping','download','autofocus','contenteditable','action','formaction'],
  });
  // Plot generators keep glyphs and markers in defs and draw them with local use elements.
  for (const svg of html.querySelectorAll('svg')) {
    const shapes=new Set(Array.from(svg.querySelectorAll('path[id],rect[id],circle[id],ellipse[id],line[id],polyline[id],polygon[id],g[id],symbol[id]'),
      shape=>shape.id));
    for (const use of svg.querySelectorAll('use')) {
      const ref=use.getAttribute('href') ?? use.getAttribute('xlink:href');
      if (!ref?.startsWith('#') || !shapes.has(ref.slice(1))) { use.remove();continue; }
      use.removeAttribute('xlink:href');
      use.setAttribute('href',ref);
    }
  }
  doc.replaceChild(doc.importNode(html,true),doc.documentElement);
  const style=doc.createElement('style');
  style.textContent='::highlight(web-comments) {background:#ffe18a;color:#222}';
  doc.head.append(style);

  function visit(event:MouseEvent) {
    const link=(event.target as Element|null)?.closest?.('a');
    const href=link?.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    event.preventDefault();
    if (event.isTrusted && (event.button===0 || event.button===1) && /^https?:\/\//i.test(href)) {
      window.open(href,'_blank','noopener,noreferrer');
    }
  }
  // Only the parent handles navigation. The frame cannot run scripts or open windows.
  doc.addEventListener('click',visit);
  doc.addEventListener('auxclick',visit);
  return doc.body;
}
