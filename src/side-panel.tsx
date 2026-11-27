import React, { type ReactNode } from 'react';

export function SidePanel({children,onSignOut,busy,standalone=false}:{
  children:ReactNode;onSignOut?:()=>void;busy?:boolean;standalone?:boolean;
}) {
  const Frame = standalone ? 'main' : 'aside';
  return <Frame className="shell side-panel" aria-label="Web Comments side panel">
    <header className="brand">
      <span aria-hidden="true">WC</span><h1>Web Comments</h1>
      {onSignOut && <button type="button" className="subtle" disabled={busy} onClick={onSignOut}>Sign out</button>}
    </header>
    {children}
  </Frame>;
}

export function BrowserSignIn({onOpen,onChangeServer,busy}:{
  onOpen:(signUp:boolean)=>void;onChangeServer?:()=>void;busy?:boolean;
}) {
  return <section className="card stack">
    <h2>Sign in</h2>
    <p>Sign in with your email and password in a Chrome tab, where 1Password can fill your login.</p>
    <button className="primary" type="button" disabled={busy} onClick={()=>onOpen(false)}>Sign in in browser</button>
    <div className="actions">
      <button type="button" className="subtle" disabled={busy} onClick={()=>onOpen(true)}>Sign up</button>
      {onChangeServer && <button type="button" className="subtle" disabled={busy} onClick={onChangeServer}>Change server</button>}
    </div>
  </section>;
}
