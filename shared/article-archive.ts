export const maxArchiveBytes=12*1024*1024;
export const archivePolicy="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

export type ArticleArchive = {
  version:1;
  html:string;
  missingAssets:number;
};

export function isArticleArchive(value:unknown):value is ArticleArchive {
  if (!value || typeof value!=='object') return false;
  const archive=value as Partial<ArticleArchive>;
  return archive.version===1 && typeof archive.html==='string' && archive.html.length<=maxArchiveBytes &&
    typeof archive.missingAssets==='number' && Number.isSafeInteger(archive.missingAssets) && archive.missingAssets>=0;
}
