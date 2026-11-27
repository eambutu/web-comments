import { escapeArticleText, type ArticleMode } from '../shared/article-mode';
import { bundleArticle } from './article-archive';
import { cleanArticle } from './article-reader';
import { download, ImportError, importUrl, loadPublicAssets, type LoadAsset } from './public-document';

export { ImportError, importUrl, isPublicAddress } from './public-document';
export { cleanArticle } from './article-reader';

const maxBytes=24*1024*1024;
const maxHtml=3*1024*1024;

// These transforms take the same source and public asset loader. Neither consumes
// the other's output. In comparison mode a failure leaves the other result usable.
export async function articleSnapshots(source:string,url:URL,load:LoadAsset,mode:ArticleMode) {
  let reader:Awaited<ReturnType<typeof cleanArticle>>|undefined;
  let readerError:unknown;
  if (mode!=='archive') {
    try { reader=await cleanArticle(source,url,async asset=>(await load(asset,'image'))?.body ?? null); }
    catch (error) { if (mode==='reader') throw error;readerError=error; }
  }
  const archive=mode==='reader'?null:await bundleArticle(source,url,load,!reader).catch(()=>null);
  if (reader) return {...reader,archive:archive?.bundle ?? null};
  if (!archive?.textFallback) throw readerError ?? new ImportError('This page could not be saved in its original layout.');
  return {kind:'html' as const,url:url.href,title:archive.title,html:archive.textFallback,
    complete:!archive.note,note:archive.note,archive:archive.bundle};
}

const htmlContentTypes=['text/html','application/xhtml+xml','text/plain'];
export async function importDocument(input:string,mode:ArticleMode='reader') {
  const url=importUrl(input);
  const signal=AbortSignal.timeout(25000);
  try {
    const {url:source,body,contentType,charset}=await download(url,signal,
      'text/html, application/pdf;q=0.9, text/plain;q=0.5, */*;q=0.1',
      type=>htmlContentTypes.includes(type)?maxHtml:maxBytes);
    if (body.subarray(0,1024).includes('%PDF-')) return {kind:'pdf' as const,url:source.href,body};
    if (contentType==='application/pdf') throw new ImportError('The source returned a damaged or unsupported PDF.');
    if (htmlContentTypes.includes(contentType) || (body[0]===60 && body.length<=maxHtml)) {
      let decoder=new TextDecoder();
      try { if (charset) decoder=new TextDecoder(charset); } catch {}
      const assetSignal=AbortSignal.any([signal,AbortSignal.timeout(mode==='reader'?8500:16000)]);
      const raw=decoder.decode(body);
      const markup=contentType==='text/plain'?'<article><pre>'+escapeArticleText(raw)+'</pre></article>':raw;
      return await articleSnapshots(markup,source,loadPublicAssets(assetSignal),mode);
    }
    throw new ImportError('Use a public HTML page or a direct PDF link.');
  } catch (error) {
    if (error instanceof ImportError) throw error;
    if (signal.aborted) throw new ImportError('The source took too long to respond. Try again or use a direct link.',504);
    throw new ImportError('Could not reach the source. Check the link or try another public document.',502);
  }
}
