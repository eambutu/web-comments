create table wc_private.account_usernames (
  username text primary key check (username ~ '^[a-z][a-z0-9_-]{2,31}$'),
  user_id uuid not null unique references auth.users(id) on delete cascade
);
alter table wc_private.account_usernames enable row level security;

create function wc_private.record_account_username()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into wc_private.account_usernames(username, user_id)
  values (new.raw_app_meta_data->>'web_comments_username', new.id);
  return new;
end;
$$;
revoke all on function wc_private.record_account_username() from public;

create trigger wc_record_account_username
after insert on auth.users
for each row when (new.raw_app_meta_data ? 'web_comments_username')
execute function wc_private.record_account_username();

create function public.wc_email_for_username(p_username text)
returns text language sql stable security definer set search_path = '' as $$
  select u.email from wc_private.account_usernames a join auth.users u on u.id = a.user_id
  where a.username = p_username;
$$;
revoke all on function public.wc_email_for_username(text) from public, anon, authenticated;
grant execute on function public.wc_email_for_username(text) to service_role;

-- The original invitation can no longer create an account. Existing users keep their notes.
revoke execute on function public.wc_owner_invitee(text) from service_role;

create function public.wc_public_health()
returns boolean language sql stable set search_path = '' as $$ select true $$;
revoke all on function public.wc_public_health() from public;
grant execute on function public.wc_public_health() to anon;

create schema wc_review_api;
revoke all on schema wc_review_api from public;
grant usage on schema wc_review_api to authenticated;

create function wc_review_api.account_id()
returns uuid language plpgsql stable set search_path = '' as $$
begin
  if auth.uid() is null or nullif(auth.jwt()->>'client_id', '') is null then
    raise exception 'A Web Comments OAuth session is required.';
  end if;
  return auth.uid();
end;
$$;

create function wc_review_api.start_review(p_page uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account uuid := wc_review_api.account_id();
  result jsonb;
begin
  with page as materialized (
    select p.id, p.source_url, v.id as version_id, v.title, v.kind, v.content_hash,
      v.captured_at, v.complete as extraction_complete, v.extraction_note
    from public.wc_pages p join public.wc_versions v on v.id = p.latest_version
    where p.id = p_page and p.owner = account
  ), review as (
    insert into public.wc_reviews(page_id, version_id)
    select id, version_id from page returning id, created_at
  ), items as (
    select t.created_at as thread_time, t.id as thread_id, 0 as item_type,
      t.created_at as message_time, t.id as message_id, to_jsonb(t) || '{"type":"thread"}'::jsonb as item
    from public.wc_threads t join page on page.id = t.page_id
    union all
    select t.created_at, t.id, 1, m.created_at, m.id, to_jsonb(m) || jsonb_build_object(
      'type', 'message', 'pending', m.question and a.id is null, 'reviewed_version_id', ar.version_id)
    from page join public.wc_messages m on m.page_id = page.id join public.wc_threads t on t.id = m.thread_id
    left join public.wc_messages a on a.reply_to = m.id
    left join public.wc_reviews ar on ar.id = m.review_id
  ), snapshot as (
    insert into public.wc_review_items(review_id, position, item)
    select review.id, row_number() over (order by thread_time, thread_id, item_type, message_time, message_id) - 1, item
    from review cross join items
  )
  select to_jsonb(page) || jsonb_build_object('review_id', review.id, 'comment_snapshot_at', review.created_at)
  into result from page cross join review;
  if result is null then raise exception 'Page not found.'; end if;
  return result;
end;
$$;

create function wc_review_api.lock_review(p_review uuid)
returns public.wc_reviews language plpgsql set search_path = '' as $$
declare
  account uuid := wc_review_api.account_id();
  review public.wc_reviews;
begin
  select r.* into review from public.wc_reviews r join public.wc_pages p on p.id = r.page_id
  where r.id = p_review and p.owner = account for update of r;
  if not found then raise exception 'Review not found.'; end if;
  return review;
end;
$$;

create function wc_review_api.document_path(p_review uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  account uuid := wc_review_api.account_id();
  path text;
begin
  select v.text_path into path
  from public.wc_reviews r join public.wc_pages p on p.id = r.page_id
    join public.wc_versions v on v.id = r.version_id
  where r.id = p_review and p.owner = account;
  if not found then raise exception 'Review not found.'; end if;
  return path;
end;
$$;

create function wc_review_api.read_content(p_review uuid, p_cursor integer, p_saved_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  review public.wc_reviews := wc_review_api.lock_review(p_review);
  version public.wc_versions;
  source text;
  chunk_end integer;
  done boolean;
begin
  if p_cursor is null or p_cursor < 0 then raise exception 'Invalid content cursor.'; end if;
  if p_cursor > review.content_next then raise exception 'Fetch chunks in order.'; end if;
  select * into strict version from public.wc_versions where id = review.version_id;
  source := case when version.text_path is null then version.inline_text else p_saved_text end;
  if source is null or encode(sha256(convert_to(source, 'UTF8')), 'hex') <> version.content_hash then
    raise exception 'The saved document failed its integrity check. Leave questions pending.';
  end if;
  if p_cursor > length(source) then raise exception 'Invalid content cursor.'; end if;
  chunk_end := p_cursor + least(10000, length(source) - p_cursor);
  done := chunk_end = length(source);
  if p_cursor = review.content_next then
    update public.wc_reviews set content_next = chunk_end, content_done = done where id = review.id;
  end if;
  return jsonb_build_object(
    'review_id', review.id, 'version_id', review.version_id,
    'text', substr(source, p_cursor + 1, chunk_end - p_cursor),
    'extraction_complete', version.complete, 'extraction_note', version.extraction_note,
    'next_cursor', case when not done then chunk_end end, 'complete', done
  );
end;
$$;

create function wc_review_api.read_comments(p_review uuid, p_cursor integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  review public.wc_reviews := wc_review_api.lock_review(p_review);
  items jsonb;
  pending jsonb;
  chunk_end integer;
  done boolean;
begin
  if p_cursor is null or p_cursor < 0 then raise exception 'Invalid comment cursor.'; end if;
  if p_cursor > review.comments_next then raise exception 'Fetch chunks in order.'; end if;
  with chunk as (
    select position, item from public.wc_review_items
    where review_id = review.id and position >= p_cursor order by position limit 3
  )
  select coalesce(jsonb_agg(item order by position) filter (where position < p_cursor::bigint + 2), '[]'),
    coalesce(jsonb_agg(item->'id' order by position)
      filter (where position < p_cursor::bigint + 2 and item->'pending' = 'true'), '[]'),
    count(*) <= 2
  into items, pending, done from chunk;
  chunk_end := p_cursor + jsonb_array_length(items);
  if p_cursor = review.comments_next then
    update public.wc_reviews set comments_next = chunk_end, comments_done = done where id = review.id;
  end if;
  return jsonb_build_object(
    'review_id', review.id, 'items', items, 'pending_question_ids', pending,
    'next_cursor', case when not done then chunk_end end, 'complete', done
  );
end;
$$;

create function wc_review_api.post_reply(p_review uuid, p_comment uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  review public.wc_reviews := wc_review_api.lock_review(p_review);
  pending boolean;
  reply uuid;
  reviewed_version uuid;
begin
  if not (select complete from public.wc_versions where id = review.version_id) then
    raise exception 'Extraction is incomplete. Leave questions pending.';
  end if;
  if not review.content_done or not review.comments_done then
    raise exception 'Fetch both complete streams before posting replies.';
  end if;
  if p_body is null or length(btrim(p_body)) not between 1 and 12000 then
    raise exception 'Use between 1 and 12000 characters for a reply.';
  end if;
  select exists (select from public.wc_review_items where review_id = review.id
    and item @> jsonb_build_object('id', p_comment::text, 'pending', true)) into pending;
  if pending then
    insert into public.wc_messages(page_id, thread_id, body, role, reply_to, review_id)
    select page_id, thread_id, p_body, 'assistant', id, review.id from public.wc_messages
    where id = p_comment and page_id = review.page_id and question
    on conflict(reply_to) do nothing returning id into reply;
    if found then return jsonb_build_object('reply_id', reply, 'version_id', review.version_id, 'already_answered', false); end if;
  end if;

  select m.id, r.version_id into reply, reviewed_version
  from public.wc_messages m join public.wc_reviews r on r.id = m.review_id
  where m.reply_to = p_comment and m.page_id = review.page_id;
  if found then return jsonb_build_object('reply_id', reply, 'version_id', reviewed_version, 'already_answered', true); end if;
  if pending then raise exception 'Question no longer exists.'; end if;
  raise exception 'Question is not pending in this review snapshot.';
end;
$$;

revoke all on all functions in schema wc_review_api from public;
grant execute on function wc_review_api.start_review(uuid), wc_review_api.document_path(uuid),
  wc_review_api.read_content(uuid, integer, text), wc_review_api.read_comments(uuid, integer),
  wc_review_api.post_reply(uuid, uuid, text) to authenticated;

create function public.wc_start_review(p_page uuid)
returns jsonb language sql set search_path = '' as $$ select wc_review_api.start_review(p_page) $$;
create function public.wc_review_document_path(p_review uuid)
returns text language sql stable set search_path = '' as $$ select wc_review_api.document_path(p_review) $$;
create function public.wc_read_review_content(p_review uuid, p_cursor integer, p_saved_text text)
returns jsonb language sql set search_path = '' as $$ select wc_review_api.read_content(p_review, p_cursor, p_saved_text) $$;
create function public.wc_read_review_comments(p_review uuid, p_cursor integer)
returns jsonb language sql set search_path = '' as $$ select wc_review_api.read_comments(p_review, p_cursor) $$;
create function public.wc_post_review_reply(p_review uuid, p_comment uuid, p_body text)
returns jsonb language sql set search_path = '' as $$ select wc_review_api.post_reply(p_review, p_comment, p_body) $$;

revoke all on function public.wc_start_review(uuid), public.wc_review_document_path(uuid),
  public.wc_read_review_content(uuid, integer, text), public.wc_read_review_comments(uuid, integer),
  public.wc_post_review_reply(uuid, uuid, text) from public, anon;
grant execute on function public.wc_start_review(uuid), public.wc_review_document_path(uuid),
  public.wc_read_review_content(uuid, integer, text), public.wc_read_review_comments(uuid, integer),
  public.wc_post_review_reply(uuid, uuid, text) to authenticated;
