import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createReviewServer, referenceId, resolvePage, readContent, readComments, postReply } from '../dist/review.js';

const owner = randomUUID();
const other = randomUUID();
const origin = 'https://comments.example';
const text = 'First section: see the final section.\n' + 'A😀'.repeat(6000) + '\nFinal section: related definitions.';
const client = new PGlite();
const db = { async query(query,args) {
  const result = await client.query(query,args);
  return { ...result,rowCount:result.rows.length };
} };
const storageFiles = new Map();
const reviewClient = (id,oauth=true) => ({
  async rpc(name,args) {
    await account(id);
    await client.query("select set_config('test.jwt',$1,false)",[oauth ? '{"client_id":"test"}' : '{}']);
    await client.exec('set role authenticated');
    try {
      const params = Object.entries(args).map(([key], index) => key+' => $'+(index+1)).join(',');
      const {rows:[row]} = await db.query('select '+name+'('+params+') as data',Object.values(args));
      return {data:row.data,error:null};
    } catch (error) {
      if (error.code !== 'P0001') throw error;
      return {data:null,error};
    } finally {
      await client.exec("reset role; select set_config('test.jwt','{}',false)");
    }
  },
  storage:{from(bucket) {
    assert.equal(bucket,'web-comments');
    return {async download(path) {
      assert.ok(path.startsWith(id+'/'));
      return {data:storageFiles.get(path)};
    }};
  }},
});
const first = reviewClient(owner);
const secondAccount = reviewClient(other);
const digest = value => createHash('sha256').update(value).digest('hex');
const account = async (id) => {
  await client.query("select set_config('test.user',$1,false)",[id]);
};
before(async () => {
  await client.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text, raw_app_meta_data jsonb, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('test.user',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable
      as $$ select coalesce(nullif(current_setting('test.jwt',true),'')::jsonb,'{}') $$;
    create schema storage;
    create table storage.buckets(id text,name text,public boolean);
    create table storage.objects(bucket_id text,name text);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable
      as $$ select string_to_array(name,'/') $$;
    create publication supabase_realtime;
    grant usage on schema auth,storage to authenticated;
  `);
  await client.exec(await readFile(new URL('../supabase/migrations/20261125000000_web_comments.sql',import.meta.url),'utf8'));
  await client.exec(await readFile(new URL('../supabase/migrations/20261125214447_web_comments_owner_enrollment.sql',import.meta.url),'utf8'));
  await client.exec(await readFile(new URL('../supabase/migrations/20261125230442_web_comments_enrollment_ticket.sql',import.meta.url),'utf8'));
  await client.exec(await readFile(new URL('../supabase/migrations/20261126040704_web_comments_email_invitation.sql',import.meta.url),'utf8'));
  await client.exec(await readFile(new URL('../supabase/migrations/20261126174114_web_comments_private_accounts.sql',import.meta.url),'utf8'));
  await client.exec(await readFile(new URL('../supabase/migrations/20261126174323_web_comments_username_auth_metadata.sql',import.meta.url),'utf8'));
  await client.query('insert into auth.users(id) values($1),($2)',[owner,other]);
});
after(async () => { await client.close(); });

test('MCP guides bare links into one coordinated review and offers a reusable prompt',async () => {
  const server = createReviewServer({},origin);
  const client = new Client({name:'review-discovery-test',version:'1.0.0'});
  const [clientSide,serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  try {
    await client.connect(clientSide);
    assert.match(client.getInstructions(),/link by itself/);
    assert.match(client.getInstructions(),/Fetch document and comment chunks in parallel/);
    assert.match(client.getInstructions(),/one coordinator/);
    const {tools} = await client.listTools();
    assert.match(tools.find(tool=>tool.name==='resolve_page').description,/answer its pending @AI questions/);
    const {prompts} = await client.listPrompts();
    assert.ok(prompts.some(prompt=>prompt.name==='review_web_comments'));
    const reference = origin+'/p/'+randomUUID();
    const prompt = await client.getPrompt({name:'review_web_comments',arguments:{reference}});
    assert.equal(prompt.messages[0].role,'user');
    assert.ok(prompt.messages[0].content.text.includes(reference));
    await assert.rejects(client.getPrompt({name:'review_web_comments',arguments:{reference:'https://elsewhere.example/p/'+randomUUID()}}),/Web Comments link/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('usernames are unique, privately resolvable and assigned only by trusted Auth metadata',async () => {
  const name = 'test-user';
  const email = 'synthetic@example.test';
  const marker = JSON.stringify({web_comments_username:name});
  await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[randomUUID(),email,marker]);
  assert.equal((await db.query('select * from wc_private.account_usernames')).rowCount,0);
  const user = randomUUID();
  await db.query('insert into auth.users(id,email) values($1,$2)',[user,email]);
  await db.query('update auth.users set raw_app_meta_data=$1 where id=$2',[marker,user]);
  await db.query('update auth.users set raw_app_meta_data=$1 where id=$2',[marker,user]);
  await assert.rejects(db.query('insert into auth.users(id,email,raw_app_meta_data) values($1,$2,$3)',
    [randomUUID(),'other@example.test',marker]),/duplicate key/);
  await client.exec('set role service_role');
  try {
    const {rows:[row]} = await db.query('select wc_email_for_username($1) as email',[name]);
    assert.equal(row.email,email);
    await assert.rejects(db.query('select wc_owner_invitee($1)',['1'.repeat(64)]),/permission denied/);
  } finally {
    await client.exec('reset role');
  }
  await client.exec('set role anon');
  try {
    await assert.rejects(db.query('select wc_email_for_username($1)',[name]),/permission denied/);
    await assert.rejects(db.query('select wc_start_review($1)',[randomUUID()]),/permission denied/);
    assert.equal((await db.query('select wc_public_health() as ok')).rows[0].ok,true);
  } finally {
    await client.exec('reset role');
  }
});

async function capture(url,body,complete=true) {
  const hash = digest(body);
  const {rows:[row]} = await db.query(
    "select wc_capture($1,'Document','html',$2,$3,$4,$5,$6,null,null) as page",
    [url,hash,digest(body+complete),complete,complete?'':'A frame was omitted.',body],
  );
  return row.page;
}
async function add(page,body,thread=null, id=randomUUID()) {
  await db.query('select wc_add_message($1,$2,$3,$4,$5,$6)',[
    page.page_id,page.version_id,thread,JSON.stringify({kind:'html',exact:'First'}),body,id,
  ]);
  const {rows:[message]} = await db.query('select * from wc_messages where id=$1',[id]);
  return message;
}
async function walk(read) {
  const results=[];
  let cursor=0;
  do {
    const chunk = await read(cursor);
    assert.equal(chunk.complete,chunk.next_cursor===null);
    results.push(chunk);
    cursor=chunk.next_cursor;
  } while (cursor!==null);
  return results;
}

test('isolated pages and fixed review streams, including prior and resolved messages',async () => {
  await account(owner);
  const page = await capture('https://example.com/alpha',text);
  assert.deepEqual(await capture('https://example.com/alpha',text),page);
  const page2 = await capture('https://example.com/beta','Other document');
  const question = await add(page,'@AI How does the final section relate?');
  const note = await add(page,'Ordinary note about the related definitions.');
  await db.query('select wc_set_resolved($1,true)',[note.thread_id]);
  const question2 = await add(page2,'@AI Other page question.');
  assert.equal(referenceId(page.page_id,origin),page.page_id);
  assert.equal(referenceId(origin+'/p/'+page.page_id,origin),page.page_id);
  assert.throws(()=>referenceId('https://other.example/p/'+page.page_id,origin));
  const review = await resolvePage(first,page.page_id);
  const parallelReview = await resolvePage(first,page.page_id);
  const second = await resolvePage(first,page2.page_id);
  await assert.rejects(readContent(secondAccount,review.review_id,0),/Review not found/);
  await assert.rejects(readComments(secondAccount,review.review_id,0),/Review not found/);
  await assert.rejects(postReply(secondAccount,review.review_id,question.id,'Wrong account'),/Review not found/);
  await assert.rejects(resolvePage(reviewClient(owner,false),page.page_id),/OAuth session is required/);
  await assert.rejects(resolvePage(secondAccount,page.page_id),/Page not found/);
  await account(owner);
  const changed = await capture('https://example.com/alpha','New version');
  const followUp = await add(changed,'@AI Follow-up after the cutoff.',question.thread_id);
  assert.notEqual(changed.version_id,page.version_id);
  await assert.rejects(postReply(first,review.review_id,question.id,'Premature'),/Fetch both/);
  await assert.rejects(readContent(first,review.review_id,10000),/in order/);
  await assert.rejects(readComments(first,review.review_id,2),/in order/);
  const docs = await walk(async cursor=>readContent(first,review.review_id,cursor));
  assert.ok(docs.length>1);
  assert.equal(docs.map(x=>x.text).join(''),text);
  await assert.rejects(postReply(first,review.review_id,question.id,'Only content'),/Fetch both/);
  const discussion = await walk(async cursor=>readComments(first,review.review_id,cursor));
  assert.ok(discussion.length>1);
  assert.deepEqual(discussion.flatMap(x=>x.pending_question_ids),[question.id]);
  const items = discussion.flatMap(x=>x.items);
  assert.equal(items.find(x=>x.id===note.id).body,note.body);
  assert.equal(items.find(x=>x.id===note.thread_id).resolved,true);
  assert.ok(!items.some(x=>x.id===followUp.id||x.id===question2.id));
  await assert.rejects(postReply(first,review.review_id,followUp.id,'Out of snapshot'),/not pending/);
  await assert.rejects(postReply(first,review.review_id,question2.id,'Wrong page'),/not pending/);
  await walk(async cursor=>readContent(first,parallelReview.review_id,cursor));
  await walk(async cursor=>readComments(first,parallelReview.review_id,cursor));
  const reply = await postReply(first,review.review_id,question.id,'See the final section and the related definition note.');
  const retry = await postReply(first,parallelReview.review_id,question.id,'Changed answer');
  assert.equal(retry.reply_id,reply.reply_id);
  assert.equal(retry.version_id,page.version_id);
  assert.equal(retry.already_answered,true);
  const fresh = await resolvePage(first,page.page_id);
  const more = await walk(async cursor=>readComments(first,fresh.review_id,cursor));
  assert.deepEqual(more.flatMap(x=>x.pending_question_ids),[followUp.id]);
  assert.match(more.flatMap(x=>x.items).find(x=>x.id===reply.reply_id).body,/final section/);
  const secondItems = await walk(async cursor=>readComments(first,second.review_id,cursor));
  assert.deepEqual(secondItems.flatMap(x=>x.pending_question_ids),[question2.id]);
  assert.equal((await db.query('select count(*) as count from wc_messages where reply_to=$1',[question.id])).rows[0].count,1);
});

test('two signed-in accounts can keep separate documents for the same URL',async () => {
  const url = 'https://example.com/shared';
  await account(owner);
  const page = await capture(url,'Private first account');
  await account(other);
  const secondPage = await capture(url,'Private second account');
  assert.notEqual(secondPage.page_id,page.page_id);
  const review = await resolvePage(secondAccount,secondPage.page_id);
  assert.equal((await readContent(secondAccount,review.review_id,0)).text,'Private second account');
  await assert.rejects(resolvePage(first,secondPage.page_id),/Page not found/);
});

test('stored text is read with account access and checked against the saved hash',async () => {
  await account(owner);
  const source = '\uFEFFSaved file\n'+text;
  const hash = digest(source);
  const path = owner+'/'+hash+'.txt';
  const {rows:[row]} = await db.query(
    "select wc_capture('https://example.com/storage','Document','html',$1,$1,true,'',null,$2,null) as page",
    [hash,path],
  );
  const review = await resolvePage(first,row.page.page_id);
  await assert.rejects(readContent(first,review.review_id,0),/could not be read/);
  storageFiles.set(path,new Blob(['Wrong content']));
  await assert.rejects(readContent(first,review.review_id,0),/failed its integrity check/);
  storageFiles.set(path,new Blob([source]));
  const docs = await walk(cursor=>readContent(first,review.review_id,cursor));
  assert.equal(docs.map(chunk=>chunk.text).join(''),source);
});

test('incomplete reviews and row-level ownership block writes',async () => {
  await account(owner);
  const page = await capture('https://example.com/incomplete','First part',false);
  const requestId = randomUUID();
  const question = await add(page,'@AI Can you read the full page?',null,requestId);
  assert.equal((await add(page,question.body,null,requestId)).thread_id,question.thread_id);
  const review = await resolvePage(first,page.page_id);
  assert.equal(review.extraction_complete,false);
  assert.match(review.extraction_note,/frame/);
  await walk(async cursor=>readContent(first,review.review_id,cursor));
  await walk(async cursor=>readComments(first,review.review_id,cursor));
  await assert.rejects(postReply(first,review.review_id,question.id,'Guess'),/incomplete/);
  await client.exec('set role authenticated');
  try {
    await account(other);
    assert.equal((await db.query('select * from wc_pages where id=$1',[page.page_id])).rowCount,0);
    assert.equal((await db.query('select * from wc_messages where id=$1',[question.id])).rowCount,0);
    await assert.rejects(db.query('select wc_set_resolved($1,true)',[question.thread_id]),/Thread not found/);
    await account(owner);
    assert.equal((await db.query('select * from wc_messages where id=$1',[question.id])).rowCount,1);
    await assert.rejects(db.query('update wc_messages set body=$1 where id=$2',['changed',question.id]),/permission denied/);
    await client.exec(`select set_config('test.jwt','{"client_id":"test"}',false)`);
    await assert.rejects(db.query('select wc_set_resolved($1,true)',[question.thread_id]),/Extension session required/);
  } finally {
    await client.exec("reset role; select set_config('test.jwt','{}',false)");
  }
});
