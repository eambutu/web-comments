import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, type Session } from '@supabase/supabase-js';
import { AccountForm } from './account-form';
import { errorText, loadConfig, type Config } from './client';
import { savedComments } from './comment-store';
import { DocumentPanel, type DocumentView } from './document-panel';
import { htmlDocument } from './html-document';
import { sampleComments } from './sample-comments';
import { BrowserSignIn, SidePanel } from './side-panel';
import './content.css';
import './styles.css';
import './pdf-pages.css';
import './playground.css';

const title = 'A field guide to urban shade';
const sampleHtml = new URL('/playground',location.origin).href;
const pdfAssets = new URL('/assets/',location.origin);
const samplePdf = new URL('urban-shade.pdf',pdfAssets).href;
const passage = 'Tree canopies cool sidewalks through shade and evaporation.';
const initial = new URLSearchParams(location.search);
type Mode = 'sample'|'account';
type Kind = 'html'|'pdf';

function App() {
  const [mode,setMode] = useState<Mode>(initial.get('mode')==='account' ? 'account' : 'sample');
  const [kind,setKind] = useState<Kind>(initial.get('document')==='pdf' ? 'pdf' : 'html');
  const [view,setView] = useState<DocumentView|null>(null);
  const [sampleSession,setSampleSession] = useState(true);
  const [signUp,setSignUp] = useState(false);
  const [stores] = useState(()=>({html:sampleComments(),pdf:sampleComments()}));
  const store=stores[kind];

  useEffect(()=>{
    const search = new URLSearchParams();
    if (mode==='account') search.set('mode','account');
    if (kind==='pdf') search.set('document','pdf');
    const suffix=search.toString();
    history.replaceState(null,'','/playground'+(suffix ? '?'+suffix : ''));
  },[mode,kind]);

  const activeView = useMemo<DocumentView|null>(() => {
    if (!view) return null;
    if (kind==='pdf') return view;
    return {...view,openAsPdf:()=>{setView(null);setKind('pdf');}};
  },[view,kind]);
  const sampleLink = () => sampleHtml+(kind==='pdf'?'?document=pdf':'');

  return <main className="playground">
    <header className="playground-header">
      <a href="/" className="playground-home">Web Comments</a>
      <h1>Playground</h1>
      <div className="playground-modes actions" role="group" aria-label="Playground mode">
        <button type="button" aria-pressed={mode==='sample'} className={mode==='sample'?'primary':''}
          onClick={()=>{setSampleSession(true);setMode('sample');}}>Try sample</button>
        <button type="button" aria-pressed={mode==='account'} className={mode==='account'?'primary':''}
          onClick={()=>{setSignUp(false);setMode('account');}}>My account</button>
      </div>
    </header>
    {mode==='sample' && <div className="playground-demo">
      <p>Try the Chrome side panel on a sample document. Sample links reopen this playground, and sample comments clear on reload.</p>
      <button type="button" disabled={!sampleSession} onClick={()=>void store.previewReplies?.()}>Preview replies</button>
    </div>}
    <div className="playground-workspace">
      <div className="playground-page">
        {kind==='pdf' ? <>
          <button type="button" onClick={()=>{setView(null);setKind('html');}}>Back to web page</button>
          <PdfSample onReady={setView}/>
        </> : <HtmlSample onReady={setView}/>}
      </div>
      <div className="playground-panel">
        {mode==='sample'
          ? <SidePanel onSignOut={sampleSession ? ()=>setSampleSession(false) : undefined}>
            {sampleSession
              ? activeView && <DocumentPanel key={kind} store={store} view={activeView} pageLink={sampleLink}/>
              : <BrowserSignIn onOpen={create=>{setSignUp(create);setMode('account');}}/>}
          </SidePanel>
          : <AccountPanel key={String(signUp)} view={activeView} kind={kind} initialSignUp={signUp}/>}
      </div>
    </div>
  </main>;
}

function HtmlSample({onReady}:{onReady:(view:DocumentView)=>void}) {
  const root = useRef<HTMLElement>(null);
  const example = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const page = htmlDocument(root.current!,() => ({url:sampleHtml,title}));
    onReady({source:sampleHtml,title,capture:async ()=>page.capture(),
      highlight:async (threads,focus)=>page.highlight(threads,focus)});
    return page.dispose;
  },[onReady]);
  function selectPassage() {
    if (!example.current) return;
    example.current.scrollIntoView({block:'nearest'});
    const range = document.createRange();
    range.selectNodeContents(example.current);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return <>
    <div className="playground-selection"><button type="button" onClick={selectPassage}>Select a sample passage</button></div>
    <article ref={root} className="playground-article">
      <header>
        <h2>{title}</h2>
        <p>A short guide to cooler streets in summer.</p>
      </header>
      <section>
        <h3>How trees cool a street</h3>
        <p><span ref={example}>{passage}</span> Leaves intercept sunlight and release water vapor. As that water evaporates, it absorbs heat from the surroundings.</p>
      </section>
      <section>
        <h3>What to check on a walk</h3>
        <p>Follow the same route at midday and in the late afternoon. Compare the places where people wait, such as bus stops and crossings, with stretches where they keep moving.</p>
      </section>
    </article>
  </>;
}

function PdfSample({onReady}:{onReady:(view:DocumentView)=>void}) {
  const pages = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(()=>{
    let live=true;
    let dispose:(()=>void)|undefined;
    void import('./pdf-document').then(async ({pdfDocument})=>{
      if (!live) return;
      const viewer=pdfDocument({source:samplePdf,assets:pdfAssets,status:status.current!,pages:pages.current!});
      dispose=viewer.dispose;
      await viewer.load(async ()=>{
        const response=await fetch(samplePdf);
        if (!response.ok) throw new Error('The sample PDF could not be downloaded.');
        return response.arrayBuffer();
      });
      if (!live) return;
      viewer.capture();
      onReady({
        source:samplePdf,title,
        async capture() {
          const {bytes,capture}=viewer.capture();
          return {...capture,pdfBlob:new Blob([bytes],{type:'application/pdf'})};
        },
        highlight:async (threads,focus)=>viewer.highlight(threads,focus),
      });
    }).catch(error=>{
      if (live) status.current!.textContent=errorText(error);
    });
    return ()=>{live=false;dispose?.();};
  },[onReady]);
  return <section className="playground-pdf" aria-label="Sample PDF">
    <p ref={status} role="status">Opening PDF…</p>
    <div ref={pages} className="pdf-pages"/>
  </section>;
}

function AccountPanel({view,kind,initialSignUp}:{view:DocumentView|null;kind:Kind;initialSignUp:boolean}) {
  const [config,setConfig] = useState<Config|null>(null);
  const [session,setSession] = useState<Session|null|undefined>(undefined);
  const [status,setStatus] = useState('');
  const db = useMemo(() => config ? createClient(config.supabaseUrl,config.publishableKey) : null,[config]);
  const account = session?.user.id;
  const store = useMemo(() => db && account ? savedComments(db,account) : null,[db,account]);
  useEffect(() => {
    let live = true;
    void loadConfig(location.origin).then(config=>{if (live) setConfig(config);})
      .catch(error=>{if (live) setStatus(errorText(error));});
    return () => { live=false; };
  },[]);
  useEffect(() => {
    const listener = db?.auth.onAuthStateChange((_event,current)=>setSession(current));
    return () => listener?.data.subscription.unsubscribe();
  },[db]);
  async function signOut() {
    if (!db) return;
    setStatus('');
    const {error} = await db.auth.signOut();
    if (error) setStatus(errorText(error));
  }
  return <SidePanel onSignOut={session ? ()=>void signOut() : undefined}>
    {status && <p className="status" role="status">{status}</p>}
    {config && db && session!==undefined ? store && session
      ? <>
        {!config.clientId && <p className="playground-help">ChatGPT replies will be available after the connection is set up.</p>}
        {view && <DocumentPanel key={account+':'+kind} store={store} view={view} pageLink={id=>config.origin+'/p/'+id}/>}
      </>
      : <AccountForm db={db} initialSignUp={initialSignUp}/>
      : !status && <p role="status">Loading account…</p>}
  </SidePanel>;
}
createRoot(document.getElementById('app')!).render(<App/>);
