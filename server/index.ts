import express from 'express';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { instructions, referenceId, uuidRegex, resolvePage, lockReview, readContent, readComments, postReply } from './review';

function env(key: string) {
  const value = process.env[key];
  if (!value) throw new Error(`Set ${key} before starting Web Comments.`);
  return value;
}
const origin = new URL(process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || env('PUBLIC_ORIGIN')).origin;
const supabaseUrl = new URL(env('SUPABASE_URL')).origin;
const publishableKey = env('SUPABASE_PUBLISHABLE_KEY');
const configuredOwner = process.env.OWNER_USER_ID?.toLowerCase();
const clientId = process.env.MCP_OAUTH_CLIENT_ID || null;
const databaseUrl = env('DATABASE_URL');
const pool = new pg.Pool({ connectionString:databaseUrl, connectionTimeoutMillis:5000 });
const authOptions = {persistSession:false,autoRefreshToken:false};
const inviteInput = z.object({
  password:z.string().min(12).refine(value => Buffer.byteLength(value,'utf8') <= 72),
  token:z.string().regex(/^[a-f0-9]{64}$/),
});

async function enrollment() {
  const {rows:[row]} = await pool.query<{user_id:string|null}>('select user_id from wc_private.owner_account');
  return row;
}

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
  try {
    if (configuredOwner) await pool.query('select 1');
    else await enrollment();
    res.json({ok:true});
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const detail = error instanceof Error
      ? error.message.replaceAll(databaseUrl,'[redacted]').replace(/postgres(?:ql)?:\/\/[^\s]+|[a-f0-9]{64}/gi,'[redacted]').slice(0,180)
      : 'connection failed';
    console.warn('Database readiness check failed',code ?? '',detail);
    res.status(503).json({ok:false});
  }
});
app.get('/config.json', async (_req,res) => {
  res.set('Cache-Control','no-store');
  const ownerInvitationPending = !configuredOwner && !await enrollment();
  res.json({supabaseUrl,publishableKey,origin,clientId,ownerInvitationPending});
});
app.post('/invite/accept', async (req,res) => {
  res.set('Cache-Control','no-store');
  const input = inviteInput.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({error:'Open the invitation from your email and choose a password of at least 12 characters and at most 72 bytes.'});
    return;
  }
  if (configuredOwner || await enrollment()) {
    res.status(409).json({error:'An owner account already exists. Sign in to Web Comments in Chrome.'});
    return;
  }
  const response = await fetch(supabaseUrl+'/functions/v1/web-comments-enroll',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(input.data),
    signal:AbortSignal.timeout(15000),
  }).catch(() => null);
  if (response?.status === 201) {
    res.status(201).json({ok:true});
  } else if (response?.status === 403) {
    res.status(403).json({error:'This invitation has expired or is invalid.'});
  } else if (response?.status === 422) {
    if (await enrollment()) {
      res.status(409).json({error:'An owner account already exists. Sign in to Web Comments in Chrome.'});
      return;
    }
    res.status(422).json({error:'Could not create the account. Try a different password.'});
  } else {
    res.status(502).json({error:'Account setup is temporarily unavailable. Try again in a moment.'});
  }
});
app.use('/assets', express.static(fileURLToPath(new URL('./web/assets/',import.meta.url))));
app.get('/downloads/chrome-extension.zip', (_req,res) => {
  res.download(fileURLToPath(new URL('./web/chrome-extension.zip',import.meta.url)),'web-comments-chrome-extension.zip');
});
app.get(['/oauth/consent','/invite','/p/:id','/'], (req,res) => {
  if (req.path === '/invite') res.set('Cache-Control','no-store');
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
      || claims?.aud !== 'authenticated' || claims?.sub !== user.id
      || user.id.toLowerCase() !== (configuredOwner || (await enrollment())?.user_id)) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
    res.status(401).json({error:'A Web Comments OAuth token for the configured owner and client is required.'});
    return;
  }
  const server = new McpServer({name:'web-comments',version:'1.0.0'}, {instructions});
  const id = z.string().regex(uuidRegex).transform(value => value.toLowerCase());
  const cursor = z.number().int().min(0).max(2147483647).optional();
  const reviewInput = {review_id:id,cursor};
  function run(fn: (db: pg.PoolClient) => Promise<unknown>, snapshot = false) {
    return async () => {
      let db: pg.PoolClient | undefined;
      try {
        db = await pool.connect();
        await db.query(snapshot ? 'begin isolation level repeatable read' : 'begin');
        const result = await fn(db);
        await db.query('commit');
        return {content:[{type:'text' as const,text:JSON.stringify(result)}]};
      } catch (error) {
        await db?.query('rollback').catch(() => undefined);
        const internal = !db || (typeof error === 'object' && error !== null && 'code' in error);
        if (internal) console.error('Review database error', error);
        return {isError:true,content:[{type:'text' as const,text:JSON.stringify({
          error:internal ? 'The review database could not complete this operation.' : (error as Error).message,
          instructions,
        })}]};
      } finally {
        db?.release();
      }
    };
  }
  server.registerTool('resolve_page', {
    description:`Resolve a copied URL or page ID. ${instructions}`, inputSchema:{reference:z.string().max(2048)},
    annotations:{readOnlyHint:true,openWorldHint:false},
  }, ({reference}) => run(db => resolvePage(db,user.id,referenceId(reference,origin)),true)());
  server.registerTool('get_page_content', {
    description:`Retrieve sequential chunks of the fixed document. ${instructions}`, inputSchema:reviewInput,
    annotations:{readOnlyHint:true,openWorldHint:false},
  }, ({review_id,cursor=0}) => run(async db => readContent(db,supabase,await lockReview(db,user.id,review_id),cursor))());
  server.registerTool('list_comments', {
    description:`Retrieve sequential thread headers and message records, including pending IDs. ${instructions}`, inputSchema:reviewInput,
    annotations:{readOnlyHint:true,openWorldHint:false},
  }, ({review_id,cursor=0}) => run(async db => readComments(db,await lockReview(db,user.id,review_id),cursor))());
  server.registerTool('post_reply', {
    description:`Save a visible reply to one pending question. ${instructions}`,
    inputSchema:{review_id:id,comment_id:id,body:z.string().trim().min(1).max(12000)},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  }, ({review_id,comment_id,body}) => run(async db => postReply(db,await lockReview(db,user.id,review_id),comment_id,body))());
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
