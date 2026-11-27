import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import ipaddr from 'ipaddr.js';
import { articleTags } from '../shared/article-html';
import { articleLayout } from './article-layout';
import { articleImageData, inlineSvg, maxArticleImageBytes } from './article-image';
import { bundleArticle, type LoadAsset, type AssetKind, type ArchiveAsset } from './article-archive';
import type { ArticleArchive } from '../shared/article-archive';

const maxBytes=24*1024*1024;
const maxHtml=3*1024*1024;
const maxSnapshotBytes=750000;
const htmlTags=new Set(articleTags);
const omitTags='script,style,noscript,form,math,template,select,button,[hidden],[aria-hidden="true"]';
const embeds=new Set(['iframe','frame','embed','object','canvas','video','audio']);
const maxArticleImages=20;
const imageContentType=/^image\/(?:avif|gif|jpeg|png|webp)$/i;

export class ImportError extends Error {
  constructor(message:string,readonly status=422) { super(message); }
}

export function importUrl(value:string) {
  try {
    const url=new URL(value);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.port || url.href.length>2048) throw Error();
    url.hash='';
    return url;
  } catch {
    throw new ImportError('Enter a public http:// or https:// article or PDF link.',400);
  }
}

export function isPublicAddress(address:string) {
  if (!ipaddr.isValid(address)) return false;
  const ip=ipaddr.process(address);
  return ip.range()==='unicast' &&
    (ip.kind()==='ipv4' || (ip as ipaddr.IPv6).match(ipaddr.IPv6.parse('2000::'),3));
}

async function awaitLookup(host:string,signal:AbortSignal) {
  signal.throwIfAborted();
  return new Promise<Awaited<ReturnType<typeof lookupForImport>>>((resolve,reject)=>{
    const onAbort=()=>reject(signal.reason);
    signal.addEventListener('abort',onAbort,{once:true});
    void lookupForImport(host).then(resolve,reject).finally(()=>signal.removeEventListener('abort',onAbort));
  });
}
function lookupForImport(host:string) {
  return lookup(host,{all:true,verbatim:true});
}

async function publicResponse(url:URL,signal:AbortSignal,accept:string) {
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const addresses=await awaitLookup(host,signal);
  if (!addresses.length || addresses.some(record=>!isPublicAddress(record.address))) {
    throw new ImportError('This address is unavailable for public imports.',400);
  }
  // Pin the validated address for this connection, including on redirects.
  const address=addresses.find(record=>record.family===4) ?? addresses[0];
  const request=url.protocol==='https:'?httpsRequest:httpRequest;
  return new Promise<IncomingMessage>((resolve,reject)=>{
    const query=request(url,{
      signal,agent:false,family:address.family,
      lookup:(_host,_options,callback)=>callback(null,address.address,address.family),
      headers:{
        'User-Agent':'WebComments/1.0 (public document importer)',
        'Accept':accept,
        'Accept-Encoding':'identity',
      },
    },resolve);
    query.on('error',reject);
    query.end();
  });
}

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
type Download={url:URL;contentType:string;charset:string|undefined;body:Buffer};

async function download(
  url:URL,signal:AbortSignal,accept:string,maxSize:(contentType:string)=>number,
):Promise<Download> {
  for (let hop=0;hop<=5;hop++) {
    const response=await publicResponse(url,signal,accept);
    try {
      const status=response.statusCode ?? 0;
      if ([301,302,303,307,308].includes(status) && response.headers.location) {
        url=importUrl(new URL(response.headers.location,url).href);
        continue;
      }
      if (status!==200) throw new ImportError('The source did not provide a public document (HTTP '+status+').');
      const type=response.headers['content-type'] ?? '';
      const contentType=type.toLowerCase().split(';')[0].trim();
      const limit=maxSize(contentType);
      const encoding=response.headers['content-encoding']?.toLowerCase().trim() ?? 'identity';
      const decoder=encoding==='gzip'?createGunzip():
        encoding==='br'?createBrotliDecompress():
        encoding==='deflate'?createInflate():null;
      if (!decoder && encoding!=='identity') throw new ImportError('This source uses an unsupported compression format.');
      if (Number(response.headers['content-length'])>limit) throw new ImportError('This document is too large to import.',413);
      if (decoder) response.on('error',error=>decoder.destroy(error));
      const stream=decoder?response.pipe(decoder):response;
      const chunks:Buffer[]=[];
      let bytes=0;
      for await (const chunk of stream) {
        bytes+=chunk.length;
        if (bytes>limit) throw new ImportError('This document is too large to import.',413);
        chunks.push(chunk);
      }
      return {url,contentType,charset:type.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1],body:Buffer.concat(chunks,bytes)};
    } finally {
      response.destroy();
    }
  }
  throw new ImportError('The source redirected too many times.');
}

const acceptAsset:Record<AssetKind,string>={
  image:'image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml',
  style:'text/css',
  font:'font/woff2,font/woff,font/ttf,font/otf,application/octet-stream;q=0.5',
};

function loadPublicAssets(signal:AbortSignal):LoadAsset {
  let total=0;
  let accounted=Promise.resolve();
  const cached=new Map<string,Promise<ArchiveAsset|null>>();
  return async (url,kind)=>{
    const key=kind+' '+url.href;
    let item=cached.get(key);
    if (!item && cached.size<80 && total<16*1024*1024 && !signal.aborted) {
      const pending=download(importUrl(url.href),signal,acceptAsset[kind],type=>{
        if ((kind==='image' && !imageContentType.test(type) && type!=='image/svg+xml') || (kind==='style' && type!=='text/css') ||
            (kind==='font' && !/^(font\/|application\/(?:font|x-font|octet-stream|vnd\.ms-fontobject))/.test(type))) {
          throw new ImportError('Unsupported article asset.');
        }
        return kind==='image'?maxArticleImageBytes:kind==='style'?512000:1024*1024;
      }).catch(()=>null);
      // Downloads run concurrently. Assign the budget in request order so slow
      // figures have the same priority across repeated captures.
      item=accounted.then(async ()=>{
        const asset=await pending;
        if (!asset) return null;
        total+=asset.body.length;
        return total<=16*1024*1024?asset:null;
      });
      accounted=item.then(()=>{});
      cached.set(key,item);
    }
    return await item ?? null;
  };
}

export async function articleSnapshots(source:string,url:URL,load:LoadAsset,includeArchive:boolean) {
  const reader=await cleanArticle(source,url,async asset=>(await load(asset,'image'))?.body ?? null);
  let archive:ArticleArchive|null=null;
  // Optional archive assets and malformed publisher CSS must not suppress a usable reader.
  if (includeArchive) archive=await bundleArticle(source,url,load).catch(()=>null);
  return {...reader,archive};
}

const htmlContentTypes=['text/html','application/xhtml+xml','text/plain'];
export async function importDocument(input:string,includeArchive=false) {
  const url=importUrl(input);
  const signal=AbortSignal.timeout(25000);
  try {
    const {url:source,body,contentType,charset}=await download(url,signal,
      'text/html, application/pdf;q=0.9, text/plain;q=0.5, */*;q=0.1',
      type=>htmlContentTypes.includes(type)?maxHtml:maxBytes);
    if (body.subarray(0,1024).includes('%PDF-')) return {kind:'pdf' as const,url:source.href,body};
    if (contentType==='application/pdf') throw new ImportError('The source returned a damaged or unsupported PDF.');
    if (htmlContentTypes.includes(contentType) || (body[0]===60 && body.length<=maxHtml)) {
      if (contentType==='text/plain') return {...await cleanArticle('<article><pre>'+escape(body.toString('utf8'))+'</pre></article>',source),archive:null};
      let decoder=new TextDecoder();
      try { if (charset) decoder=new TextDecoder(charset); } catch {}
      const assetSignal=AbortSignal.any([signal,AbortSignal.timeout(includeArchive?16000:8500)]);
      return await articleSnapshots(decoder.decode(body),source,loadPublicAssets(assetSignal),includeArchive);
    }
    throw new ImportError('Use a public HTML page or a direct PDF link.');
  } catch (error) {
    if (error instanceof ImportError) throw error;
    if (signal.aborted) throw new ImportError('The source took too long to respond. Try again or use a direct link.',504);
    throw new ImportError('Could not reach the source. Check the link or try another public document.',502);
  }
}
