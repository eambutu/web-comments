import { parseHTML } from 'linkedom';
import postcss, { type AtRule, type Declaration } from 'postcss';
import valueParser from 'postcss-value-parser';
import { maxArchiveBytes, type ArticleArchive } from '../shared/article-archive';
import { plainArticleHtml } from '../shared/article-mode';
import { inlineSvg, rasterMime } from './article-image';
import type { AssetKind, LoadAsset, ArticleAsset } from './public-document';

function webUrl(value:string|null,base:URL) {
  if (!value?.trim()) return null;
  try {
    const url=new URL(value,base);
    if (['http:','https:'].includes(url.protocol) && !url.username && !url.password &&
        !url.port && url.href.length<=2048) return url;
  } catch {}
  return null;
}

function fontMime(bytes:Buffer) {
  const magic=bytes.toString('ascii',0,4);
  if (magic==='wOFF') return 'font/woff';
  if (magic==='wOF2') return 'font/woff2';
  if (magic==='OTTO') return 'font/otf';
  return bytes.readUInt32BE(0)===0x00010000?'font/ttf':null;
}

// Preserve the publisher's DOM and CSS. The archive frame enforces its own CSP and
// sanitizes this representation again, including when it comes from private Storage.
export async function bundleArticle(source:string,address:URL,load:LoadAsset,wantTextFallback:boolean) {
  let {document}=parseHTML(source);
  if (document.documentElement?.localName!=='html') {
    document=parseHTML('<html><head></head><body>'+source+'</body></html>').document;
  }
  if (document.querySelectorAll('*').length>20000) return null;
  const title=(document.querySelector('h1')?.textContent?.trim() || document.title?.trim() || address.hostname).slice(0,350);
  const omittedMedia=!!document.querySelector('video,audio,canvas,iframe,frame,object,embed');
  const base=webUrl(document.querySelector('base[href]')?.getAttribute('href') ?? null,address) ?? address;
  const missing=new Set<string>();
  const resources=new Map<string,Promise<ArticleAsset|null>>();
  let encodedBytes=0;
  async function resource(url:URL,kind:AssetKind) {
    url=new URL(url);
    url.hash='';
    const key=kind+' '+url.href;
    let pending=resources.get(key);
    if (!pending && resources.size<80) {
      pending=load(url,kind).catch(()=>null);
      resources.set(key,pending);
    }
    const result=await pending;
    if (!result) missing.add(url.href);
    return result;
  }
  async function dataUrl(raw:string,baseUrl:URL,kind:'font'|'image') {
    // Existing inline data is already offline. Keep only static resource types here.
    if ((kind==='image' && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[\da-z+/=\s]+$/i.test(raw)) ||
        (kind==='font' && /^data:font\/(?:woff2?|[ot]tf);base64,[\da-z+/=\s]+$/i.test(raw))) return raw;
    const url=webUrl(raw,baseUrl);
    if (!url) return null;
    const asset=await resource(url,kind);
    if (!asset) return null;
    let bytes=asset.body;
    let mime=kind==='image'?rasterMime(bytes):bytes.length>=4?fontMime(bytes):null;
    if (!mime && kind==='image' && asset.contentType==='image/svg+xml' && bytes.length<=480000) {
      const svg=parseHTML(bytes.toString('utf8')).document.documentElement;
      const staticSvg=svg?.localName==='svg' && inlineSvg(svg);
      if (staticSvg) { bytes=staticSvg;mime='image/svg+xml'; }
    }
    const size=4*Math.ceil(bytes.length/3);
    if (!mime || encodedBytes+size>maxArchiveBytes-source.length) {
      missing.add(url.href);
      return null;
    }
    encodedBytes+=size;
    return 'data:'+mime+';base64,'+bytes.toString('base64');
  }

  async function cssValue(declaration:Declaration,baseUrl:URL) {
    if (!/url\s*\(/i.test(declaration.value)) return;
    const value=valueParser(declaration.value);
    const urls:valueParser.FunctionNode[]=[];
    value.walk(node=>{
      if (node.type==='function' && node.value.toLowerCase()==='url') {
        urls.push(node);
        return false;
      }
    });
    const isFont=declaration.prop.toLowerCase()==='src' && declaration.parent?.type==='atrule' &&
      declaration.parent.name.toLowerCase()==='font-face';
    for (const node of urls) {
      const raw=node.nodes[0]?.type==='string'?node.nodes[0].value:valueParser.stringify(node.nodes).trim();
      if (raw.startsWith('#')) continue;
      if (isFont) {
        // A font face needs one usable source. Reserve space for other families and figures.
        const data=await dataUrl(raw,baseUrl,'font');
        if (data) { declaration.value='url("'+data+'")';return; }
        continue;
      }
      // An empty CSS URL represents a missing image/font without contacting an origin.
      const data=await dataUrl(raw,baseUrl,'image');
      node.nodes=[{type:'string',quote:'"',value:data ?? '',sourceIndex:0,sourceEndIndex:0}];
    }
    if (isFont) declaration.remove();
    else declaration.value=value.toString();
  }

  async function sheet(css:string,baseUrl:URL,ancestors:Set<string>):Promise<string> {
    if (css.length>512000) { missing.add(baseUrl.href);return ''; }
    let root;
    try { root=postcss.parse(css); } catch { missing.add(baseUrl.href);return ''; }
    const declarations:Declaration[]=[];
    const imports:AtRule[]=[];
    root.walkDecls(decl=>{ declarations.push(decl); });
    root.walkAtRules(/^import$/i,rule=>{ imports.push(rule); });
    for (const decl of declarations) await cssValue(decl,baseUrl);
    for (const rule of imports) {
      const parsed=valueParser(rule.params).nodes;
      const first=parsed[0];
      const raw=first?.type==='string'?first.value:first?.type==='function' && first.value.toLowerCase()==='url'?
        first.nodes[0]?.value:null;
      const url=webUrl(raw ?? null,baseUrl);
      if (url && !ancestors.has(url.href) && ancestors.size<4) {
        const asset=await resource(url,'style');
        if (asset) {
          const nested=await sheet(asset.body.toString('utf8'),asset.url,new Set([...ancestors,url.href]));
          const media=valueParser.stringify(parsed.slice(1)).trim();
          if (nested) {
            if (media) {
              const wrapper=postcss.atRule({name:'media',params:media});
              wrapper.append(postcss.parse(nested).nodes);
              rule.replaceWith(wrapper);
            } else rule.replaceWith(...postcss.parse(nested).nodes);
            continue;
          }
        }
      }
      rule.remove();
    }
    // Style is serialized as HTML raw text. Escaping the less-than character in
    // CSS prevents a string or comment from closing the style element.
    return root.toString().replaceAll('<','\\3c ');
  }

  document.querySelectorAll('script,noscript,iframe,frame,frameset,object,embed,portal,base,meta,template,foreignObject,animate,animateMotion,animateTransform,set,form,input,select,textarea,button').forEach(node=>node.remove());
  for (const media of document.querySelectorAll('video,audio,canvas')) {
    const poster=media.getAttribute('poster');
    if (poster) {
      const image=document.createElement('img');
      for (const attr of ['style','class','id','width','height']) {
        if (media.hasAttribute(attr)) image.setAttribute(attr,media.getAttribute(attr)!);
      }
      image.setAttribute('src',poster);
      image.setAttribute('alt',media.getAttribute('aria-label') ?? 'Video poster');
      media.replaceWith(image);
    } else media.remove();
  }
  let textFallback:string|null=null;
  if (wantTextFallback) {
    // Capture plain text before inlining binary assets. Historical clients can
    // open this as HTML when this is the document's only saved representation.
    const body=document.body.cloneNode(true) as HTMLElement;
    body.querySelectorAll('style,svg,template,[hidden]').forEach(node=>node.remove());
    const text=body.innerText.trim();
    if (!text && !body.querySelector('img')) return null;
    textFallback=plainArticleHtml(text);
  }
  const images=new Map<Element,string>();
  for (const element of document.querySelectorAll('*')) {
    if (element.localName==='img') {
      const srcset=element.getAttribute('data-srcset') || element.getAttribute('srcset') ||
        element.closest('picture')?.querySelector('source')?.getAttribute('srcset');
      const raw=element.getAttribute('data-src') || element.getAttribute('data-original') ||
        element.getAttribute('src') || srcset?.split(',')[0]?.trim().split(/\s+/)[0];
      if (raw) images.set(element,raw);
    }
  }
  for (const element of document.querySelectorAll('*')) {
    for (const {name} of Array.from(element.attributes)) {
      if (/^on/i.test(name) || ['target','ping','download','autofocus','contenteditable','srcdoc','srcset','action','formaction','manifest','background','nonce','integrity'].includes(name)) {
        element.removeAttribute(name);
      }
    }
    if (element.localName==='a' || element.localName==='area') {
      const raw=element.getAttribute('href') ?? element.getAttribute('xlink:href');
      element.removeAttribute('xlink:href');
      const url=webUrl(raw,base);
      if (raw?.startsWith('#')) element.setAttribute('href',raw);
      else if (url) {
        const local=url.origin===address.origin && url.pathname===address.pathname && url.search===address.search && url.hash;
        element.setAttribute('href',local?url.hash:url.href);
        if (!local) {
          element.setAttribute('target','_blank');
          element.setAttribute('rel','noopener noreferrer');
        }
      } else element.removeAttribute('href');
    }
  }
  // Fetch article figures first so optional font variants cannot exhaust the budget.
  const figures=Array.from(images);
  for (let index=0;index<figures.length;index+=4) {
    const batch=figures.slice(index,index+4);
    await Promise.all(batch.map(([,raw])=>{
      const url=webUrl(raw,base);
      return url?resource(url,'image'):null;
    }));
    // Apply the byte budget in DOM order even when downloads finish out of order.
    for (const [image,raw] of batch) {
      const data=await dataUrl(raw,base,'image');
      image.removeAttribute('loading');
      if (data) image.setAttribute('src',data);
      else image.removeAttribute('src');
    }
  }
  document.querySelectorAll('source,track').forEach(node=>node.remove());
  // Replace each sheet in place to keep CSS cascade order. Resolve inline author fonts first.
  for (const node of [...document.querySelectorAll('style'),...document.querySelectorAll('link')]) {
    let css='',cssBase=base;
    if (node.localName==='link') {
      const url=webUrl(node.getAttribute('href'),base);
      const rel=node.getAttribute('rel')?.toLowerCase().split(/\s+/) ?? [];
      if (!url || !rel.includes('stylesheet') || rel.includes('alternate') ||
          node.hasAttribute('disabled')) { node.remove();continue; }
      const asset=await resource(url,'style');
      if (!asset) { node.remove();continue; }
      css=asset.body.toString('utf8');cssBase=asset.url;
    } else css=node.textContent ?? '';
    const style=document.createElement('style');
    const media=node.getAttribute('media');
    if (media) style.setAttribute('media',media);
    style.textContent=await sheet(css,cssBase,new Set([cssBase.href]));
    node.replaceWith(style);
  }
  for (const node of document.querySelectorAll('[style]')) {
    const css=node.getAttribute('style')!;
    if (!/url\s*\(/i.test(css) || /^\s*[\w-]+\s*:\s*url\(#[\w.-]+\)\s*;?\s*$/.test(css)) continue;
    try {
      const rule=postcss.parse('x{'+css+'}').first;
      if (rule?.type!=='rule') { node.removeAttribute('style');continue; }
      for (const decl of rule.nodes) if (decl.type==='decl') await cssValue(decl,base);
      node.setAttribute('style',rule.nodes.filter(decl=>decl.type==='decl').map(decl=>decl.toString()).join(';'));
    } catch { node.removeAttribute('style'); }
  }
  const html='<!doctype html>'+document.documentElement.outerHTML;
  if (Buffer.byteLength(html)>maxArchiveBytes) return null;
  const note=[omittedMedia?'Embedded media can be opened on the original page.':'',
    missing.size?'Some source assets could not be saved.':''].filter(Boolean).join(' ');
  const bundle:ArticleArchive={version:1,html,missingAssets:missing.size};
  return {bundle,title,note,textFallback};
}
