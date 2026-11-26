import express from 'express';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { instructions, referenceId, uuidRegex, resolvePage, readContent, readComments, postReply } from './review';

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
app.post(['/auth/signup','/auth/username-login'], async (req,res) => {
  res.set('Cache-Control','no-store');
  const action = req.path === '/auth/signup' ? 'signup' : 'username-login';
  const input = accountInput.safeParse(req.body);
  if (!input.success || (action === 'signup' && input.data.password.length < 12)) {
    const error = action === 'signup'
      ? 'Use 3–32 characters for your username. Start with a letter and use letters, numbers, underscores or hyphens. Choose a password of at least 12 characters and at most 72 bytes.'
      : 'Invalid username or password.';
    res.status(400).json({error});
    return;
  }
  const response = await fetch(supabaseUrl+'/functions/v1/web-comments-enroll',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action,...input.data}),signal:AbortSignal.timeout(15000),
  }).catch(() => null);
  if (action === 'signup' && response?.status === 201) {
    res.status(201).json({ok:true});
  } else if (action === 'username-login' && response?.status === 200) {
    const tokens = await response.json().catch(() => null);
    if (typeof tokens?.access_token === 'string' && typeof tokens?.refresh_token === 'string') {
      res.json({access_token:tokens.access_token,refresh_token:tokens.refresh_token});
    } else {
      res.status(502).json({error:'Sign-in is temporarily unavailable. Try again shortly.'});
    }
  } else if (response?.status === 401) {
    res.status(401).json({error:'Invalid username or password.'});
  } else if (response?.status === 409) {
    res.status(409).json({error:'That username is taken. Choose another.'});
  } else if (response?.status === 422) {
    res.status(422).json({error:'Choose a stronger password.'});
  } else if (response?.status === 429) {
    res.status(429).json({error:'Too many attempts. Try again in a few minutes.'});
  } else {
    res.status(502).json({error:'Account access is temporarily unavailable. Try again shortly.'});
  }
});
app.use('/assets', express.static(fileURLToPath(new URL('./web/assets/',import.meta.url))));
app.get('/downloads/chrome-extension.zip', (_req,res) => {
  res.download(fileURLToPath(new URL('./web/chrome-extension.zip',import.meta.url)),'web-comments-chrome-extension.zip');
});
app.get(['/oauth/consent','/signup','/p/:id','/'], (req,res) => {
  if (req.path === '/signup') res.set('Cache-Control','no-store');
  res.set('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; connect-src ${supabaseUrl} 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  res.set('Referrer-Policy','no-referrer');
  res.sendFile(fileURLToPath(new URL('./web/index.html',import.meta.url)));
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
  const server = new McpServer({name:'web-comments',version:'1.0.0'}, {instructions});
  const id = z.string().regex(uuidRegex).transform(value => value.toLowerCase());
  const cursor = z.number().int().min(0).max(2147483647).optional();
  const reviewInput = {review_id:id,cursor};
  async function run(fn: () => Promise<unknown>) {
    try {
      return {content:[{type:'text' as const,text:JSON.stringify(await fn())}]};
    } catch (error) {
      return {isError:true,content:[{type:'text' as const,text:JSON.stringify({
        error:error instanceof Error ? error.message : 'The review could not complete this operation.',
        instructions,
      })}]};
    }
  }
  server.registerTool('resolve_page', {
    description:`Resolve a copied URL or page ID. ${instructions}`, inputSchema:{reference:z.string().max(2048)},
    annotations:{readOnlyHint:true,openWorldHint:false},
  }, ({reference}) => run(() => resolvePage(supabase,referenceId(reference,origin))));
  server.registerTool('get_page_content', {
    description:`Retrieve sequential chunks of the fixed document. ${instructions}`, inputSchema:reviewInput,
    annotations:{readOnlyHint:true,openWorldHint:false},
  }, ({review_id,cursor=0}) => run(() => readContent(supabase,review_id,cursor)));
  server.registerTool('list_comments', {
    description:`Retrieve sequential thread headers and message records, including pending IDs. ${instructions}`, inputSchema:reviewInput,
    annotations:{readOnlyHint:true,openWorldHint:false},
  }, ({review_id,cursor=0}) => run(() => readComments(supabase,review_id,cursor)));
  server.registerTool('post_reply', {
    description:`Save a visible reply to one pending question. ${instructions}`,
    inputSchema:{review_id:id,comment_id:id,body:z.string().trim().min(1).max(12000)},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  }, ({review_id,comment_id,body}) => run(() => postReply(supabase,review_id,comment_id,body)));
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
