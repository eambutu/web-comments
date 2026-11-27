import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import ipaddr from 'ipaddr.js';
import { maxArticleImageBytes } from './article-image';

export type AssetKind='image'|'style'|'font';
export type ArticleAsset={body:Buffer;url:URL;contentType:string};
export type LoadAsset=(url:URL,kind:AssetKind)=>Promise<ArticleAsset|null>;
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

type Download={url:URL;contentType:string;charset:string|undefined;body:Buffer};

export async function download(
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

export function loadPublicAssets(signal:AbortSignal):LoadAsset {
  let total=0;
  let accounted=Promise.resolve();
  const cached=new Map<string,Promise<ArticleAsset|null>>();
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
