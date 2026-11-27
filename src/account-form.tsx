import React, { useId, useState, type FormEvent } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { errorText, signInAccount, signUpAccount } from './client';

export function AccountForm({db,origin,initialSignUp=false,onSignedIn,onBack,backLabel}:{
  db:SupabaseClient;origin:string;initialSignUp?:boolean;onSignedIn?:(session:Session)=>Promise<void>;
  onBack?:()=>void;backLabel?:string;
}) {
  const uid = useId();
  const [signUp,setSignUp] = useState(initialSignUp);
  const [email,setEmail] = useState('');
  const [awaitingEmail,setAwaitingEmail] = useState(false);
  const [busy,setBusy] = useState(false);
  const [status,setStatus] = useState('');

  function changeMode(next:boolean) {
    setSignUp(next);setAwaitingEmail(false);setStatus('');
  }
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const address = String(form.get('email')).trim();
    const password = String(form.get('password'));
    setEmail(address);setBusy(true);setStatus('');
    try {
      const session = signUp ? await signUpAccount(db,origin,address,password) : await signInAccount(db,address,password);
      if (session) await onSignedIn?.(session);
      else setAwaitingEmail(true);
    } catch (error) { setStatus(errorText(error)); }
    finally { setBusy(false); }
  }
  if (awaitingEmail) return <section className="card stack">
    <h2>Check your email</h2>
    <p>Open the confirmation link for <strong>{email}</strong>, then sign in here.</p>
    <button className="primary" type="button" onClick={()=>changeMode(false)}>Back to sign in</button>
  </section>;

  return <>
    <form key={String(signUp)} onSubmit={event=>void submit(event)} className="card stack" method="post">
      <h2>{signUp ? 'Create your account' : 'Sign in'}</h2>
      <label htmlFor={uid+'-email'}>Email address</label>
      <input id={uid+'-email'} name="email" type="email" required defaultValue={email}
        autoComplete="username" autoCapitalize="none" spellCheck={false}/>
      <label htmlFor={uid+'-password'}>Password</label>
      <input id={uid+'-password'} name="password" type="password" required minLength={signUp ? 12 : undefined}
        autoComplete={signUp ? 'new-password' : 'current-password'}/>
      {signUp && <p>Use at least 12 characters. We’ll send you a link to confirm your email address.</p>}
      <button className="primary" type="submit" disabled={busy}>{busy ? 'Working…' : signUp ? 'Create account' : 'Sign in'}</button>
      <div className="actions">
        <button type="button" className="subtle" disabled={busy} onClick={()=>changeMode(!signUp)}>
          {signUp ? 'Back to sign in' : 'Sign up'}
        </button>
        {onBack && <button type="button" className="subtle" disabled={busy} onClick={onBack}>{backLabel}</button>}
      </div>
    </form>
    {status && <p className="status" role="status">{status}</p>}
  </>;
}
