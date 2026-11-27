import type { SupabaseClient } from '@supabase/supabase-js';
import { isArticleArchive, maxArchiveBytes, type ArticleArchive } from '../shared/article-archive';
import { hash } from './model';
import { upload } from './client';

export type SavedArchive={
  bundle:ArticleArchive;
  digest:string;
  file:Blob;
  path?:string;
};

export const archivePath=(owner:string,fingerprint:string)=>owner+'/archives/'+fingerprint+'.json';

export async function prepareArchive(bundle:ArticleArchive):Promise<SavedArchive> {
  const serialized=JSON.stringify(bundle);
  return {bundle,digest:await hash(serialized),file:new Blob([serialized],{type:'application/json'})};
}

export async function storeArchive(db:SupabaseClient,owner:string,fingerprint:string,archive:SavedArchive) {
  const path=archivePath(owner,fingerprint);
  if (archive.path!==path) {
    await upload(db,path,archive.file);
    archive.path=path;
  }
}

export async function loadArchive(db:SupabaseClient,owner:string,fingerprint:string) {
  const path=archivePath(owner,fingerprint);
  const {data:file,error}=await db.storage.from('web-comments').download(path);
  if (error) throw error;
  if (file.size>2*maxArchiveBytes) throw new Error('The saved layout is too large to open.');
  const serialized=await file.text();
  const bundle:unknown=JSON.parse(serialized);
  if (!isArticleArchive(bundle)) throw new Error('The saved layout has an unsupported format.');
  return {bundle,file,digest:await hash(serialized),path};
}
