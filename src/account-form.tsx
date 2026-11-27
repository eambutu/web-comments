import React, { useId, useState, type FormEvent } from 'react';
import { isAuthError, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { confirmEmailCode, errorText, resendConfirmationCode, signInAccount, signUpAccount } from './client';

type Stage = 'sign-in'|'sign-up'|'code';

export function AccountForm({db,initialSignUp=false,onSignedIn,onBack,backLabel}:{
  db:SupabaseClient;initialSignUp?:boolean;onSignedIn?:(session:Session)=>Promise<void>;
  onBack?:()=>void;backLabel?:string;
}) {
  const uid = useId();
  const [stage,setStage] = useState<Stage>(initialSignUp?'sign-up':'sign-in');
  const [email,setEmail] = useState('');
  const [code,setCode] = useState('');
  const [busy,setBusy] = useState(false);
  const [status,setStatus] = useState('');
  const signUp = stage === 'sign-up';

  function changeStage(next:Stage) {
    setStage(next);setCode('');setStatus('');
  }
  async function run(action:()=>Promise<void>) {
    setBusy(true);setStatus('');
    try { await action(); }
    catch (error) { setStatus(errorText(error)); }
    finally { setBusy(false); }
  }
  function submitCredentials(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const address = String(form.get('email')).trim().toLowerCase();
    const password = String(form.get('password'));
    setEmail(address);
    void run(async ()=>{
      const session = signUp ? await signUpAccount(db,address,password) :
        await signInAccount(db,address,password).catch(error=>{
          if (!isAuthError(error) || error.code!=='email_not_confirmed') throw error;
          return null;
        });
      if (session) {
        await onSignedIn?.(session);
        return;
      }
      changeStage('code');
      if (!signUp) setStatus('Your email still needs confirmation. Enter your code or request a new one.');
    });
  }
  function submitCode(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = String(new FormData(event.currentTarget).get('code'));
    void run(async ()=>{
      const session = await confirmEmailCode(db,email,token);
      await onSignedIn?.(session);
    });
  }

  return <>
    {stage === 'code' ? <form key="code" onSubmit={submitCode} className="card stack" method="post">
      <h2>Check your email</h2>
      <p>Enter the six-digit code sent to <strong>{email}</strong>.</p>
      <label htmlFor={uid+'-code'}>Verification code</label>
      <input id={uid+'-code'} name="code" type="text" inputMode="numeric" autoComplete="one-time-code"
        pattern="[0-9]{6}" maxLength={6} required autoFocus value={code}
        onChange={event=>setCode(event.target.value)}/>
      <button className="primary" type="submit" disabled={busy}>{busy ? 'Working…' : 'Verify email'}</button>
      <div className="actions">
        <button type="button" className="subtle" disabled={busy} onClick={()=>void run(async ()=>{
          await resendConfirmationCode(db,email);
          setCode('');
          setStatus('We sent a new confirmation email. Use the latest message.');
        })}>Resend code</button>
        <button type="button" className="subtle" disabled={busy} onClick={()=>changeStage('sign-up')}>Change email</button>
        <button type="button" className="subtle" disabled={busy} onClick={()=>changeStage('sign-in')}>Back to sign in</button>
      </div>
      <p className="muted">If your email only has a confirmation link, open it before signing in.</p>
    </form> : <form key={stage} onSubmit={submitCredentials} className="card stack" method="post">
      <h2>{signUp ? 'Create your account' : 'Sign in'}</h2>
      <label htmlFor={uid+'-email'}>Email address</label>
      <input id={uid+'-email'} name="email" type="email" required defaultValue={email}
        autoComplete="username" autoCapitalize="none" spellCheck={false}/>
      <label htmlFor={uid+'-password'}>Password</label>
      <input id={uid+'-password'} name="password" type="password" required minLength={signUp ? 12 : undefined}
        autoComplete={signUp ? 'new-password' : 'current-password'}/>
      {signUp && <p>Use at least 12 characters. We’ll email you instructions to confirm your address.</p>}
      <button className="primary" type="submit" disabled={busy}>{busy ? 'Working…' : signUp ? 'Create account' : 'Sign in'}</button>
      <div className="actions">
        <button type="button" className="subtle" disabled={busy} onClick={()=>changeStage(signUp?'sign-in':'sign-up')}>
          {signUp ? 'Back to sign in' : 'Sign up'}
        </button>
        {onBack && <button type="button" className="subtle" disabled={busy} onClick={onBack}>{backLabel}</button>}
      </div>
    </form>}
    {status && <p className="status" role="status">{status}</p>}
  </>;
}
