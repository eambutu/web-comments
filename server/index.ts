import express from 'express';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createReviewServer } from './review';
import { ImportError, importDocument } from './import-document';
import { archivePolicy } from '../shared/article-archive';

function env(key: string) {
  const value = process.env[key];
  if (!value) throw new Error(`Set ${key} before starting Web Comments.`);
  return value;
}
const origin = new URL(process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || env('PUBLIC_ORIGIN')).origin;
const supabaseUrl = new URL(env('SUPABASE_URL')).origin;
const publishableKey = env('SUPABASE_PUBLISHABLE_KEY');
const clientId = process.env.MCP_OAUTH_CLIENT_ID || null;
const authOptions = {persistSession:false,autoRefreshToken:false};
const publicDb = createClient(supabaseUrl,publishableKey,{auth:authOptions});
const accountInput = z.object({
  login:z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{2,31}$/),
  password:z.string().min(1).refine(value => Buffer.byteLength(value,'utf8') <= 72),
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit:'256kb'}));

const metadata = {
  resource: origin + '/mcp',
  authorization_servers: [supabaseUrl + '/auth/v1'],
  bearer_methods_supported: ['header'],
};
app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req,res) => res.json(metadata));
app.get('/healthz', async (_req,res) => {
  const {data,error} = await publicDb.rpc('wc_public_health').abortSignal(AbortSignal.timeout(5000));
  if (data !== true || error) {
    console.warn('Database readiness check failed',error?.code ?? '');
    res.status(503).json({ok:false});
    return;
  }
  res.json({ok:true});
});
app.get('/config.json', (_req,res) => {
  res.set('Cache-Control','no-store');
  res.json({supabaseUrl,publishableKey,origin,clientId});
});
// Keep older clients able to sign into accounts created with usernames.
app.post('/auth/username-login', async (req,res) => {
  res.set('Cache-Control','no-store');
  const input = accountInput.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({error:'Invalid username or password.'});
    return;
  }
  const response = await fetch(supabaseUrl+'/functions/v1/web-comments-enroll',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:'username-login',...input.data}),signal:AbortSignal.timeout(15000),
  }).catch(() => null);
  if (response?.status === 200) {
    const tokens = await response.json().catch(() => null);
    if (typeof tokens?.access_token === 'string' && typeof tokens?.refresh_token === 'string') {
      res.json({access_token:tokens.access_token,refresh_token:tokens.refresh_token});
      return;
    }
  } else if (response?.status === 401) {
    res.status(401).json({error:'Invalid username or password.'});
    return;
  } else if (response?.status === 429) {
    res.status(429).json({error:'Too many attempts. Try again in a few minutes.'});
    return;
  }
  res.status(502).json({error:'Sign-in is temporarily unavailable. Try again shortly.'});
});
const activeImports=new Set<string>();
app.post('/api/import', async (req,res) => {
  res.set('Cache-Control','no-store');
  const token=req.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token || token.length>16000) {
    res.status(401).json({error:'Sign in to import a document.'});
    return;
  }
  const {data:{user}}=await publicDb.auth.getUser(token);
  if (!user || user.is_anonymous || !user.email_confirmed_at) {
    res.status(401).json({error:'Sign in with a confirmed email to import a document.'});
    return;
  }
  const input=z.object({url:z.string().trim().min(1).max(2048),archive:z.boolean().optional()}).safeParse(req.body);
  if (!input.success) {
    res.status(400).json({error:'Enter a public article or PDF link.'});
    return;
  }
  if (activeImports.has(user.id) || activeImports.size>=4) {
    res.status(429).json({error:'An import is already in progress. Try again in a moment.'});
    return;
  }
  activeImports.add(user.id);
  try {
    const result=await importDocument(input.data.url,input.data.archive);
    if (result.kind==='pdf') {
      res.type('application/pdf').set('X-Web-Comments-Source',result.url).send(result.body);
    } else res.json(result);
  } catch (error) {
    if (!(error instanceof ImportError)) throw error;
    res.status(error.status).json({error:error.message});
  } finally {
    activeImports.delete(user.id);
  }
});
app.use('/assets', express.static(fileURLToPath(new URL('./web/assets/',import.meta.url))));
app.get('/archive-frame',(_req,res)=>{
  res.set('Content-Security-Policy',archivePolicy+"; sandbox allow-same-origin; frame-ancestors 'self'");
  res.set('Referrer-Policy','no-referrer');
  res.type('html').send('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
});
app.get('/downloads/chrome-extension.zip', (_req,res) => {
  res.download(fileURLToPath(new URL('./web/chrome-extension.zip',import.meta.url)),'web-comments-chrome-extension.zip');
});
app.get(['/oauth/consent','/library','/playground','/signup','/sign-in','/extension/sign-in','/p/:id','/'], (req,res) => {
  if (/\/(?:sign-in|signup)\/?$/.test(req.path)) res.set('Cache-Control','no-store');
  const realtime = supabaseUrl.replace(/^http(s?):/, 'ws$1:');
  const path=req.path.replace(/\/$/,'');
  const images=path==='/library'?"img-src data:; frame-src 'self'; ":'';
  res.set('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; worker-src 'self'; ${images} connect-src ${supabaseUrl} ${realtime} 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  res.set('Referrer-Policy','no-referrer');
  const page=path==='/library'?'library.html':path==='/playground'?'playground.html':'index.html';
  res.sendFile(fileURLToPath(new URL('./web/'+page,import.meta.url)));
});

app.all('/mcp', async (req,res) => {
  if (!clientId) {
    res.status(503).json({error:'The ChatGPT OAuth connection has not been configured.'});
    return;
  }
  const token = req.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
  const supabase = createClient(supabaseUrl,publishableKey,{
    auth:authOptions,
    global:{headers:{Authorization:`Bearer ${token ?? ''}`}},
  });
  const auth = token ? await supabase.auth.getClaims(token) : null;
  const claims = auth?.data?.claims;
  const user = claims && token && claims.client_id === clientId ? (await supabase.auth.getUser(token)).data.user : null;
  if (!user || claims?.client_id !== clientId
      || claims?.iss !== supabaseUrl + '/auth/v1' || claims?.role !== 'authenticated'
      || claims?.aud !== 'authenticated' || claims?.sub !== user.id) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
    res.status(401).json({error:'A Web Comments OAuth token for the configured client is required.'});
    return;
  }
  const server = createReviewServer(supabase,origin);
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  res.on('close', () => { void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req,res,req.body);
});
app.use(((error,_req,res,_next) => {
  console.error('Web Comments request failed',error.code ?? error.status ?? 'unknown');
  if (!res.headersSent) res.status(500).json({error:'Web Comments could not complete this request.'});
}) satisfies express.ErrorRequestHandler);
app.listen(Number(process.env.PORT ?? 8787),'0.0.0.0',() => console.log('Web Comments is ready.'));
