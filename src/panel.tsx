import React, { useEffect, useMemo, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import './styles.css';
import { defaultServerOrigin, errorText, extensionClient, loadConfig, type Config } from './client';
import { savedComments, type CommentStore } from './comment-store';
import { DocumentPanel, type DocumentView } from './document-panel';
import { BrowserSignIn, SidePanel } from './side-panel';
import type { Capture, Thread } from './model';

function App() {
  const [config,setConfig] = useState<Config|null>(null);
  const [session,setSession] = useState<Session|null>(null);
  const [loaded,setLoaded] = useState(false);
  const [busy,setBusy] = useState(false);
  const [status,setStatus] = useState('');
  const db = useMemo(() => config ? extensionClient(config) : null,[config]);
  useEffect(() => {
    void chrome.storage.local.get('wcConfig').then(async result => {
      const saved = result.wcConfig as Config|undefined;
      const address = saved?.origin || defaultServerOrigin;
      if (!address) { setLoaded(true); return; }
      const current = await loadConfig(address).catch(error => {
        if (saved) return saved;
        throw error;
      });
      if (current !== saved) await chrome.storage.local.set({wcConfig:current});
      setConfig(current);
    }).catch(error => { setStatus(errorText(error)); setLoaded(true); });
  },[]);
  useEffect(() => {
    if (!db) return;
    const {data:{subscription}} = db.auth.onAuthStateChange((_event,current) => {
      setSession(current);
      setLoaded(true);
    });
    function sessionUpdated(message:{type?:string}) {
      if (message?.type==='wc-session-updated') {
        void db!.auth.getSession().then(({data})=>setSession(data.session));
      }
    }
    chrome.runtime.onMessage.addListener(sessionUpdated);
    return () => {
      subscription.unsubscribe();
      chrome.runtime.onMessage.removeListener(sessionUpdated);
    };
  },[db]);
  async function act(fn:()=>Promise<void>) {
    setBusy(true); setStatus('');
    try { await fn(); } catch (error) { setStatus(errorText(error)); }
    finally { setBusy(false); }
  }
  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void act(async () => {
      const next = await loadConfig(String(form.get('server')));
      await chrome.storage.local.set({wcConfig:next});
      setConfig(next);
    });
  }
  function openSignIn(signUp:boolean) {
    void act(async () => {
      const result=await chrome.runtime.sendMessage({type:'wc-open-sign-in',signUp});
      if (!result?.ok) throw new Error('Could not open the sign-in tab.');
    });
  }
  return <SidePanel standalone busy={busy} onSignOut={db && session ? () => void act(async () => {
    const {error} = await db.auth.signOut();
    if (error) throw error;
  }) : undefined}>
    {!loaded ? <p>Loading…</p>
      : !db || !config ? <form onSubmit={submit} className="card stack">
        <h2>Connect your server</h2>
        <label>Server address<input name="server" type="url" defaultValue={defaultServerOrigin} placeholder="https://…" required /></label>
        <button className="primary" disabled={busy}>{busy ? 'Working…' : 'Connect'}</button>
      </form>
      : !session ? <BrowserSignIn busy={busy} onOpen={openSignIn} onChangeServer={()=>void act(async ()=>{
        await chrome.storage.local.remove('wcConfig');setConfig(null);
      })}/>
      : <Workspace key={session.user.id} db={db} owner={session.user.id} origin={config.origin}/>}
    {status && <p className="status" role="status">{status}</p>}
  </SidePanel>;
}

type View = {id:number; tabUrl:string; source:string; title:string; pdf:boolean};
const viewer = chrome.runtime.getURL('viewer.html');
async function activeView():Promise<View|null> {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.id || !tab.url) return null;
  const pdf = tab.url.startsWith(viewer + '?');
  const source = pdf ? new URL(tab.url).searchParams.get('url') ?? '' : tab.url;
  if (!/^(https?|file):\/\//.test(source)) return null;
  if (!pdf && source.startsWith('file:') && !/\.pdf$/i.test(new URL(source).pathname)) return null;
  return {id:tab.id,tabUrl:tab.url,source,title:tab.title || source,pdf};
}
async function send<T>(view:View,type:string, data:object = {}):Promise<T> {
  const response = view.pdf
    ? await chrome.runtime.sendMessage({type,targetTab:view.id,...data})
    : await chrome.tabs.sendMessage(view.id,{type,...data});
  if (response?.error) throw new Error(response.error);
  return response as T;
}

function Workspace({db,owner,origin}:{db:SupabaseClient;owner:string;origin:string}) {
  const [view,setView] = useState<View|null>(null);
  useEffect(() => {
    let version = 0;
    const update = () => {
      const next = ++version;
      void activeView().then(active => { if (version === next) setView(previous => previous && active &&
        previous.id===active.id && previous.tabUrl===active.tabUrl && previous.title===active.title ? previous : active); });
    };
    update();
    chrome.tabs.onActivated.addListener(update);
    chrome.tabs.onUpdated.addListener(update);
    chrome.windows.onFocusChanged.addListener(update);
    return () => {
      version++;
      chrome.tabs.onActivated.removeListener(update);
      chrome.tabs.onUpdated.removeListener(update);
      chrome.windows.onFocusChanged.removeListener(update);
    };
  },[]);
  const store = useMemo(() => savedComments(db,owner),[db,owner]);
  return view ? <ChromeDocument key={`${view.id}:${view.tabUrl}`} {...{store,origin,view}}/>
    : <p className="empty">Open a webpage or PDF to start annotating.</p>;
}

function ChromeDocument({store,origin,view}:{store:CommentStore;origin:string;view:View}) {
  const page = useMemo<DocumentView>(() => ({
    source:view.source,
    title:view.title,
    async capture() {
      try {
        return await send<Capture>(view,view.pdf?'wc-pdf-capture':'wc-html-capture',{uploadPdf:true});
      } catch (error) {
        if (errorText(error).includes('Receiving end does not exist')) {
          throw new Error('Reload the page to enable annotation, or open it in the PDF viewer.');
        }
        throw error;
      }
    },
    highlight:(threads:Thread[],focus?:string) => send<string[]>(view,
      view.pdf?'wc-pdf-highlights':'wc-html-highlights',{threads,focus}),
    openAsPdf:view.pdf ? undefined : () => void chrome.tabs.update(view.id,{url:`${viewer}?url=${encodeURIComponent(view.source)}`}),
  }),[view]);
  return <DocumentPanel store={store} pageLink={id=>origin+'/p/'+id} view={page}/>;
}

createRoot(document.getElementById('app')!).render(<App/>);
