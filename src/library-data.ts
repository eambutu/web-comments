import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizeArticle } from './article-sanitizer';
import { loadArchive, prepareArchive, type SavedArchive } from './archive-storage';
import { isArticleArchive } from '../shared/article-archive';
import { captureFingerprint } from './model';
import type { SavedPage } from './comment-store';

export type Entry = {
  id:string;title:string;source:string;kind:'html'|'pdf';importedAt:string;
};
export type Snapshot = {
  title:string;source:string;
} & (
  {kind:'html';html:string;complete:boolean;note:string;archive?:SavedArchive;archiveError?:{message:string;pinned:SavedPage}}
  | {kind:'pdf';bytes:Blob;path?:string}
);

type JoinedEntry = {
  page_id:string;version_id:string;imported_at:string;owner:string;
  wc_pages:{source_url:string};
  wc_versions:{title:string;kind:Entry['kind'];complete:boolean;extraction_note:string;pdf_path:string|null;fingerprint:string;content_hash:string};
  snapshot_html:string|null;
};

const joins='wc_pages!inner(source_url),wc_versions!inner(title,kind,complete,extraction_note,pdf_path,fingerprint,content_hash)';

export async function listLibrary(db:SupabaseClient, owner:string) {
  const items:Entry[]=[];
  for (let offset=0; ; offset+=500) {
    const {data,error}=await db.from('wc_library').select('page_id,imported_at,'+joins).eq('owner',owner)
      .order('imported_at',{ascending:false}).order('page_id').range(offset,offset+499);
    if (error) throw error;
    for (const row of data as unknown as JoinedEntry[]) {
      items.push({id:row.page_id,source:row.wc_pages.source_url,title:row.wc_versions.title,
        kind:row.wc_versions.kind,importedAt:row.imported_at});
    }
    if (data.length<500) return items;
  }
}

export async function loadSnapshot(db:SupabaseClient,id:string):Promise<Snapshot> {
  const {data,error}=await db.from('wc_library').select('owner,version_id,snapshot_html,'+joins).eq('page_id',id).maybeSingle();
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
  const snapshot:Snapshot={kind:'html',source,title:version.title,html:sanitizeArticle(row.snapshot_html ?? ''),
    complete:version.complete,note:version.extraction_note};
  const fingerprint=(digest?:string)=>captureFingerprint(version.content_hash,snapshot,row.snapshot_html,digest);
  // Reader-only imports already match this signature and need no Storage request.
  if (await fingerprint()===version.fingerprint) return snapshot;
  const pinned={page_id:id,version_id:row.version_id};
  try {
    const archive=await loadArchive(db,row.owner,version.fingerprint);
    if (await fingerprint(archive.digest)===version.fingerprint) snapshot.archive=archive;
    else snapshot.archiveError={pinned,message:'The saved layout did not match this document version.'};
  } catch { snapshot.archiveError={pinned,message:'The saved layout could not be loaded. Reopen this document to retry.'}; }
  return snapshot;
}

export async function fetchSnapshot(db:SupabaseClient,url:string):Promise<Snapshot> {
  const {data:{session}}=await db.auth.getSession();
  if (!session) throw new Error('Sign in to import a document.');
  const response=await fetch('/api/import',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.access_token},
    body:JSON.stringify({url,archive:true}),
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
  return {kind:'html',source,title,html:sanitizeArticle(html),complete,note,
    archive:isArticleArchive(archive)?await prepareArchive(archive):undefined};
}
