import React, { useCallback, useEffect, useState } from 'react';
import type { ArticleLayout, ArticleMode } from '../shared/article-mode';
import type { DocumentView } from './document-panel';
import { htmlDocument } from './html-document';
import type { Snapshot } from './library-data';
import { alignHtmlAnchor } from './model';
import { ReaderLayout } from './reader-layout';
import { SavedLayout } from './saved-layout';

const preferenceKey='web-comments.article-layout';

function preferredLayout():ArticleLayout {
  try { return localStorage.getItem(preferenceKey)==='archive'?'archive':'reader'; }
  catch { return 'reader'; }
}

export function ArticleView({snapshot,mode,onReady}:{
  snapshot:Extract<Snapshot,{kind:'html'}>;mode:ArticleMode;onReady:(view:DocumentView)=>void;
}) {
  const [preference,setPreference]=useState(preferredLayout);
  const [root,setRoot]=useState<HTMLElement|null>(null);
  const [failed,setFailed]=useState(false);
  const ready=useCallback((node:HTMLElement|null)=>{if (node) setRoot(node);},[]);
  const archive=snapshot.archive?.bundle;
  const canSwitch=mode==='both' && !!archive && snapshot.hasReader && !!snapshot.saved && !failed;
  // Fix the first capture in a deterministic order. Later switches always use the
  // text recorded for that version, including versions created with only a bundle.
  const showArchive=!!archive && !failed && mode!=='reader' &&
    (!snapshot.hasReader || mode==='archive' || (canSwitch && preference==='archive'));
  function select(layout:ArticleLayout) {
    setPreference(layout);
    try { localStorage.setItem(preferenceKey,layout); } catch {}
  }

  useEffect(()=>{
    if (!root?.isConnected) return;
    const page=htmlDocument(root,()=>({url:snapshot.source,title:snapshot.title}));
    onReady({source:snapshot.source,title:snapshot.title,
      capture:async ()=>{
        if (!root.isConnected) throw Error('The article view is opening. Try again in a moment.');
        if (failed && !snapshot.saved && !snapshot.hasReader) throw Error('The saved layout could not be opened. Try importing the URL again.');
        const doc=root.ownerDocument;
        if (doc.readyState!=='complete') await new Promise<void>(resolve=>doc.defaultView!.addEventListener('load',()=>resolve(),{once:true}));
        const capture=page.capture();
        if (!snapshot.saved) return {...capture,complete:capture.complete && snapshot.complete,
          note:[snapshot.note,capture.note].filter(Boolean).join(' ')};
        const text=await snapshot.saved.text();
        let anchor=capture.anchor;
        if (anchor?.kind==='html' && text!==capture.text) {
          anchor=alignHtmlAnchor(text,anchor);
          if (!anchor || anchor.exact.length>6000) throw Error('This passage could not be matched to the saved document text.');
        }
        return {...capture,text,anchor,complete:snapshot.complete,note:snapshot.note};
      },
      highlight:async (threads,focus)=>page.highlight(threads,focus,true),
    });
    return ()=>page.dispose();
  },[root,snapshot,onReady,failed]);

  const problem=failed?'The saved layout could not be displayed.':snapshot.archiveError;
  return <>
    {canSwitch && <div className="article-layouts" role="group" aria-label="Article view">
      <button type="button" aria-pressed={!showArchive} onClick={()=>select('reader')}>Reader</button>
      <button type="button" aria-pressed={showArchive} onClick={()=>select('archive')}>Saved layout</button>
    </div>}
    {problem && <p className="archive-status" role="status">{problem}</p>}
    {showArchive && archive
      ? <SavedLayout archive={archive} onRoot={ready} onFailure={()=>setFailed(true)}/>
      : <ReaderLayout html={snapshot.html} onRoot={ready}/>}
  </>;
}
