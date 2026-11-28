import React, { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ExtensionAccount } from './extension-account';
import { errorText } from './client';
import { savedComments } from './comment-store';
import { CommentBody } from './document-panel';
import type { PageToCard, CardToPage } from './inline-protocol';
import type { Message, Thread } from './model';
import './styles.css';
import './inline.css';

type View=Extract<PageToCard,{type:'overview'|'draft'|'thread'}>;
type Send=(message:CardToPage)=>void;

function Card() {
  const [source,setSource]=useState('');
  const [view,setView]=useState<View>({type:'overview'});
  const [missing,setMissing]=useState<string[]>([]);
  const port=useRef<chrome.runtime.Port|null>(null);
  const send=useMemo<Send>(()=>message=>port.current?.postMessage(message),[]);
  useEffect(()=>{
    if (window===window.top || !/^#[a-f\d-]{36}$/.test(location.hash)) return;
    let live=true;
    void chrome.runtime.sendMessage({type:'wc-inline-tab'}).then(result=>{
      if (!live || !Number.isInteger(result?.tabId)) return;
      const channel=chrome.tabs.connect(result.tabId,{name:'wc-inline:'+location.hash.slice(1),frameId:0});
      port.current=channel;
      channel.onMessage.addListener((message:PageToCard)=>{
        if (message.type==='page') setSource(message.source);
        else if (message.type==='missing') setMissing(message.ids);
        else setView(message);
      });
      channel.onDisconnect.addListener(()=>{port.current=null;if (live) setSource('');});
    }).catch(()=>{});
    const size=new ResizeObserver(()=>send({type:'height',pixels:document.getElementById('app')!.offsetHeight}));
    size.observe(document.getElementById('app')!);
    const escape=(event:KeyboardEvent)=>{if (event.key==='Escape') {event.preventDefault();send({type:'dismiss'});}};
    document.addEventListener('keydown',escape);
    return ()=>{live=false;size.disconnect();document.removeEventListener('keydown',escape);port.current?.disconnect();};
  },[send]);
  if (!source) return null;
  return <main className="inline-card" aria-label="Web Comments">
    <header><strong>Web Comments</strong><button type="button" aria-label="Close conversation" onClick={()=>send({type:'dismiss'})}>×</button></header>
    <ExtensionAccount compact>{({db,owner})=><Conversation key={owner+source} {...{db,owner,source,view,missing,send,setView}}/>}</ExtensionAccount>
  </main>;
}

function Conversation({db,owner,source,view,missing,send,setView}:{
  db:SupabaseClient;owner:string;source:string;view:View;missing:string[];send:Send;setView:(view:View)=>void;
}) {
  const store=useMemo(()=>savedComments(db,owner),[db,owner]);
  const [records,setRecords]=useState<{threads:Thread[];messages:Message[]}>({threads:[],messages:[]});
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [ready,setReady]=useState(false);
  const refresh=useRef<()=>Promise<typeof records|undefined>>(async()=>undefined);
  useEffect(()=>{
    let live=true,revision=0,lastAnchors='';
    async function read() {
      const current=++revision;
      try {
        const next=await store.read(source);
        if (!live || current!==revision) return;
        setRecords(next);setReady(true);
        const anchors=JSON.stringify(next.threads);
        if (anchors!==lastAnchors) { lastAnchors=anchors;send({type:'threads',threads:next.threads}); }
        return next;
      } catch (reason) {if (live && current===revision) setError(errorText(reason));}
    }
    refresh.current=read;
    const unsubscribe=store.subscribe?.(()=>void read());
    void read();
    return ()=>{live=false;unsubscribe?.();send({type:'threads',threads:[]});};
  },[source,store,send]);
  async function act(task:()=>Promise<void>) {
    setBusy(true);setError('');
    try {await task();return true;} catch (reason) {setError(errorText(reason));return false;} finally {setBusy(false);}
  }
  function open(id:string) {setView({type:'thread',id});send({type:'focus',id});}
  const thread=view.type==='thread'?records.threads.find(t=>t.id===view.id):undefined;
  const back=()=>{setView({type:'overview'});send({type:'overview'});};
  return <>
    {error && <p className="status" role="alert">{error}</p>}
    {view.type==='draft' && view.capture.anchor?.kind==='html' ? <React.Fragment key={view.capture.anchor.start+view.capture.anchor.exact}>
      <blockquote>{view.capture.anchor.exact}</blockquote>
      <Editor label="New comment" button="Post comment" busy={busy} onSubmit={(body,id)=>act(async()=>{
        if (view.capture.url!==source) throw Error('Select the passage again on this page.');
        const page=await store.save(view.capture);
        await store.add({source,page,thread:null,anchor:view.capture.anchor,body,id});
        const next=await refresh.current();
        const added=next?.messages.find(m=>m.id===id);
        if (added) open(added.thread_id);else back();
      })}/>
    </React.Fragment> : thread ? <>
      <div className="inline-heading"><h2>Thread</h2><button type="button" onClick={back}>All comments</button></div>
      <blockquote>{thread.anchor.exact}</blockquote>
      {missing.includes(thread.id) && <p className="warning">The original passage could not be located.</p>}
      {records.messages.filter(m=>m.thread_id===thread.id).map(m=><section className="message" key={m.id}>
        <p className="message-label">{m.role==='assistant'?'AI reply':'You'}</p><CommentBody text={m.body}/>
      </section>)}
      {thread.resolved ? <p>Resolved</p> : <Editor key={thread.id} label="Reply" button="Post reply" busy={busy}
        onSubmit={(body,id)=>act(async()=>{await store.add({source,thread:thread.id,body,id});await refresh.current();})}/>}
      <button type="button" disabled={busy} onClick={()=>void act(async()=>{await store.resolve(thread.id,!thread.resolved);await refresh.current();})}>
        {thread.resolved?'Reopen thread':'Resolve thread'}</button>
    </> : <>
      <h2>Page comments</h2>
      {!ready ? <p role="status">Loading comments…</p> : <p>Select a passage and choose <strong>+ Comment</strong>.</p>}
      {records.threads.map(item=><button className="inline-thread" type="button" key={item.id} onClick={()=>open(item.id)}>
        <span>{item.anchor.exact}</span>
        {item.resolved && <small>Resolved</small>}
        {missing.includes(item.id) && <small>Passage unavailable</small>}
      </button>)}
    </>}
  </>;
}

function Editor({label,button,busy,onSubmit}:{label:string;button:string;busy:boolean;onSubmit:(body:string,id:string)=>Promise<boolean>}) {
  const [text,setText]=useState('');
  const id=useRef(crypto.randomUUID());
  async function submit(event:FormEvent) {
    event.preventDefault();
    if (busy || !text.trim()) return;
    if (await onSubmit(text.trim(),id.current)) { setText('');id.current=crypto.randomUUID(); }
  }
  return <form className="inline-editor" onSubmit={event=>void submit(event)}>
    <label>{label}<textarea autoFocus={label==='New comment'} rows={2} required maxLength={12000}
      value={text} onChange={event=>setText(event.target.value)}/></label>
    <button type="submit" className="primary" disabled={busy || !text.trim()}>{button}</button>
  </form>;
}

createRoot(document.getElementById('app')!).render(<Card/>);
