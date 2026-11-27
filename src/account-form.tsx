import React, { useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errorText, signInAccount, signUpAccount } from './client';

export function AccountForm({db,origin,onBack,backLabel}:{
  db:SupabaseClient;origin:string;onBack?:()=>void;backLabel?:string;
}) {
  const [signUp,setSignUp] = useState(false);
  const [busy,setBusy] = useState(false);
  const [status,setStatus] = useState('');
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const login = String(form.get('login'));
    const password = String(form.get('password'));
    setBusy(true);setStatus('');
    try {
      if (signUp) {
        await signUpAccount(origin,login,password);
        setSignUp(false);
      }
      await signInAccount(db,origin,login,password);
    } catch (error) { setStatus(errorText(error)); }
    finally { setBusy(false); }
  }

  return <>
    <form key={String(signUp)} onSubmit={event=>void submit(event)} className="card stack">
      <h2>{signUp ? 'Create your account' : 'Sign in'}</h2>
      <label>{signUp ? 'Username' : 'Username or email'}
        <input name="login" type="text" required autoComplete="username" autoCapitalize="none" spellCheck={false}
          minLength={signUp ? 3 : undefined} maxLength={signUp ? 32 : undefined}
          pattern={signUp ? '[A-Za-z][A-Za-z0-9_\\-]{2,31}' : undefined}
          title={signUp ? 'Start with a letter. Use only letters, numbers, underscores or hyphens.' : undefined}/>
      </label>
      <label>Password<input name="password" type="password" required minLength={signUp ? 12 : undefined}
        autoComplete={signUp ? 'new-password' : 'current-password'}/></label>
      {signUp && <p>Use at least 12 characters. Save your password so you can sign in again.</p>}
      <button className="primary" disabled={busy}>{busy ? 'Working…' : signUp ? 'Create account' : 'Sign in'}</button>
      <div className="actions">
        <button type="button" className="subtle" disabled={busy} onClick={() => {
          setSignUp(!signUp);setStatus('');
        }}>{signUp ? 'Back to sign in' : 'Sign up'}</button>
        {onBack && <button type="button" className="subtle" disabled={busy} onClick={onBack}>{backLabel}</button>}
      </div>
    </form>
    {status && <p className="status" role="status">{status}</p>}
  </>;
}
