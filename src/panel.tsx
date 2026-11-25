import React, { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import './styles.css';
import { errorText, extensionClient, loadConfig, saveCapture, type Config } from './client';
import type { Capture, Message, Thread } from './model';

function App() {
  const [config,setConfig] = useState<Config|null>(null);
  const [session,setSession] = useState<Session|null>(null);
  const [loaded,setLoaded] = useState(false);
  const [busy,setBusy] = useState(false);
  const [status,setStatus] = useState('');
  const db = useMemo(() => config ? extensionClient(config) : null,[config]);
  useEffect(() => { void chrome.storage.local.get('wcConfig').then(result => {
    setConfig((result.wcConfig as Config | undefined) ?? null);
    if (!result.wcConfig) setLoaded(true);
  }); },[]);
  useEffect(() => {
    if (!db) return;
    const {data:{subscription}} = db.auth.onAuthStateChange((_event,current) => {
      setSession(current);
      setLoaded(true);
    });
    return () => subscription.unsubscribe();
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
      if (!db) {
        const next = await loadConfig(String(form.get('server')));
        await chrome.storage.local.set({wcConfig:next});
        setConfig(next);
        return;
      }
      const {error} = await db.auth.signInWithPassword({email:String(form.get('email')),password:String(form.get('password'))});
      if (error) throw error;
    });
  }
  return <main className="shell">
    <header className="brand"><span aria-hidden="true">WC</span><h1>Web Comments</h1>{db && session && <button className="subtle" onClick={() => void act(async () => {
      const {error} = await db.auth.signOut();
      if (error) throw error;
    })}>Sign out</button>}</header>
    {!loaded ? <p>Loading…</p> : db && session && config
      ? <Workspace db={db} owner={session.user.id} origin={config.origin}/>
      : <form onSubmit={submit} className="card stack">
        <h2>{db ? 'Sign in' : 'Connect your server'}</h2>
        {db ? <><label>Email<input name="email" type="email" required autoComplete="username"/></label>
          <label>Password<input name="password" type="password" required autoComplete="current-password"/></label></>
          : <label>Server address<input name="server" type="url" placeholder="https://…" required /></label>}
        <button className="primary" disabled={busy}>{busy ? 'Working…' : db ? 'Sign in' : 'Connect'}</button>
        {db && <button type="button" className="subtle" onClick={() => void act(async () => {
          await chrome.storage.local.remove('wcConfig');setConfig(null);
        })}>Change server</button>}
      </form>}
    {status && <p className="status" role="status">{status}</p>}
  </main>;
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
      void activeView().then(active => { if (version === next) setView(active); });
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
  return view ? <DocumentPanel key={`${view.id}:${view.tabUrl}`} {...{db,owner,origin,view}}/>
    : <p className="empty">Open a webpage or PDF to start annotating.</p>;
}

function DocumentPanel({db,owner,origin,view}:{db:SupabaseClient;owner:string;origin:string;view:View}) {
  const [threads,setThreads] = useState<Thread[]>([]);
  const [messages,setMessages] = useState<Message[]>([]);
  const [missing,setMissing] = useState<string[]>([]);
  const [status,setStatus] = useState('');
  const [busy,setBusy] = useState(false);
  const [draft,setDraft] = useState<{capture:Capture;page:{page_id:string;version_id:string};text:string;id:string}|null>(null);
  const [reply,setReply] = useState<{thread:string;text:string;id:string}|null>(null);
  const [name,setName] = useState(view.title);
  const generation = useRef(0);
  const refresh = useRef<()=>Promise<void>>(async () => {});
  const scope = useRef(view);
  scope.current = view;
  useEffect(() => {
    let live = true;
    async function update() {
      const request = ++generation.current;
      try {
        const {data:page,error} = await db.from('wc_pages').select('id').eq('source_url',view.source).maybeSingle();
        if (error) throw error;
        const nextThreads:Thread[] = [];
        const nextMessages:Message[] = [];
        if (page) {
          const readAll = async <T,>(table:string,into:T[]) => {
            for (let offset=0; ; offset+=500) {
              const {data,error} = await db.from(table).select('*').eq('page_id',page.id)
                .order('created_at').order('id').range(offset,offset+499);
              if (error) throw error;
              into.push(...data as T[]);
              if (data.length < 500) break;
            }
          };
          await Promise.all([readAll('wc_threads',nextThreads),readAll('wc_messages',nextMessages)]);
        }
        if (!live || request !== generation.current) return;
        setThreads(nextThreads); setMessages(nextMessages);
        const unmatched = await send<string[]>(scope.current,view.pdf?'wc-pdf-highlights':'wc-html-highlights',{threads:nextThreads})
          .catch(() => nextThreads.map(thread => thread.id));
        if (live && request === generation.current) setMissing(unmatched ?? []);
      } catch (error) { if (live && request === generation.current) setStatus(errorText(error)); }
    }
    refresh.current = update;
    const channel = db.channel('web-comments-'+crypto.randomUUID());
    for (const table of ['wc_pages','wc_threads','wc_messages']) {
      channel.on('postgres_changes',{schema:'public',table,event:'*'},() => void update());
    }
    channel.subscribe();
    const interval = setInterval(() => void update(),8000);
    void update();
    return () => { live=false; clearInterval(interval); void db.removeChannel(channel); };
  },[db,view.source,view.pdf]);
  const answers = new Map(messages.filter(message => message.reply_to).map(message => [message.reply_to,message]));
  const pending = messages.filter(message => message.question && !answers.has(message.id)).length;
  async function act(fn:()=>Promise<void>) {
    setBusy(true); setStatus('');
    try { await fn(); } catch (error) { setStatus(errorText(error)); }
    finally { setBusy(false); }
  }
  async function capture() {
    let result:Capture;
    try {
      result = await send<Capture>(view,view.pdf?'wc-pdf-capture':'wc-html-capture',{uploadPdf:true});
    } catch (error) {
      if (errorText(error).includes('Receiving end does not exist')) {
        throw new Error('Reload the page to enable annotation, or open it in the PDF viewer.');
      }
      throw error;
    }
    if (!result || result.url !== view.source) throw new Error('The document changed. Try again on the active page.');
    setName(result.title);
    return result;
  }
  async function copy(asLink:boolean) {
    await act(async () => {
      const snapshot = await capture();
      const page = await saveCapture(db,owner,snapshot);
      await navigator.clipboard.writeText(asLink ? `${origin}/p/${page.page_id}` : page.page_id);
      setStatus((asLink ? 'Link copied.' : 'ID copied.') + (snapshot.complete ? '' : ' Capture incomplete. '+snapshot.note));
    });
  }
  async function add(event:FormEvent, thread:string|null) {
    event.preventDefault();
    await act(async () => {
      if (!draft && !reply) return;
      const entry = thread ? reply! : draft!;
      let page = draft?.page;
      if (thread) {
        const {data,error} = await db.from('wc_pages').select('id,latest_version').eq('source_url',view.source).single();
        if (error) throw error;
        page = {page_id:data.id,version_id:data.latest_version};
      }
      if (!page) throw new Error('Save a selection first.');
      const {error} = await db.rpc('wc_add_message',{
        page:page.page_id,version:page.version_id,thread,selection:thread ? null : draft?.capture.anchor,
        message:entry.text.trim(),message_id:entry.id,
      });
      if (error) throw error;
      setDraft(null);setReply(null);
      await refresh.current();
    });
  }
  return <>
    <section className="doc">
      <h2>{name}</h2><p className="source" title={view.source}>{new URL(view.source).hostname || 'Local PDF'}</p>
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => void act(async () => {
          const snapshot = await capture();
          if (!snapshot.anchor) throw new Error('Select up to 6,000 characters in the document first.');
          const page = await saveCapture(db,owner,snapshot);
          setReply(null);setDraft({capture:snapshot,page,text:'',id:crypto.randomUUID()});
          if (!snapshot.complete) setStatus('Capture incomplete. '+snapshot.note);
        })}>Comment on selection</button>
        <button disabled={busy} onClick={() => void copy(true)}>Copy link</button>
        <button disabled={busy} onClick={() => void copy(false)}>Copy ID</button>
        {!view.pdf && <button disabled={busy} onClick={() => void chrome.tabs.update(view.id,{url:`${viewer}?url=${encodeURIComponent(view.source)}`})}>Open as PDF</button>}
      </div>
    </section>
    {status && <p className="status" role="status">{status}</p>}
    {draft && <form className="card stack" onSubmit={event => void add(event,null)}>
      <blockquote>{draft.capture.anchor?.exact}</blockquote>
      <label>New comment<textarea autoFocus required maxLength={12000} value={draft.text} onChange={event => setDraft({...draft,text:event.target.value})}/></label>
      <p className="muted">Include @AI to request an answer.</p>
      <div className="actions"><button className="primary" disabled={busy||!draft.text.trim()}>Post comment</button><button type="button" onClick={() => setDraft(null)}>Cancel</button></div>
    </form>}
    <div className="section-title"><h2>Threads</h2><span className="count">{pending} awaiting AI</span></div>
    {!threads.length && <p className="empty">Select text in the document to start a thread.</p>}
    {threads.map(thread => <article className="card stack" key={thread.id}>
      <div className="actions">
        <button className="quote" disabled={missing.includes(thread.id)} title="Go to selection"
          onClick={() => void act(async () => {
            const next = await send<string[]>(view,view.pdf?'wc-pdf-highlights':'wc-html-highlights',{threads,focus:thread.id});
            setMissing(next);
          })}>{thread.anchor.exact}</button>
        {thread.resolved && <span className="count">Resolved</span>}
      </div>
      {missing.includes(thread.id) && <p className="warning">Selection could not be matched.</p>}
      {messages.filter(message => message.thread_id===thread.id && message.role==='user').map(message => {
        const answer = answers.get(message.id);
        return <div className="message" key={message.id}>
          <p className="message-label">You {message.question && !answer && <span className="count">Awaiting AI</span>}</p>
          <Body text={message.body}/>
          {answer && <div className="answer"><p className="message-label">AI reply</p><Body text={answer.body}/></div>}
        </div>;
      })}
      {reply?.thread===thread.id ? <form className="stack" onSubmit={event => void add(event,thread.id)}>
        <label>Reply<textarea autoFocus required maxLength={12000} value={reply.text} onChange={event => setReply({...reply,text:event.target.value})}/></label>
        <div className="actions"><button className="primary" disabled={busy||!reply.text.trim()}>Post reply</button><button type="button" onClick={() => setReply(null)}>Cancel</button></div>
      </form> : <div className="actions">
        <button disabled={busy} onClick={() => {setDraft(null);setReply({thread:thread.id,text:'',id:crypto.randomUUID()});}}>Reply</button>
        <button disabled={busy} onClick={() => void act(async () => {
          const {error} = await db.rpc('wc_set_resolved',{thread:thread.id,state:!thread.resolved});
          if (error) throw error;
          await refresh.current();
        })}>{thread.resolved?'Reopen':'Resolve'}</button>
      </div>}
    </article>)}
  </>;
}
function Body({text}:{text:string}) {
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm,remarkMath]} rehypePlugins={[rehypeKatex]}
    components={{img:({alt}) => <span>{alt}</span>,a:({href,children}) => <a href={href} target="_blank" rel="noreferrer">{children}</a>}}>{text}</Markdown></div>;
}
createRoot(document.getElementById('app')!).render(<App/>);
