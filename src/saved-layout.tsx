import React from 'react';
import type { ArticleArchive } from '../shared/article-archive';
import { mountArchive } from './archive-frame';

export function SavedLayout({archive,onRoot,onFailure}:{
  archive:ArticleArchive;onRoot:(root:HTMLElement)=>void;onFailure:()=>void;
}) {
  return <>
    {archive.missingAssets>0 && <p className="archive-status">{archive.missingAssets} source {archive.missingAssets===1?'asset was':'assets were'} unavailable.</p>}
    <iframe className="article-archive" title="Saved article layout" sandbox="allow-same-origin"
      referrerPolicy="no-referrer" src="/archive-frame" onLoad={event=>{
        try { onRoot(mountArchive(event.currentTarget,archive)); }
        catch { onFailure(); }
      }}/>
  </>;
}
