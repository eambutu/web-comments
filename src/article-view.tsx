import React, { useEffect, useRef, useState } from 'react';
import { mountArchive } from './archive-frame';
import type { DocumentView } from './document-panel';
import { htmlDocument } from './html-document';
import type { Snapshot } from './library-data';
import { alignHtmlAnchor } from './model';

export function ArticleView({snapshot,onReady}:{
  snapshot:Extract<Snapshot,{kind:'html'}>;onReady:(view:DocumentView)=>void;
}) {
  const reader=useRef<HTMLElement>(null);
  const [layout,setLayout]=useState(false);
  const [archiveRoot,setArchiveRoot]=useState<HTMLElement|null>(null);
  const [problem,setProblem]=useState('');
  const archive=snapshot.archive?.bundle;
  const activeRoot=layout?archiveRoot:null;
  const active=activeRoot!==null;
  useEffect(()=>{
    const source=()=>({url:snapshot.source,title:snapshot.title});
    const canonical=htmlDocument(reader.current!,source);
    const framed=activeRoot?htmlDocument(activeRoot,source):null;
    onReady({source:snapshot.source,title:snapshot.title,
      capture:async ()=>{
        if (document.readyState!=='complete') await new Promise<void>(resolve=>window.addEventListener('load',()=>resolve(),{once:true}));
        const capture=canonical.capture();
        if (framed) {
          const selection=framed.capture().anchor;
          const aligned=selection?.kind==='html'?alignHtmlAnchor(capture.text,selection):null;
          if (selection && (!aligned || aligned.exact.length>6000)) {
            throw Error('This selection could not be matched to the reader text. Select the passage in Reader to annotate it.');
          }
          capture.anchor=aligned;
        }
        return {...capture,complete:capture.complete && snapshot.complete,note:[snapshot.note,capture.note].filter(Boolean).join(' ')};
      },
      highlight:async (threads,focus)=>framed?framed.highlight(threads,focus,true):canonical.highlight(threads,focus),
    });
    return ()=>{ canonical.dispose();framed?.dispose(); };
  },[snapshot,onReady,activeRoot]);
  return <>
    {archive && <div className="article-layouts" role="group" aria-label="Article view">
      <button aria-pressed={!layout} onClick={()=>setLayout(false)}>Reader</button>
      <button aria-pressed={layout} disabled={!!problem} onClick={()=>setLayout(true)}>Saved layout</button>
      {active && archive.missingAssets>0 && <small>{archive.missingAssets} source {archive.missingAssets===1?'asset was':'assets were'} unavailable.</small>}
    </div>}
    {(problem || snapshot.archiveError) && <p className="archive-status" role="status">{problem || snapshot.archiveError?.message}</p>}
    <div className={active?'archive-reader-copy':undefined} inert={active}>
      <article className="reader-content" ref={reader} dangerouslySetInnerHTML={{__html:snapshot.html}}/>
    </div>
    {archive && (layout || archiveRoot) && <iframe className="article-archive" title="Saved article layout" hidden={!active}
      sandbox="allow-same-origin" referrerPolicy="no-referrer" src="/archive-frame" onLoad={event=>{
        try { setArchiveRoot(mountArchive(event.currentTarget,archive)); }
        catch { setLayout(false);setProblem('The saved layout could not be displayed.'); }
      }}/>}
  </>;
}
