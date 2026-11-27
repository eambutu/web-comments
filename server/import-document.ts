import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import ipaddr from 'ipaddr.js';

const maxBytes=24*1024*1024;
const maxHtml=3*1024*1024;
const htmlTags=new Set('article section div span p h1 h2 h3 h4 h5 h6 a blockquote ul ol li dl dt dd pre code strong em b i s del mark sub sup table thead tbody tfoot tr th td caption br hr figure figcaption details summary time'.split(' '));
const omitTags=new Set('script style noscript form svg math object template select button video audio'.split(' '));

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

async function publicResponse(url:URL,signal:AbortSignal) {
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
        'Accept':'text/html, application/pdf;q=0.9, text/plain;q=0.5, */*;q=0.1',
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

export function cleanArticle(source:string,url:URL) {
  const {document}=parseHTML(source.replaceAll('\u0000',''));
  // A few static publishers omit the surrounding HTML document.
  if (!document.documentElement || document.documentElement.tagName!=='HTML') {
    const wrapped=parseHTML('<!doctype html><html><head></head><body>'+source+'</body></html>');
    return renderArticle(wrapped.document,url);
  }
  return renderArticle(document,url);
}
function renderArticle(document:Document,url:URL) {
  if (!document.body || document.querySelectorAll('*').length>20000) {
    throw new ImportError('This page is too complex to import.');
  }
  const title=document.title.trim();
  let reader:ReturnType<Readability['parse']>=null;
  try {
    reader=new Readability(document.cloneNode(true) as Document,{maxElemsToParse:20000,keepClasses:false}).parse();
  } catch {
    // Keep a readable fallback for documents that Readability cannot classify.
  }
  const main=reader?.content
    ? parseHTML('<!doctype html><html><body>'+reader.content+'</body></html>').document.body
    : document.querySelector('main, [role="main"], article') ?? document.body;
  if (!reader?.content && main===document.body) {
    main.querySelectorAll('nav, footer, aside, [role="navigation"], [role="banner"]').forEach(node=>node.remove());
  }

  let incomplete=false;
  function serialize(node:Node,depth:number):string {
    if (depth>80) { incomplete=true;return ''; }
    if (node.nodeType===3) return escape(node.nodeValue ?? '');
    if (node.nodeType!==1) return '';
    const element=node as HTMLElement;
    const tag=element.localName.toLowerCase();
    if (omitTags.has(tag) || element.hasAttribute('hidden') || element.getAttribute('aria-hidden')==='true') return '';
    if (['iframe','frame','embed','canvas'].includes(tag)) { incomplete=true;return ''; }
    if (tag==='img') {
      const alt=element.getAttribute('alt')?.trim();
      return alt ? '<em>'+escape(alt.slice(0,500))+'</em>' : '';
    }
    const children=Array.from(element.childNodes,child=>serialize(child,depth+1)).join('');
    if (!htmlTags.has(tag)) return children;
    if (tag==='br' || tag==='hr') return '<'+tag+'>';
    if (tag==='a') {
      try {
        const link=new URL(element.getAttribute('href') ?? '',url);
        if (element.hasAttribute('href') && ['http:','https:'].includes(link.protocol) && !link.username && !link.password) {
          return '<a href="'+escape(link.href)+'" target="_blank" rel="noopener noreferrer">'+children+'</a>';
        }
      } catch {}
      return children;
    }
    return '<'+tag+'>'+children+'</'+tag+'>';
  }
  const html=Array.from(main.childNodes,node=>serialize(node,0)).join('');
  const text=parseHTML('<!doctype html><html><body>'+html+'</body></html>').document.body.textContent?.trim();
  if (!text || text.length<20) throw new ImportError('This page has no readable public text. Try a direct article or PDF link.');
  if (Buffer.byteLength(html)>750000) throw new ImportError('This HTML snapshot is too large to save.',413);
  return {
    kind:'html' as const,url:url.href,title:(reader?.title?.trim() || title || url.hostname).slice(0,350),
    html,complete:!incomplete,note:incomplete?'Some embedded or deeply nested content could not be captured.':'',
  };
}

export async function importDocument(input:string) {
  let url=importUrl(input);
  const signal=AbortSignal.timeout(25000);
  try {
    for (let hop=0;hop<=5;hop++) {
      const response=await publicResponse(url,signal);
      try {
        const status=response.statusCode ?? 0;
        if ([301,302,303,307,308].includes(status) && response.headers.location && hop<5) {
          url=importUrl(new URL(response.headers.location,url).href);
          continue;
        }
        if (status!==200) throw new ImportError('The source did not provide a public document (HTTP '+status+').');
        const contentType=(response.headers['content-type'] ?? '').toLowerCase().split(';')[0].trim();
        const encoding=response.headers['content-encoding']?.toLowerCase().trim() ?? 'identity';
        const decoder=encoding==='gzip'?createGunzip():
          encoding==='br'?createBrotliDecompress():
          encoding==='deflate'?createInflate():null;
        if (!decoder && encoding!=='identity') throw new ImportError('This source uses an unsupported compression format.');
        const limit=['text/html','application/xhtml+xml','text/plain'].includes(contentType) ? maxHtml : maxBytes;
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
        const body=Buffer.concat(chunks,bytes);
        if (body.subarray(0,1024).includes('%PDF-')) return {kind:'pdf' as const,url:url.href,body};
        if (contentType==='application/pdf') throw new ImportError('The source returned a damaged or unsupported PDF.');
        if (['text/html','application/xhtml+xml','text/plain'].includes(contentType) || (body[0]===60 && bytes<=maxHtml)) {
          if (contentType==='text/plain') return cleanArticle('<article><pre>'+escape(body.toString('utf8'))+'</pre></article>',url);
          const charset=response.headers['content-type']?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
          let decoder=new TextDecoder();
          try { if (charset) decoder=new TextDecoder(charset); } catch {}
          return cleanArticle(decoder.decode(body),url);
        }
        throw new ImportError('Use a public HTML page or a direct PDF link.');
      } finally {
        response.destroy();
      }
    }
  } catch (error) {
    if (error instanceof ImportError) throw error;
    if (signal.aborted) throw new ImportError('The source took too long to respond. Try again or use a direct link.',504);
    throw new ImportError('Could not reach the source. Check the link or try another public document.',502);
  }
  throw new ImportError('The source redirected too many times.');
}
