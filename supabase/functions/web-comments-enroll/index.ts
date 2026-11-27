import { createClient } from 'npm:@supabase/supabase-js@2.99.0';

const url = Deno.env.get('SUPABASE_URL')!;
const secret = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default
  ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const publishable = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}').default
  ?? Deno.env.get('SUPABASE_ANON_KEY');
const auth = {persistSession:false,autoRefreshToken:false};
const admin = createClient(url,secret,{auth});

function respond(status:number, body:object = {ok:false}) {
  return Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
}

async function limitedJson(request:Request):Promise<unknown> {
  if (!request.body) throw new Error('Missing body');
  const reader=request.body.getReader();
  const decoder=new TextDecoder();
  let bytes=0;
  let text='';
  while (true) {
    const {done,value}=await reader.read();
    if (done) return JSON.parse(text+decoder.decode());
    bytes+=value.byteLength;
    if (bytes>4096) {
      await reader.cancel();
      throw new Error('Body too large');
    }
    text+=decoder.decode(value,{stream:true});
  }
}

Deno.serve(async request => {
  if (request.method !== 'POST') return respond(405);
  const body = await limitedJson(request).catch(() => null);
  if (!body || typeof body !== 'object') return respond(400);
  const {action,login,password} = body as Record<string,unknown>;
  if (typeof login !== 'string' || !/^[a-z][a-z0-9_-]{2,31}$/.test(login)
      || typeof password !== 'string' || !password.length || new TextEncoder().encode(password).length > 72
      || action !== 'username-login') return respond(400);

  const {data:email,error:lookupError} = await admin.rpc('wc_email_for_username',{p_username:login});
  if (lookupError) return respond(503);

  if (typeof email !== 'string' || !email) return respond(401);
  const db = createClient(url,publishable,{auth});
  const {data:{session},error} = await db.auth.signInWithPassword({email,password});
  if (error?.status === 429) return respond(429);
  if (!session) return respond(error?.status && error.status < 500 ? 401 : 503);
  return respond(200,{access_token:session.access_token,refresh_token:session.refresh_token});
});
