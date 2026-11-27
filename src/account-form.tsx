import React, { useEffect, useId, useState, type FormEvent } from 'react';
import { isAuthError, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { confirmEmailCode, errorText, resendConfirmationCode, signInAccount, signUpAccount } from './client';

type Stage = 'sign-in'|'sign-up'|'code';
type Action = 'credentials'|'verify'|'resend';

export function AccountForm({db,initialSignUp=false,onSignedIn,onBack,backLabel}:{
  db:SupabaseClient;initialSignUp?:boolean;onSignedIn?:(session:Session)=>Promise<void>;
  onBack?:()=>void;backLabel?:string;
}) {
  const uid = useId();
  const [stage,setStage] = useState<Stage>(initialSignUp?'sign-up':'sign-in');
  const [email,setEmail] = useState('');
  const [code,setCode] = useState('');
  const [action,setAction] = useState<Action|null>(null);
  const [retryAt,setRetryAt] = useState<number|null>(null);
  const [secondsLeft,setSecondsLeft] = useState(0);
  const [status,setStatus] = useState('');
  const busy = action!==null;
  const signUp = stage === 'sign-up';

  useEffect(()=>{
    if (retryAt===null) return;
    const timer=window.setInterval(()=>{
      const remaining=Math.max(0,Math.ceil((retryAt-Date.now())/1000));
      setSecondsLeft(remaining);
      if (remaining===0) setRetryAt(null);
    },250);
    return ()=>window.clearInterval(timer);
  },[retryAt]);

  function changeStage(next:Stage) {
    setStage(next);setCode('');setStatus('');setRetryAt(null);setSecondsLeft(0);
  }
  async function run(kind:Action,request:()=>Promise<void>) {
    if (busy) return;
    setAction(kind);setStatus('');
    try { await request(); }
    catch (error) { setStatus(errorText(error)); }
    finally { setAction(null); }
  }
  function submitCredentials(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const address = String(form.get('email')).trim().toLowerCase();
    const password = String(form.get('password'));
    setEmail(address);
    void run('credentials',async ()=>{
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
    void run('verify',async ()=>{
      const session = await confirmEmailCode(db,email,token);
      await onSignedIn?.(session);
    });
  }

  function resendCode() {
    void run('resend',async ()=>{
      const retryAfter=await resendConfirmationCode(db,email);
      if (retryAfter!==null) {
        setRetryAt(Date.now()+retryAfter*1000);
        setSecondsLeft(retryAfter);
        return;
      }
      setCode('');
      setStatus('Resend requested. If your email is awaiting confirmation, check your inbox and spam for the latest message.');
    });
  }

  return <>
    {stage === 'code' ? <form key="code" onSubmit={submitCode} className="card stack" method="post">
      <h2>Check your email</h2>
      <p>Enter the six-digit code from the confirmation email for <strong>{email}</strong>.</p>
      <label htmlFor={uid+'-code'}>Verification code</label>
      <input id={uid+'-code'} name="code" type="text" inputMode="numeric" autoComplete="one-time-code"
        pattern="[0-9]{6}" maxLength={6} required autoFocus value={code}
        onChange={event=>setCode(event.target.value)}/>
      <button className="primary" type="submit" disabled={busy}>{action==='verify' ? 'Verifying…' : 'Verify email'}</button>
      <div className="actions">
        <button type="button" className="subtle" disabled={busy || retryAt!==null} onClick={resendCode}>
          {action==='resend' ? 'Sending…' : secondsLeft>0 ? `Resend code in ${secondsLeft}s` : 'Resend code'}
        </button>
        <button type="button" className="subtle" disabled={busy} onClick={()=>changeStage('sign-up')}>Change email</button>
        <button type="button" className="subtle" disabled={busy} onClick={()=>changeStage('sign-in')}>Back to sign in</button>
      </div>
      <p className="muted">If you’ve already confirmed this email, go back to sign in. If your email has a confirmation link, open it to confirm your account.</p>
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
    {(status || retryAt!==null) && <p className="status" role="status">
      {status || 'You can request another code when the timer ends.'}
    </p>}
  </>;
}
