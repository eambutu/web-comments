import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { hash, type Capture } from './model';

declare const DEFAULT_WEB_COMMENTS_ORIGIN: string;
export const defaultServerOrigin = DEFAULT_WEB_COMMENTS_ORIGIN;

export type Config = {
  supabaseUrl:string;
  publishableKey:string;
  origin:string;
  clientId:string|null;
};
export async function loadConfig(address:string):Promise<Config> {
  const origin = new URL(address).origin;
  if (!origin.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    throw new Error('Enter the HTTPS address of your Web Comments server.');
  }
  const response = await fetch(origin + '/config.json');
  if (!response.ok) throw new Error('Could not load Web Comments configuration.');
  const config = await response.json();
  if (config.origin !== origin || !config.publishableKey || !config.supabaseUrl) throw new Error('Invalid server configuration.');
  return config;
}
export function extensionClient(config:Config, autoRefreshToken=true) {
  return createClient(config.supabaseUrl,config.publishableKey,{
    auth:{autoRefreshToken,storage:{
      getItem:async key => ((await chrome.storage.local.get(key))[key] as string | undefined) ?? null,
      setItem:async (key,value) => { await chrome.storage.local.set({[key]:value}); },
      removeItem:async key => { await chrome.storage.local.remove(key); },
    }},
  });
}
export async function signUpAccount(db:SupabaseClient, origin:string, email:string, password:string) {
  if (password.length < 12 || new TextEncoder().encode(password).byteLength > 72) {
    throw new Error('Use at least 12 characters and at most 72 bytes for your password.');
  }
  const {data,error} = await db.auth.signUp({
    email:email.trim().toLowerCase(),password,
    options:{emailRedirectTo:origin+'/sign-in'},
  });
  if (error?.code === 'email_address_not_authorized' || error?.code === 'unexpected_failure') {
    throw new Error('Confirmation emails are currently unavailable. Try again once email delivery is set up.');
  }
  if (error) throw error;
  return data.session;
}
export async function signInAccount(db:SupabaseClient,email:string,password:string) {
  const {data,error} = await db.auth.signInWithPassword({email:email.trim().toLowerCase(),password});
  if (error?.code === 'email_not_confirmed') {
    throw new Error('Confirm your email using the link we sent, then sign in.');
  }
  if (error) throw error;
  if (!data.session) throw new Error('Could not start a sign-in session.');
  return data.session;
}
export async function upload(db:SupabaseClient, path:string, content:Blob) {
  const {error} = await db.storage.from('web-comments').upload(path,content,{upsert:false});
  if (error) {
    const existing = await db.storage.from('web-comments').exists(path);
    if (!existing.data) throw error;
  }
}
export async function saveCapture(db:SupabaseClient, owner:string, capture:Capture) {
  const documentHash = await hash(capture.text);
  const fingerprint = await hash(JSON.stringify([documentHash,capture.kind,capture.complete,capture.note,capture.binaryHash]));
  const file = new Blob([capture.text],{type:'text/plain;charset=utf-8'});
  const path = file.size > 512_000 ? `${owner}/${documentHash}.txt` : null;
  if (path) await upload(db,path,file);
  let pdfPath=capture.pdfPath;
  if (capture.pdfBlob && capture.binaryHash && !pdfPath) {
    pdfPath=`${owner}/${capture.binaryHash}.pdf`;
    await upload(db,pdfPath,capture.pdfBlob);
  }
  const {data,error} = await db.rpc('wc_capture',{
    source:capture.url,document_title:capture.title,document_kind:capture.kind,
    document_hash:documentHash,capture_fingerprint:fingerprint,is_complete:capture.complete,note:capture.note,
    document_text:path ? null : capture.text,snapshot_path:path,binary_path:pdfPath ?? null,
  });
  if (error) throw error;
  return data as {page_id:string;version_id:string};
}
export function errorText(error:unknown) {
  return typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
}
