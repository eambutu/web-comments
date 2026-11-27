import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { articleTags } from '../shared/article-html';
import { articleLayout } from './article-layout';
import { articleImageData } from './reader-image';
import { inlineSvg } from './article-image';
import { ImportError } from './public-document';

const maxSnapshotBytes=750000;
const htmlTags=new Set(articleTags);
const omitTags='script,style,noscript,form,math,template,select,button,[hidden],[aria-hidden="true"]';
const embeds=new Set(['iframe','frame','embed','object','canvas','video','audio']);
const maxArticleImages=20;

const escape=(plain:string)=>plain.replace(/[&<>"']/g,char=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
}[char] ?? char));

type LoadImage=(url:URL)=>Promise<Buffer|null>;
type ImageAsset={source:URL|Buffer;alt:string;attributes:string;fallback:string};

function publicLink(value:string|null,url:URL) {
  if (!value?.trim()) return null;
  try {
    const link=new URL(value,url);
    if (['http:','https:'].includes(link.protocol) && !link.username && !link.password &&
        link.href.length<=2048) return link;
  } catch {}
  return null;
}

function structuralAttributes(element:Element,tag:string) {
  const attrs:Record<string,RegExp>={
    ...(tag==='ol'?{start:/^-?\d{1,9}$/,type:/^[1aAiI]$/}:{}),
    ...(tag==='li'?{value:/^-?\d{1,9}$/}:{}),
    ...(['td','th'].includes(tag)?{colspan:/^\d{1,3}$/,rowspan:/^\d{1,3}$/}:{}),
    ...(tag==='th'?{scope:/^(?:row|col|rowgroup|colgroup)$/}:{}),
    ...(['a','abbr'].includes(tag)?{title:/^[\s\S]{1,250}$/}:{}),
  };
  return Object.entries(attrs).map(([name,allowed])=>{
    const value=element.getAttribute(name);
    return value && allowed.test(value)?' '+name+'="'+escape(value)+'"':'';
  }).join('')+
    (tag==='ol' && element.hasAttribute('reversed')?' reversed':'')+
    (tag==='details' && element.hasAttribute('open')?' open':'');
}

export async function cleanArticle(source:string,url:URL,loadImage?:LoadImage) {
  const html=source.replaceAll('\u0000','');
  const {document}=parseHTML(html);
  // A few static publishers omit the surrounding HTML document.
  const parsed=document.documentElement?.tagName==='HTML'?document:
    parseHTML('<!doctype html><html><head></head><body>'+html+'</body></html>').document;
  if (!parsed.body || parsed.querySelectorAll('*').length>20000) {
    throw new ImportError('This page is too complex to import.');
  }

  const base=publicLink(parsed.querySelector('base[href]')?.getAttribute('href') ?? null,url) ?? url;
  const title=parsed.title.trim();
  const semantic=parsed.querySelector('main article, [role="main"] article') ??
    parsed.querySelector('main, [role="main"], article');
  const conventional=Array.from(parsed.querySelectorAll('[itemprop~="articleBody"],.post,.article-content,.entry-content,.post-content'))
    .filter(node=>node.querySelector('h1,h2') && node.querySelectorAll('p').length>=3)
    .sort((left,right)=>(right.textContent?.length ?? 0)-(left.textContent?.length ?? 0))[0];
  const structured=semantic?.textContent?.trim()?semantic:conventional;
  let reader:ReturnType<Readability['parse']>=null;
  if (!structured) {
    try {
      reader=new Readability(parsed.cloneNode(true) as Document,{maxElemsToParse:20000,keepClasses:true}).parse();
    } catch {
      // Keep a readable fallback for documents that Readability cannot classify.
    }
  }
  const main=reader?.content
    ? parseHTML('<!doctype html><html><body>'+reader.content+'</body></html>').document.body
    : structured ?? parsed.body;
  const navigation=main===parsed.body ? 'nav, footer, aside, [role="navigation"], [role="banner"]' : 'nav, [role="navigation"]';
  main.querySelectorAll(navigation).forEach(node=>node.remove());
  const layout=articleLayout(parsed,main);
  const targets=new Map<string,string>();
  const ids=new Map<Element,string>();
  for (const element of [main,...main.querySelectorAll('[id], a[name]')]) {
    if (element.closest(omitTags+',svg *') || !htmlTags.has(element.localName) && element.localName!=='main') continue;
    const original=element.getAttribute('id') || element.getAttribute('name');
    if (!original || original.length>150 || targets.has(original)) continue;
    const id='wc-snapshot-'+Buffer.from(original).toString('base64url');
    if (id.length>'wc-snapshot-'.length+400) continue;
    targets.set(original,id);
    ids.set(element,id);
  }

  const pieces:(string|ImageAsset)[]=[];
  const issues=new Set<string>();
  let imageCount=0;
  function addImage(input:URL|Buffer|null,alt:string,attributes:string) {
    const fallback=alt?'<em'+attributes+'>'+escape(alt)+'</em>':attributes?'<span'+attributes+'></span>':'';
    if (!input || imageCount>=maxArticleImages) {
      pieces.push(fallback);
      issues.add('Some images could not be saved.');
      return;
    }
    imageCount++;
    pieces.push({source:input,alt,attributes,fallback});
  }
  function serialize(node:Node,depth:number) {
    if (depth>80) { issues.add('Some deeply nested content could not be captured.');return; }
    if (node.nodeType===3) { pieces.push(escape(node.nodeValue ?? ''));return; }
    if (node.nodeType!==1) return;
    const element=node as Element;
    const tag=element.localName==='main' || element===main && element.localName==='body'?'section':element.localName;
    if (element.matches(omitTags)) return;

    const id=ids.get(element);
    const classes=layout(element);
    const attributes=(id?' id="'+id+'"':'')+(classes?' class="'+classes+'"':'');
    if (tag==='img') {
      const srcset=element.getAttribute('data-srcset') ?? element.getAttribute('srcset');
      const src=[element.getAttribute('data-src'),element.getAttribute('data-original'),element.getAttribute('src'),
        srcset?.split(',')[0]?.trim().split(/\s+/)[0] ?? null].map(value=>publicLink(value,base)).find(Boolean);
      addImage(src ?? null,element.getAttribute('alt')?.trim().slice(0,500) ?? '',attributes);
      return;
    }
    if (tag==='svg') {
      const alt=element.getAttribute('aria-label') ?? element.querySelector('title')?.textContent ?? '';
      addImage(inlineSvg(element),alt.trim().slice(0,500),attributes);
      return;
    }
    if (embeds.has(tag)) {
      issues.add('Embedded media can be opened on the original page.');
      const figure=element.closest('figure[id]');
      const link=new URL(url);
      link.hash=figure?.getAttribute('id') ?? '';
      pieces.push('<a href="'+escape(link.href)+'" target="_blank" rel="noopener noreferrer">Open '+(tag==='audio'||tag==='video'?tag:'embed')+' on original page</a>');
      return;
    }

    const attrs=htmlTags.has(tag)?attributes+structuralAttributes(element,tag):'';
    let opening=htmlTags.has(tag)?'<'+tag+attrs+'>':'';
    if (tag==='a') {
      const value=element.getAttribute('href');
      const link=publicLink(value,base);
      let localId:string|undefined;
      if (link?.hash && (value?.startsWith('#') || link.origin===url.origin &&
          link.pathname===url.pathname && link.search===url.search)) {
        try { localId=targets.get(decodeURIComponent(link.hash.slice(1))); } catch {}
      }
      if (localId) opening='<a'+attrs+' href="#'+localId+'">';
      else if (link) opening='<a'+attrs+' href="'+escape(link.href)+
        '" target="_blank" rel="noopener noreferrer">';
      else if (!id) opening='';
    }
    if (opening) pieces.push(opening);
    if (tag==='br' || tag==='hr') return;
    for (const child of element.childNodes) serialize(child,depth+1);
    if (opening) pieces.push('</'+tag+'>');
  }
  serialize(main,0);
  const textHtml=pieces.map(piece=>typeof piece==='string'?piece:piece.fallback).join('');
  const text=parseHTML('<!doctype html><html><body>'+textHtml+'</body></html>').document.body.textContent?.trim();
  if (!text || text.length<20) throw new ImportError('This page has no readable public text. Try a direct article or PDF link.');
  let remaining=maxSnapshotBytes-Buffer.byteLength(textHtml);
  if (remaining<0) throw new ImportError('This HTML snapshot is too large to save.',413);

  const assets=pieces.filter((piece):piece is ImageAsset=>typeof piece!=='string');
  const images=new Map<ImageAsset,string>();
  const fetched=new Map<string,Promise<string|null>>();
  // Keep conversion bounded while applying the byte budget in document order.
  for (let index=0;index<assets.length;index+=3) {
    const batch=assets.slice(index,index+3);
    const encoded=await Promise.all(batch.map(async ({source})=>{
      if (Buffer.isBuffer(source)) return articleImageData(source,true);
      if (!loadImage) return null;
      let pending=fetched.get(source.href);
      if (!pending) {
        pending=loadImage(source).then(bytes=>bytes?articleImageData(bytes):null).catch(()=>null);
        fetched.set(source.href,pending);
      }
      return pending;
    }));
    for (const [i,asset] of batch.entries()) {
      const data=encoded[i];
      const markup=data?'<img'+asset.attributes+' src="'+data+'" alt="'+escape(asset.alt)+'">':'';
      const cost=Buffer.byteLength(markup)-Buffer.byteLength(asset.fallback);
      if (markup && cost<=remaining) {
        images.set(asset,markup);
        remaining-=cost;
      } else issues.add('Some images could not be saved.');
    }
  }
  return {
    kind:'html' as const,url:url.href,title:(main.querySelector('h1')?.textContent?.trim() ||
      reader?.title?.trim() || title || url.hostname).slice(0,350),
    html:pieces.map(piece=>typeof piece==='string'?piece:images.get(piece) ?? piece.fallback).join(''),
    complete:!issues.size,note:Array.from(issues).join(' '),
  };
}
