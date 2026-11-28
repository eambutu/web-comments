import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { errorText } from './client';
import type { Entry } from './library-data';

export function LibrarySource({entry,active,disabled,onOpen,onRemove}:{
  entry:Entry;active:boolean;disabled:boolean;onOpen:()=>void;onRemove:()=>void;
}) {
  const hold=useRef<{timer:number;x:number;y:number}|null>(null);
  const suppressClick=useRef(false);
  function cancelHold() {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current=null;
  }
  useEffect(()=>cancelHold,[disabled]);

  function requestRemoval(button:HTMLButtonElement) {
    cancelHold();
    if (button.disabled) return;
    button.focus({preventScroll:true});
    onRemove();
  }
  return <div className="library-item-row">
    <button type="button" className="library-item" id={'library-source-'+entry.id}
      aria-current={active?'page':undefined} disabled={disabled}
      onContextMenu={event=>{
        event.preventDefault();
        suppressClick.current=true;
        requestRemoval(event.currentTarget);
      }}
      onKeyDown={event=>{
        if (event.key==='ContextMenu' || (event.shiftKey && event.key==='F10')) {
          event.preventDefault();
          requestRemoval(event.currentTarget);
        }
      }}
      onPointerDown={event=>{
        cancelHold();
        suppressClick.current=false;
        if (event.pointerType!=='touch' || !event.isPrimary) return;
        const button=event.currentTarget;
        hold.current={x:event.clientX,y:event.clientY,timer:window.setTimeout(()=>{
          suppressClick.current=true;
          requestRemoval(button);
        },550)};
      }}
      onPointerMove={event=>{
        const start=hold.current;
        if (start && Math.hypot(event.clientX-start.x,event.clientY-start.y)>10) cancelHold();
      }}
      onPointerUp={cancelHold} onPointerCancel={cancelHold} onPointerLeave={cancelHold}
      onClick={event=>{
        if (event.detail===0 || !suppressClick.current) onOpen();
        suppressClick.current=false;
      }}>
      <span className="library-kind">{entry.kind==='pdf'?'PDF':'HTML'}</span>
      <span className="library-item-text"><strong>{entry.title}</strong><small>{new URL(entry.source).hostname}</small></span>
    </button>
    <button type="button" className="library-source-remove" disabled={disabled} aria-haspopup="dialog"
      aria-label={'Remove '+entry.title+' from library'} onClick={event=>requestRemoval(event.currentTarget)}>Remove</button>
  </div>;
}

export function RemoveSourceDialog({entry,onCancel,onRemove}:{
  entry:Entry;onCancel:()=>void;onRemove:()=>Promise<void>;
}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  useLayoutEffect(()=>{
    const node=dialog.current!;
    node.showModal();
    return ()=>node.close();
  },[]);

  async function remove() {
    setPending(true);
    setError('');
    try { await onRemove(); }
    catch (error) {
      setError('Could not remove this source. '+errorText(error));
      setPending(false);
    }
  }
  return <dialog className="library-remove-dialog" ref={dialog} aria-labelledby="remove-source-title"
    aria-describedby="remove-source-url remove-source-detail"
    onCancel={event=>{event.preventDefault();if (!pending) onCancel();}}>
    <h2 id="remove-source-title">Remove “{entry.title}” from your library?</h2>
    <p id="remove-source-url">{entry.source}</p>
    <p id="remove-source-detail">Your comments will be available if you import this URL again.</p>
    {error && <p className="status" role="alert">{error}</p>}
    <div className="actions">
      <button type="button" autoFocus disabled={pending} onClick={onCancel}>Cancel</button>
      <button type="button" className="library-confirm-remove" disabled={pending}
        onClick={()=>void remove()}>{pending?'Removing…':'Remove source'}</button>
    </div>
  </dialog>;
}
