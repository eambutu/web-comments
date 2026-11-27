import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { errorText } from './client';
import type { CommentStore, SavedPage } from './comment-store';
import type { Capture, Message, Thread } from './model';

export type DocumentView = {
  source:string;title:string;
  capture():Promise<Capture>;
  highlight(threads:Thread[],focus?:string):Promise<string[]>;
  openAsPdf?():void;
};

export function DocumentPanel({store,view,pageLink}:{store:CommentStore;view:DocumentView;pageLink?:(id:string)=>string}) {
  const [threads,setThreads] = useState<Thread[]>([]);
  const [messages,setMessages] = useState<Message[]>([]);
  const [missing,setMissing] = useState<string[]>([]);
  const [status,setStatus] = useState('');
  const [manualCopy,setManualCopy] = useState<{label:string;value:string}|null>(null);
  const [busy,setBusy] = useState(false);
  const [draft,setDraft] = useState<{capture:Capture;page:SavedPage;text:string;id:string}|null>(null);
  const [reply,setReply] = useState<{thread:string;text:string;id:string}|null>(null);
  const [name,setName] = useState(view.title);
  const generation = useRef(0);
  const refresh = useRef<()=>Promise<void>>(async () => {});
  useEffect(() => {
    let live = true;
    async function update() {
      const request = ++generation.current;
      try {
        const next = await store.read(view.source);
        if (!live || request !== generation.current) return;
        setThreads(next.threads);setMessages(next.messages);
        const unmatched = await view.highlight(next.threads).catch(() => next.threads.map(thread => thread.id));
        if (live && request === generation.current) setMissing(unmatched ?? []);
      } catch (error) { if (live && request === generation.current) setStatus(errorText(error)); }
    }
    refresh.current = update;
    const unsubscribe = store.subscribe?.(() => void update());
    void update();
    return () => {
      live=false;
      unsubscribe?.();
      void view.highlight([]).catch(() => {});
    };
  },[store,view]);
  const answers = new Map(messages.filter(message => message.reply_to).map(message => [message.reply_to,message]));
  const pending = messages.filter(message => message.question && !answers.has(message.id)).length;
  async function act(fn:()=>Promise<void>) {
    setBusy(true); setStatus('');
    try { await fn(); } catch (error) { setStatus(errorText(error)); }
    finally { setBusy(false); }
  }
  async function capture() {
    const result = await view.capture();
    if (!result || result.url !== view.source) throw new Error('The document changed. Try again on the active page.');
    setName(result.title);
    return result;
  }
  async function copy(asLink:boolean) {
    await act(async () => {
      if (!pageLink) return;
      setManualCopy(null);
      const snapshot = await capture();
      const page = await store.save(snapshot);
      const value = asLink ? pageLink(page.page_id) : page.page_id;
      const label = asLink ? 'Page link' : 'Page ID';
      try {
        await navigator.clipboard.writeText(value);
        setStatus((asLink ? 'Link copied.' : 'ID copied.') + (snapshot.complete ? '' : ' Capture incomplete. '+snapshot.note));
      } catch {
        setManualCopy({label,value});
        setStatus((snapshot.complete ? '' : 'Capture incomplete. '+snapshot.note+' ')+'Select and copy the '+label.toLowerCase()+'.');
      }
    });
  }
  async function add(event:FormEvent, thread:string|null) {
    event.preventDefault();
    await act(async () => {
      if (!draft && !reply) return;
      const entry = thread ? reply! : draft!;
      await store.add({source:view.source,page:draft?.page,thread,anchor:draft?.capture.anchor,
        body:entry.text.trim(),id:entry.id});
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
          const page = await store.save(snapshot);
          setReply(null);setDraft({capture:snapshot,page,text:'',id:crypto.randomUUID()});
          if (!snapshot.complete) setStatus('Capture incomplete. '+snapshot.note);
        })}>Comment on selection</button>
        {pageLink && <>
          <button disabled={busy} onClick={() => void copy(true)}>Copy link</button>
          <button disabled={busy} onClick={() => void copy(false)}>Copy ID</button>
        </>}
        {view.openAsPdf && <button disabled={busy} onClick={view.openAsPdf}>Open as PDF</button>}

      </div>
    </section>
    {status && <p className="status" role="status">{status}</p>}
    {manualCopy && <label>{manualCopy.label}
      <input readOnly value={manualCopy.value} onFocus={event=>event.currentTarget.select()}/>
    </label>}
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
            const next = await view.highlight(threads,thread.id);
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
          {answer && <div className="answer"><p className="message-label">{store.previewReplies ? 'Sample AI reply' : 'AI reply'}</p><Body text={answer.body}/></div>}
        </div>;
      })}
      {reply?.thread===thread.id ? <form className="stack" onSubmit={event => void add(event,thread.id)}>
        <label>Reply<textarea autoFocus required maxLength={12000} value={reply.text} onChange={event => setReply({...reply,text:event.target.value})}/></label>
        <div className="actions"><button className="primary" disabled={busy||!reply.text.trim()}>Post reply</button><button type="button" onClick={() => setReply(null)}>Cancel</button></div>
      </form> : <div className="actions">
        <button disabled={busy} onClick={() => {setDraft(null);setReply({thread:thread.id,text:'',id:crypto.randomUUID()});}}>Reply</button>
        <button disabled={busy} onClick={() => void act(async () => {
          await store.resolve(thread.id,!thread.resolved);
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
