import type { SupabaseClient } from '@supabase/supabase-js';
import { plainArticleHtml, plainArticlePrefix, type ArticleMode } from '../shared/article-mode';
import { isArticleArchive } from '../shared/article-archive';
import { sanitizeArticle } from './article-sanitizer';
import { loadArchive, prepareArchive, storeArchive, type SavedArchive } from './archive-storage';
import { saveCapture } from './client';
import type { SavedPage } from './comment-store';
import { captureFingerprint, hash, type Capture } from './model';

export type Entry = {
  id:string;title:string;source:string;kind:'html'|'pdf';importedAt:string;
};
type SavedArticle={
  page:SavedPage;contentHash:string;fingerprint:string;text:()=>Promise<string>;
};
export type Snapshot = {
  title:string;source:string;
} & (
  {kind:'html';html:string;hasReader:boolean;complete:boolean;note:string;
    archive?:SavedArchive;archiveError?:string;saved?:SavedArticle}
  | {kind:'pdf';bytes:Blob;path?:string}
);

type Version={
  title:string;kind:Entry['kind'];complete:boolean;extraction_note:string;pdf_path:string|null;
  fingerprint:string;content_hash:string;inline_text:string|null;text_path:string|null;
};
type JoinedEntry={
  page_id:string;version_id:string;imported_at:string;owner:string;
  wc_pages:{source_url:string};wc_versions:Version;snapshot_html:string|null;
};

export async function listLibrary(db:SupabaseClient, owner:string) {
  const items:Entry[]=[];
  for (let offset=0; ; offset+=500) {
    const {data,error}=await db.from('wc_library').select('page_id,imported_at,wc_pages!inner(source_url),wc_versions!inner(title,kind)').eq('owner',owner)
      .order('imported_at',{ascending:false}).order('page_id').range(offset,offset+499);
    if (error) throw error;
    for (const row of data as unknown as JoinedEntry[]) {
      items.push({id:row.page_id,source:row.wc_pages.source_url,title:row.wc_versions.title,
        kind:row.wc_versions.kind,importedAt:row.imported_at});
    }
    if (data.length<500) return items;
  }
}

export async function removeLibraryEntry(db:SupabaseClient,owner:string,id:string) {
  const {error}=await db.from('wc_library').delete().eq('owner',owner).eq('page_id',id);
  if (error) throw error;
}

// Selection offsets belong to the pinned version. Large text objects are fetched
// only when a capture needs them, so a view can still open while Storage is offline.
function versionText(db:SupabaseClient,owner:string,version:Version) {
  let pending:Promise<string>|undefined;
  async function read() {
    let text=version.inline_text;
    if (text==null) {
      if (version.text_path!==owner+'/'+version.content_hash+'.txt') throw Error('The saved article text is unavailable.');
      const {data,error}=await db.storage.from('web-comments').download(version.text_path);
      if (error) throw error;
      text=await data.text();
    }
    if (await hash(text)!==version.content_hash) throw Error('The saved text did not match this document version.');
    return text;
  }
  return ()=>pending ??= read().catch(error=>{pending=undefined;throw error;});
}

export async function loadSnapshot(db:SupabaseClient,id:string,mode:ArticleMode):Promise<Snapshot> {
  const {data,error}=await db.from('wc_library').select('owner,version_id,snapshot_html,wc_pages!inner(source_url),'+
    'wc_versions!inner(title,kind,complete,extraction_note,pdf_path,fingerprint,content_hash,inline_text,text_path)').eq('page_id',id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('This document is unavailable in your library.');
  const row=data as unknown as JoinedEntry;
  const version=row.wc_versions;
  const source=row.wc_pages.source_url;
  if (version.kind==='pdf') {
    if (!version.pdf_path) throw new Error('There is no saved PDF for this document.');
    const {data:bytes,error:downloadError}=await db.storage.from('web-comments').download(version.pdf_path);
    if (downloadError) throw downloadError;
    return {kind:'pdf',source,title:version.title,bytes,path:version.pdf_path};
  }
  const markup=row.snapshot_html ?? '';
  const saved={page:{page_id:id,version_id:row.version_id},contentHash:version.content_hash,
    fingerprint:version.fingerprint,text:versionText(db,row.owner,version)};
  const snapshot:Snapshot={kind:'html',source,title:version.title,html:sanitizeArticle(markup),
    hasReader:!markup.startsWith(plainArticlePrefix),complete:version.complete,note:version.extraction_note,saved};
  const fingerprint=(digest?:string)=>captureFingerprint(saved.contentHash,snapshot,markup,digest);
  if (mode==='reader' || await fingerprint()===saved.fingerprint) return snapshot;
  try {
    const archive=await loadArchive(db,row.owner,saved.fingerprint);
    if (await fingerprint(archive.digest)===saved.fingerprint) snapshot.archive=archive;
    else snapshot.archiveError='The saved layout did not match this document version.';
  } catch { snapshot.archiveError='The saved layout could not be loaded. Reopen this document to retry.'; }
  return snapshot;
}

export async function fetchSnapshot(db:SupabaseClient,url:string,mode:ArticleMode):Promise<Snapshot> {
  const {data:{session}}=await db.auth.getSession();
  if (!session) throw new Error('Sign in to import a document.');
  const response=await fetch('/api/import',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.access_token},
    body:JSON.stringify({url,mode}),
  });
  if (!response.ok) {
    const problem=await response.json().catch(()=>null);
    throw new Error(problem?.error ?? 'Could not import this document.');
  }
  if (response.headers.get('content-type')?.includes('application/pdf')) {
    const source=response.headers.get('x-web-comments-source');
    if (!source) throw new Error('The import did not return a source URL.');
    return {kind:'pdf',source,title:'PDF document',bytes:await response.blob()};
  }
  const {url:source,title,html,complete,note,archive}=await response.json();
  return {kind:'html',source,title,html:sanitizeArticle(html),hasReader:!html.startsWith(plainArticlePrefix),complete,note,
    archive:isArticleArchive(archive)?await prepareArchive(archive):undefined};
}

export async function saveLibrarySnapshot(db:SupabaseClient,owner:string,capture:Capture,snapshot:Snapshot) {
  if (snapshot.kind==='pdf') return {page:await saveCapture(db,owner,capture,{snapshotHtml:null}),snapshot};
  const contentHash=await hash(capture.text);
  const markup=snapshot.hasReader?snapshot.html:plainArticleHtml(capture.text);
  const fingerprint=await captureFingerprint(contentHash,capture,markup,snapshot.archive?.digest);
  if (snapshot.archive) await storeArchive(db,owner,fingerprint,snapshot.archive);
  const page=await saveCapture(db,owner,capture,{snapshotHtml:markup,identity:{contentHash,fingerprint}});
  const saved:SavedArticle={page,contentHash,fingerprint,text:async()=>capture.text};
  return {page,snapshot:{...snapshot,saved,complete:capture.complete,note:capture.note}};
}
