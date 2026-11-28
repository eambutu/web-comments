import React, { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { defaultServerOrigin, errorText, extensionClient, loadConfig, type Config } from './client';
import { BrowserSignIn, SidePanel } from './side-panel';

export function ExtensionAccount({children,compact=false}:{children:(account:{db:SupabaseClient;owner:string;origin:string})=>React.ReactNode;compact?:boolean}) {
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
    const key='sb-'+new URL(config!.supabaseUrl).hostname.split('.')[0]+'-auth-token';
    function storageChanged(changes:{[key:string]:chrome.storage.StorageChange},area:string) {
      if (area!=='local' || !changes[key]) return;
      if (!changes[key].newValue) {setSession(null);setLoaded(true);}
      else sessionUpdated({type:'wc-session-updated'});
    }
    chrome.storage.onChanged.addListener(storageChanged);
    chrome.runtime.onMessage.addListener(sessionUpdated);
    return () => {
      subscription.unsubscribe();
      chrome.storage.onChanged.removeListener(storageChanged);
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
  const content=<>
    {!loaded ? <p>Loading…</p>
      : !db || !config ? <form onSubmit={submit} className="card stack">
        <h2>Connect your server</h2>
        <label>Server address<input name="server" type="url" defaultValue={defaultServerOrigin} placeholder="https://…" required /></label>
        <button className="primary" disabled={busy}>{busy ? 'Working…' : 'Connect'}</button>
      </form>
      : !session ? <BrowserSignIn busy={busy} onOpen={openSignIn} onChangeServer={()=>void act(async ()=>{
        await chrome.storage.local.remove('wcConfig');setConfig(null);
      })}/>
      : <React.Fragment key={session.user.id}>{children({db,owner:session.user.id,origin:config.origin})}</React.Fragment>}
    {status && <p className="status" role="status">{status}</p>}
  </>;
  if (compact) return content;
  return <SidePanel standalone busy={busy} onSignOut={db && session ? () => void act(async () => {
    const {error}=await db.auth.signOut();
    if (error) throw error;
  }) : undefined}>{content}</SidePanel>;
}
