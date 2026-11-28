import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createClient } from '@supabase/supabase-js';

// A fresh account per run. The default HTTP fixture models the same requests as
// PostgREST. Set the two local variables to exercise real Auth, PostgreSQL and RLS.
export async function evalBackend() {
  const api=process.env.INLINE_EVAL_SUPABASE_URL;
  if (api) {
    assert.ok(['127.0.0.1','localhost'].includes(new URL(api).hostname),'Use a local development Supabase for this eval');
    const key=process.env.INLINE_EVAL_PUBLISHABLE_KEY;
    const db=createClient(api,key,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data,error}=await db.auth.signUp({email:randomUUID()+'@example.org',password:randomUUID()});
    assert.ifError(error);assert.ok(data.session,'Local email signups must auto-confirm for this test');
    return {api,key,session:data.session,close:async()=>{}};
  }
  const user={id:randomUUID(),aud:'authenticated',role:'authenticated',email:'eval@example.test',
    app_metadata:{provider:'email'},user_metadata:{}};
  const exp=Math.floor(Date.now()/1000)+3600;
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:user.id,exp,role:'authenticated',aud:'authenticated'})+'.local';
  const session={access_token:token,refresh_token:'fixture',token_type:'bearer',expires_at:exp,expires_in:3600,user};
  const pages=new Map(),threads=[],messages=[];
  const server=createServer(async (req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Headers','*');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,HEAD,OPTIONS');
    function json(data,code=200) {res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}
    if (req.method==='OPTIONS') {res.writeHead(204);res.end();return;}
    const url=new URL(req.url,'http://localhost');
    if (url.pathname==='/config.json') return json({supabaseUrl:address,publishableKey:'fixture',origin:address,clientId:null});
    if (req.headers.authorization!=='Bearer '+token) return json({message:'Sign in'},401);
    if (url.pathname==='/auth/v1/user') return json(user);
    const route=url.pathname.replace('/rest/v1/','');
    const eq=name=>url.searchParams.get(name)?.slice(3);
    if (route==='wc_pages') {
      const page=pages.get(eq('source_url'));
      return json(req.headers.accept?.includes('vnd.pgrst.object')?page:(page?[page]:[]));
    }
    if (route==='wc_threads' || route==='wc_messages') return json((route==='wc_threads'?threads:messages).filter(row=>row.page_id===eq('page_id')));
    const chunks=[];for await (const chunk of req) chunks.push(chunk);
    const args=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
    if (route==='rpc/wc_capture') {
      let page=pages.get(args.source);
      if (!page) {page={id:randomUUID(),latest_version:randomUUID()};pages.set(args.source,page);}
      return json({page_id:page.id,version_id:page.latest_version});
    }
    if (route==='rpc/wc_add_message') {
      const prior=messages.find(m=>m.id===args.message_id);
      if (prior) return json(prior.thread_id);
      const id=args.thread??randomUUID();
      if (!args.thread) threads.push({id,page_id:args.page,version_id:args.version,anchor:args.selection,resolved:false});
      messages.push({id:args.message_id,thread_id:id,page_id:args.page,body:args.message,role:'user',question:false});
      return json(id);
    }
    if (route==='rpc/wc_set_resolved') {
      const thread=threads.find(t=>t.id===args.thread);
      if (!thread) return json({message:'Thread missing'},404);
      thread.resolved=args.state;return json(null);
    }
    return json({message:'Unexpected fixture request '+route},404);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address='http://127.0.0.1:'+server.address().port;
  return {api:address,key:'fixture',session,close:()=>new Promise(resolve=>server.close(resolve))};
}
