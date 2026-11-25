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
const origin = new URL(env('PUBLIC_ORIGIN')).origin;
const supabaseUrl = new URL(env('SUPABASE_URL')).origin;
const publishableKey = env('SUPABASE_PUBLISHABLE_KEY');
const ownerId = env('OWNER_USER_ID').toLowerCase();
const clientId = env('MCP_OAUTH_CLIENT_ID');
const pool = new pg.Pool({ connectionString: env('DATABASE_URL') });
const app = express();
app.disable('x-powered-by');
app.use(express.json({limit:'256kb'}));

const metadata = {
  resource: origin + '/mcp',
  authorization_servers: [supabaseUrl + '/auth/v1'],
  bearer_methods_supported: ['header'],
};
app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req,res) => res.json(metadata));
app.get('/healthz', (_req,res) => res.json({ok:true}));
app.get('/config.json', (_req,res) => res.json({supabaseUrl,publishableKey,origin,clientId}));
app.use('/assets', express.static(fileURLToPath(new URL('./web/assets/',import.meta.url))));
app.get(['/oauth/consent','/p/:id','/'], (_req,res) => {
  res.set('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; connect-src ${supabaseUrl} 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  res.set('Referrer-Policy','no-referrer');
  res.sendFile(fileURLToPath(new URL('./web/index.html',import.meta.url)));
});

app.all('/mcp', async (req,res) => {
  const token = req.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
  const supabase = createClient(supabaseUrl,publishableKey,{
    auth:{persistSession:false,autoRefreshToken:false},
    global:{headers:{Authorization:`Bearer ${token ?? ''}`}},
  });
  const auth = token ? await supabase.auth.getClaims(token) : null;
  const claims = auth?.data?.claims;
  const user = claims && token && claims.client_id === clientId ? (await supabase.auth.getUser(token)).data.user : null;
  if (!user || user.id.toLowerCase() !== ownerId || claims?.client_id !== clientId
      || claims?.iss !== supabaseUrl + '/auth/v1' || claims?.role !== 'authenticated'
      || claims?.aud !== 'authenticated' || claims?.sub !== user.id) {
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
app.listen(Number(process.env.PORT ?? 8787),'0.0.0.0',() => console.log('Web Comments MCP is ready.'));
