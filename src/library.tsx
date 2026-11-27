import React, { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { AccountForm } from './account-form';
import { errorText, loadConfig, type Config } from './client';
import { savedComments } from './comment-store';
import { DocumentPanel, type DocumentView } from './document-panel';
import { ArticleView } from './article-view';
import { fetchSnapshot, listLibrary, loadSnapshot, saveLibrarySnapshot, type Entry, type Snapshot } from './library-data';
import type { ArticleMode } from '../shared/article-mode';
import { SidePanel } from './side-panel';
import './content.css';
import './styles.css';
import './pdf-pages.css';
import './library.css';

function LibraryApp() {
  const [config,setConfig]=useState<Config|null>(null);
  const [session,setSession]=useState<Session|null|undefined>(undefined);
  const [status,setStatus]=useState('');
  const db=useMemo(()=>config ? createClient(config.supabaseUrl,config.publishableKey) : null,[config]);
  useEffect(()=>{
    void loadConfig(location.origin).then(setConfig).catch(error=>setStatus(errorText(error)));
  },[]);
  useEffect(()=>{
    const listener=db?.auth.onAuthStateChange((_event,current)=>setSession(current));
    return ()=>listener?.data.subscription.unsubscribe();
  },[db]);

  async function signOut() {
    const {error}=await db!.auth.signOut();
    if (error) setStatus(errorText(error));
  }
  return <div className="library">
    <header className="library-header">
      <a className="library-brand" href="/"><span aria-hidden="true">WC</span>Web Comments</a>
      <h1>Library</h1>
      <div className="library-header-actions">
        <a href="/playground">Playground</a>
        {session && <button type="button" onClick={()=>void signOut()}>Sign out</button>}
      </div>
    </header>
    {status && <p className="library-account-error status" role="alert">{status}</p>}
    {db && config && session!==undefined
      ? session
        ? <Workspace key={session.user.id} db={db} owner={session.user.id} origin={config.origin} mode={config.articleMode ?? 'reader'}/>
        : <main className="library-welcome">
          <div>
            <h2>Save a page to read and annotate later.</h2>
            <p>Import a public article or PDF. Your saved documents and comments live in your private library.</p>
          </div>
          <AccountForm db={db}/>
        </main>
      : !status && <p className="library-account-error" role="status">Loading your library…</p>}
  </div>;
}

type OpenDocument = {key:string;snapshot:Snapshot;entry?:Entry};

function Workspace({db,owner,origin,mode}:{db:SupabaseClient;owner:string;origin:string;mode:ArticleMode}) {
  const [entries,setEntries]=useState<Entry[]>([]);
  const [url,setUrl]=useState('');
  const [open,setOpen]=useState<OpenDocument|null>(null);
  const [view,setView]=useState<DocumentView|null>(null);
  const [busy,setBusy]=useState('');
  const [status,setStatus]=useState('');
  const [loading,setLoading]=useState(true);
  const [showDocuments,setShowDocuments]=useState(true);
  const operation=useRef(0);
  const comments=useMemo(()=>savedComments(db,owner),[db,owner]);
  const pageLink=(id:string)=>origin+'/p/'+id;

  function address(id:string) {
    history.replaceState(null,'','/library?document='+encodeURIComponent(id));
  }
  async function openEntry(entry:Entry) {
    const current=++operation.current;
    setStatus('');
    setBusy('Opening document…');
    try {
      const snapshot=await loadSnapshot(db,entry.id,mode);
      if (current!==operation.current) return;
      setView(null);
      setOpen({key:crypto.randomUUID(),snapshot,entry});
      address(entry.id);
      setShowDocuments(false);
    } catch (error) {
      if (current===operation.current) setStatus(errorText(error));
    } finally {
      if (current===operation.current) setBusy('');
    }
  }
  useEffect(()=>{
    let live=true;
    void listLibrary(db,owner).then(items=>{
      if (!live) return;
      setEntries(items);
      const previous=new URLSearchParams(location.search).get('document');
      const entry=items.find(item=>item.id===previous) ?? items[0];
      if (entry) void openEntry(entry);
    }).catch(error=>{if (live) setStatus(errorText(error));})
      .finally(()=>{if (live) setLoading(false);});
    return ()=>{live=false;operation.current++;};
  },[db,owner]);

  async function importLink(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current=++operation.current;
    setBusy('Importing document…');setStatus('');
    try {
      const snapshot=await fetchSnapshot(db,url.trim(),mode);
      if (current!==operation.current) return;
      setBusy('Saving snapshot…');
      setView(null);
      setOpen({key:crypto.randomUUID(),snapshot});
    } catch (error) {
      if (current!==operation.current) return;
      setBusy('');setStatus(errorText(error));
    }
  }
  const pending=open && !open.entry ? open : null;
  useEffect(()=>{
    if (!view || !pending) return;
    let live=true;
    void (async()=>{
      const capture=await view.capture();
      const {page:saved,snapshot}=await saveLibrarySnapshot(db,owner,capture,pending.snapshot);
      if (!live) return;
      const item:Entry={id:saved.page_id,source:capture.url,title:capture.title,kind:capture.kind,
        importedAt:new Date().toISOString()};
      setBusy('');
      setOpen({...pending,entry:item,snapshot});
      setEntries(items=>{
        const existing=items.findIndex(entry=>entry.id===item.id);
        if (existing<0) return [item,...items];
        return items.map(entry=>entry.id===item.id?{...item,importedAt:entry.importedAt}:entry);
      });
      setUrl('');
      address(item.id);
      setShowDocuments(false);
    })().catch(error=>{if (live) {setStatus(errorText(error));setBusy('');}});
    return ()=>{live=false;};
  },[view,pending,db,owner]);

  const store=useMemo(()=>{
    if (!open?.entry) return null;
    const snapshot=open.snapshot;
    return {...comments,save:(capture:Parameters<typeof comments.save>[0])=>{
      if (capture.kind==='pdf' && capture.binaryHash && !capture.pdfPath) {
        capture={...capture,pdfBlob:undefined,pdfPath:owner+'/'+capture.binaryHash+'.pdf'};
      }
      return saveLibrarySnapshot(db,owner,capture,snapshot).then(result=>result.page);
    }};
  },[comments,open,db,owner]);

  const title=open?.entry?.title || open?.snapshot.title;
  return <div className="library-grid">
    <aside className={'library-shelf'+(showDocuments?' library-shelf-open':'')} aria-label="Saved documents">
      <h2>Your documents</h2>
      <form className="library-import" onSubmit={event=>void importLink(event)}>
        <label htmlFor="import-url">Import a link</label>
        <input id="import-url" name="url" type="url" placeholder="https://…" required autoComplete="off"
          value={url} onChange={event=>setUrl(event.target.value)} disabled={!!busy || loading}/>
        <button className="primary" type="submit" disabled={!!busy || loading}>Import</button>
      </form>
      {busy && <p className="library-progress" role="status">{busy}</p>}
      {status && <p className="status" role="alert">{status}</p>}
      <nav className="library-documents" aria-label="Library documents">
        {entries.map(item=><button type="button" className="library-item" key={item.id}
          aria-current={open?.entry?.id===item.id?'page':undefined} disabled={!!busy}
          onClick={()=>void openEntry(item)}>
          <span className="library-kind">{item.kind==='pdf'?'PDF':'HTML'}</span>
          <span className="library-item-text"><strong>{item.title}</strong><small>{new URL(item.source).hostname}</small></span>
        </button>)}
        {!entries.length && !loading && <p className="empty">Imported documents will appear here.</p>}
      </nav>
    </aside>
    <main className="library-reader">
      <button type="button" className="library-mobile-documents" aria-expanded={showDocuments}
        onClick={()=>setShowDocuments(value=>!value)}>Your documents</button>
      {open
        ? <>
          <header className="library-document-header">
            <div><h2>{title}</h2><p>{new URL(open.snapshot.source).hostname}</p></div>
            <a href={open.snapshot.source} target="_blank" rel="noopener noreferrer">Open original</a>
          </header>
          {open.snapshot.kind==='html'
            ? <ArticleView key={open.key} snapshot={open.snapshot} mode={mode} onReady={setView}/>
            : <PdfSnapshotView key={open.key} snapshot={open.snapshot} onReady={setView} onFailure={error=>{
              setStatus(error);setBusy('');
            }}/> }
        </>
        : <section className="library-empty">
          <h2>Import a public article or PDF</h2>
          <p>Paste a link to save a snapshot and start a comment on any passage.</p>
        </section>}
    </main>
    <div className="library-comments">
      <SidePanel>
        {store && view && open
          ? <DocumentPanel key={open.key} store={store} view={view} pageLink={pageLink}/>
          : <p className="empty">Open a saved document to add comments.</p>}
      </SidePanel>
    </div>
  </div>;
}

function PdfSnapshotView({snapshot,onReady,onFailure}:{
  snapshot:Extract<Snapshot,{kind:'pdf'}>;onReady:(view:DocumentView)=>void;onFailure:(message:string)=>void;
}) {
  const pages=useRef<HTMLDivElement>(null);
  const status=useRef<HTMLParagraphElement>(null);
  const failed=useRef(onFailure);
  failed.current=onFailure;
  useEffect(()=>{
    let live=true;
    let dispose:(()=>void)|undefined;
    void import('./pdf-document').then(async ({pdfDocument})=>{
      if (!live) return;
      const viewer=pdfDocument({source:snapshot.source,assets:new URL('/assets/',location.origin),
        pages:pages.current!,status:status.current!,deriveTitle:true});
      dispose=viewer.dispose;
      await viewer.load(()=>snapshot.bytes.arrayBuffer());
      if (!live) return;
      const {capture}=viewer.capture();
      onReady({source:snapshot.source,title:capture.title,
        capture:async()=>({...viewer.capture().capture,pdfPath:snapshot.path,
          pdfBlob:snapshot.path?undefined:snapshot.bytes}),
        highlight:async(threads,focus)=>viewer.highlight(threads,focus),
      });
    }).catch(error=>{
      if (!live) return;
      const message=status.current?.textContent?.startsWith('Could not open PDF') ?
        status.current.textContent : errorText(error);
      failed.current(message);
    });
    return ()=>{live=false;dispose?.();};
  },[snapshot,onReady]);

  return <section className="library-pdf" aria-label="PDF snapshot">
      <p ref={status} role="status">Opening PDF…</p>
      <div ref={pages} className="pdf-pages"/>
    </section>;
}

createRoot(document.getElementById('app')!).render(<LibraryApp/>);
