import { createClient } from 'npm:@supabase/supabase-js@2.99.0';

const url = Deno.env.get('SUPABASE_URL')!;
const secret = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default
  ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const admin = createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});

function respond(status:number) {
  return Response.json({ok:status === 201},{status,headers:{'Cache-Control':'no-store'}});
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
  const {password,token} = body as Record<string,unknown>;
  const encoder = new TextEncoder();
  if (typeof password !== 'string' || password.length < 12 || encoder.encode(password).length > 72
      || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return respond(400);
  const digest = await crypto.subtle.digest('SHA-256',encoder.encode(token));
  const candidate_hash = Array.from(new Uint8Array(digest),byte => byte.toString(16).padStart(2,'0')).join('');
  const {data:email,error:checkError} = await admin.rpc('wc_owner_invitee',{candidate_hash});
  if (checkError) return respond(503);
  if (typeof email !== 'string' || !email) return respond(403);
  const {error} = await admin.auth.admin.createUser({
    email,password,email_confirm:true,app_metadata:{web_comments_owner:true},
  });
  return respond(error ? 422 : 201);
});
