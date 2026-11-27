import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, type Session } from '@supabase/supabase-js';
import { AccountForm } from './account-form';
import { errorText, loadConfig, type Config } from './client';
import { savedComments } from './comment-store';
import { DocumentPanel, type DocumentView } from './document-panel';
import { htmlDocument } from './html-document';
import { sampleComments } from './sample-comments';
import './content.css';
import './styles.css';
import './playground.css';

const title = 'A field guide to urban shade';
const source = new URL('/playground',location.origin).href;
const passage = 'Tree canopies cool sidewalks through shade and evaporation.';
type Mode = 'sample'|'account';

function App() {
  const [mode,setMode] = useState<Mode>(() => new URLSearchParams(location.search).get('mode')==='account' ? 'account' : 'sample');
  const [view,setView] = useState<DocumentView|null>(null);
  const root = useRef<HTMLElement>(null);
  const example = useRef<HTMLSpanElement>(null);
  const [sample] = useState(sampleComments);

  useEffect(() => {
    if (!root.current) return;
    const page = htmlDocument(root.current,() => ({url:source,title}));
    setView({
      source,title,capture:async () => page.capture(),
      highlight:async (threads,focus) => page.highlight(threads,focus),
    });
    return page.dispose;
  },[]);
  function selectMode(next:Mode) {
    setMode(next);
    const search = next==='account' ? '?mode=account' : '';
    history.replaceState(null,'',location.pathname+search);
  }
  function selectPassage() {
    if (!example.current) return;
    example.current.scrollIntoView({block:'nearest'});
    const range = document.createRange();
    range.selectNodeContents(example.current);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  return <main className="playground">
    <header className="playground-header">
      <a href="/" className="playground-home">Web Comments</a>
      <h1>Playground</h1>
      <div className="playground-modes actions" role="group" aria-label="Playground mode">
        <button type="button" aria-pressed={mode==='sample'} className={mode==='sample'?'primary':''}
          onClick={()=>selectMode('sample')}>Try sample</button>
        <button type="button" aria-pressed={mode==='account'} className={mode==='account'?'primary':''}
          onClick={()=>selectMode('account')}>My account</button>
      </div>
    </header>
    <div className="playground-workspace">
      <div className="playground-page">
        <div className="playground-selection">
          <button type="button" onClick={selectPassage}>Select a sample passage</button>
        </div>
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
      </div>
      <aside className="playground-panel shell" aria-label="Comments panel">
        {mode==='sample' ? <>
          <p className="playground-help">Select text, post an <strong>@AI</strong> question, and choose <strong>Preview replies</strong> to see a sample answer. Sample comments clear when you reload.</p>
          {view && <DocumentPanel store={sample} view={view}/>}
        </> : <AccountPanel view={view}/>}
      </aside>
    </div>
  </main>;
}

function AccountPanel({view}:{view:DocumentView|null}) {
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
    setStatus('');
    const {error} = await db!.auth.signOut();
    if (error) setStatus(errorText(error));
  }
  return <>
    <div className="playground-account">
      <p>{session ? 'Your comments are saved to your account.' : 'Sign in to save your comments and copy links for ChatGPT.'}</p>
      {session && <button className="subtle" type="button" onClick={()=>void signOut()}>Sign out</button>}
    </div>
    {status && <p className="status" role="status">{status}</p>}
    {config && db && session!==undefined ? store && session
      ? <>
        {!config.clientId && <p className="playground-help">ChatGPT replies will be available after the connection is set up.</p>}
        {view && <DocumentPanel key={account} store={store} view={view} shareOrigin={config.origin}/>}
      </>
      : <AccountForm db={db} origin={config.origin}/>
      : !status && <p role="status">Loading account…</p>}
  </>;
}

createRoot(document.getElementById('app')!).render(<App/>);
