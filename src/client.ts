import { createClient, type AuthError, type SupabaseClient } from '@supabase/supabase-js';
import { captureFingerprint, hash, type Capture } from './model';
import { archivePath, type SavedArchive } from './archive-storage';

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
function checkEmailDelivery(error:AuthError|null) {
  if (error?.code === 'email_address_not_authorized' || error?.code === 'unexpected_failure') {
    throw new Error('Confirmation emails are currently unavailable. Try again later.');
  }
  if (error?.code === 'over_email_send_rate_limit' || error?.code === 'over_request_rate_limit') {
    throw new Error('Too many requests to send a confirmation email. Try again later.');
  }
  if (error) throw error;
}

export async function signUpAccount(db:SupabaseClient,email:string,password:string) {
  if (password.length < 12 || new TextEncoder().encode(password).byteLength > 72) {
    throw new Error('Use at least 12 characters and at most 72 bytes for your password.');
  }
  const {data,error} = await db.auth.signUp({email,password});
  checkEmailDelivery(error);
  return data.session;
}

export async function confirmEmailCode(db:SupabaseClient,email:string,token:string) {
  const {data,error} = await db.auth.verifyOtp({email,token,type:'email'});
  if (error?.code === 'otp_expired') {
    throw new Error('That code is invalid or expired. Use the latest email or request a new code.');
  }
  if (error) throw error;
  if (!data.session) throw new Error('Could not start a sign-in session.');
  return data.session;
}

export async function resendConfirmationCode(db:SupabaseClient,email:string) {
  const {error} = await db.auth.resend({email,type:'signup'});
  if (error?.code==='over_email_send_rate_limit') {
    const seconds = Number(/\bafter (\d+) seconds?\b/i.exec(error.message)?.[1]);
    // Supabase reports the remaining wait in whole seconds rounded down.
    if (Number.isSafeInteger(seconds) && seconds>=0) return seconds+1;
  }
  checkEmailDelivery(error);
  return null;
}

export async function signInAccount(db:SupabaseClient,email:string,password:string) {
  const {data,error} = await db.auth.signInWithPassword({email,password});
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
export async function saveCapture(db:SupabaseClient, owner:string, capture:Capture, snapshotHtml?:string|null,archive?:SavedArchive) {
  const documentHash = await hash(capture.text);
  const fingerprint=await captureFingerprint(documentHash,capture,snapshotHtml,archive?.digest);
  if (archive) {
    const path=archivePath(owner,fingerprint);
    if (archive.path!==path) {
      // Store immutable bytes before publishing the version, including on retries.
      await upload(db,path,archive.file);
      archive.path=path;
    }
  }
  const file = new Blob([capture.text],{type:'text/plain;charset=utf-8'});
  const path = file.size > 512_000 ? `${owner}/${documentHash}.txt` : null;
  if (path) await upload(db,path,file);
  let pdfPath=capture.pdfPath;
  if (capture.pdfBlob && capture.binaryHash && !pdfPath) {
    pdfPath=`${owner}/${capture.binaryHash}.pdf`;
    await upload(db,pdfPath,capture.pdfBlob);
  }
  const {data,error} = await db.rpc(snapshotHtml===undefined?'wc_capture':'wc_save_import',{
    source:capture.url,document_title:capture.title,document_kind:capture.kind,
    document_hash:documentHash,capture_fingerprint:fingerprint,is_complete:capture.complete,note:capture.note,
    document_text:path ? null : capture.text,snapshot_path:path,binary_path:pdfPath ?? null,
    ...(snapshotHtml===undefined?{}:{snapshot_html:snapshotHtml}),
  });
  if (error) throw error;
  return data as {page_id:string;version_id:string};
}
export function errorText(error:unknown) {
  return typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
}
