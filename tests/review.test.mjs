import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { referenceId, resolvePage, lockReview, readContent, readComments, postReply } from '../dist/review.js';

const owner = randomUUID();
const other = randomUUID();
const origin = 'https://comments.example';
const text = 'First section: see the final section.\n' + 'A😀'.repeat(6000) + '\nFinal section: related definitions.';
const client = new PGlite();
const db = { async query(query,args) {
  const result = await client.query(query,args);
  return { ...result,rowCount:result.rows.length };
} };
const noStorage = {};
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
    create table auth.users(id uuid primary key, raw_app_meta_data jsonb, raw_user_meta_data jsonb);
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
  await client.query('insert into auth.users(id) values($1),($2)',[owner,other]);
});
after(async () => { await client.close(); });

test('an invitation is bound to its recipient, expires, and can only enroll one owner',async () => {
  const enrolled = randomUUID();
  const rejected = randomUUID();
  const untrusted = randomUUID();
  const marker = JSON.stringify({web_comments_owner:true});
  const goodHash = '1'.repeat(64);
  const badHash = '2'.repeat(64);
  const email = 'owner@example.test';
  const ticket = async hash => (await db.query('select wc_owner_invitee($1) as email',[hash])).rows[0].email;
  await client.query("insert into wc_private.enrollment_ticket(code_hash,invite_email,expires_at) values($1,$2,now()-interval '1 day')",[goodHash,email]);
  assert.equal(await ticket(goodHash),null);
  await client.query("update wc_private.enrollment_ticket set expires_at=now()+interval '1 day'");
  await client.exec('set role service_role');
  assert.equal(await ticket(goodHash),email);
  assert.equal(await ticket(badHash),null);
  await assert.rejects(db.query('select wc_check_enrollment_code($1)',[goodHash]),/permission denied/);
  await client.exec('reset role');
  await client.query('insert into auth.users(id,raw_user_meta_data) values($1,$2)',[untrusted,marker]);
  assert.equal((await db.query('select * from wc_private.owner_account')).rowCount,0);
  await client.query('insert into auth.users(id,raw_app_meta_data) values($1,$2)',[enrolled,marker]);
  assert.equal(await ticket(goodHash),null);
  assert.equal((await db.query('select user_id from wc_private.owner_account')).rows[0].user_id,enrolled);
  await assert.rejects(client.query('insert into auth.users(id,raw_app_meta_data) values($1,$2)',[rejected,marker]),
    /duplicate key/);
  assert.equal((await db.query('select id from auth.users where id=$1',[rejected])).rowCount,0);
  await client.exec('set role authenticated');
  try {
    await assert.rejects(ticket(goodHash),/permission denied/);
    await assert.rejects(db.query('select * from wc_private.owner_account'),/permission denied/);
  } finally {
    await client.exec('reset role');
  }
  await client.query('delete from auth.users where id=$1',[enrolled]);
  assert.equal((await db.query('select user_id from wc_private.owner_account')).rows[0].user_id,null);
  await assert.rejects(client.query('insert into auth.users(id,raw_app_meta_data) values($1,$2)',[rejected,marker]),
    /duplicate key/);
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
  const review = await resolvePage(db,owner,page.page_id);
  const parallelReview = await resolvePage(db,owner,page.page_id);
  const second = await resolvePage(db,owner,page2.page_id);
  const load = () => lockReview(db,owner,review.review_id);
  const loadParallel = () => lockReview(db,owner,parallelReview.review_id);
  await assert.rejects(lockReview(db,other,review.review_id),/Review not found/);
  await assert.rejects(resolvePage(db,other,page.page_id),/Page not found/);
  const changed = await capture('https://example.com/alpha','New version');
  const followUp = await add(changed,'@AI Follow-up after the cutoff.',question.thread_id);
  assert.notEqual(changed.version_id,page.version_id);
  await assert.rejects(postReply(db,await load(),question.id,'Premature'),/Fetch both/);
  await assert.rejects(readContent(db,noStorage,await load(),10000),/in order/);
  await assert.rejects(readComments(db,await load(),2),/in order/);
  const docs = await walk(async cursor=>readContent(db,noStorage,await load(),cursor));
  assert.ok(docs.length>1);
  assert.equal(docs.map(x=>x.text).join(''),text);
  await assert.rejects(postReply(db,await load(),question.id,'Only content'),/Fetch both/);
  const discussion = await walk(async cursor=>readComments(db,await load(),cursor));
  assert.ok(discussion.length>1);
  assert.deepEqual(discussion.flatMap(x=>x.pending_question_ids),[question.id]);
  const items = discussion.flatMap(x=>x.items);
  assert.equal(items.find(x=>x.id===note.id).body,note.body);
  assert.equal(items.find(x=>x.id===note.thread_id).resolved,true);
  assert.ok(!items.some(x=>x.id===followUp.id||x.id===question2.id));
  await assert.rejects(postReply(db,await load(),followUp.id,'Out of snapshot'),/not pending/);
  await assert.rejects(postReply(db,await load(),question2.id,'Wrong page'),/not pending/);
  await walk(async cursor=>readContent(db,noStorage,await loadParallel(),cursor));
  await walk(async cursor=>readComments(db,await loadParallel(),cursor));
  const reply = await postReply(db,await load(),question.id,'See the final section and the related definition note.');
  const retry = await postReply(db,await loadParallel(),question.id,'Changed answer');
  assert.equal(retry.reply_id,reply.reply_id);
  assert.equal(retry.version_id,page.version_id);
  assert.equal(retry.already_answered,true);
  const fresh = await resolvePage(db,owner,page.page_id);
  const more = await walk(async cursor=>readComments(db,await lockReview(db,owner,fresh.review_id),cursor));
  assert.deepEqual(more.flatMap(x=>x.pending_question_ids),[followUp.id]);
  assert.match(more.flatMap(x=>x.items).find(x=>x.id===reply.reply_id).body,/final section/);
  const secondItems = await walk(async cursor=>readComments(db,await lockReview(db,owner,second.review_id),cursor));
  assert.deepEqual(secondItems.flatMap(x=>x.pending_question_ids),[question2.id]);
  assert.equal((await db.query('select count(*) as count from wc_messages where reply_to=$1',[question.id])).rows[0].count,1);
});

test('incomplete reviews and row-level ownership block writes',async () => {
  await account(owner);
  const page = await capture('https://example.com/incomplete','First part',false);
  const requestId = randomUUID();
  const question = await add(page,'@AI Can you read the full page?',null,requestId);
  assert.equal((await add(page,question.body,null,requestId)).thread_id,question.thread_id);
  const review = await resolvePage(db,owner,page.page_id);
  assert.equal(review.extraction_complete,false);
  assert.match(review.extraction_note,/frame/);
  await walk(async cursor=>readContent(db,noStorage,await lockReview(db,owner,review.review_id),cursor));
  await walk(async cursor=>readComments(db,await lockReview(db,owner,review.review_id),cursor));
  await assert.rejects(postReply(db,await lockReview(db,owner,review.review_id),question.id,'Guess'),/incomplete/);
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
