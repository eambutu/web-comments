create table public.wc_pages (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  source_url text not null check (source_url ~ '^(https?|file)://'),
  latest_version uuid,
  unique(owner, source_url)
);
create table public.wc_versions (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.wc_pages(id) on delete cascade,
  title text not null,
  kind text not null check (kind in ('html','pdf')),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz not null default now(),
  complete boolean not null,
  extraction_note text not null,
  inline_text text,
  text_path text,
  pdf_path text,
  check ((inline_text is null) <> (text_path is null))
);
alter table public.wc_pages add foreign key (latest_version) references public.wc_versions(id);
create table public.wc_threads (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.wc_pages(id) on delete cascade,
  version_id uuid not null references public.wc_versions(id),
  anchor jsonb not null,
  created_at timestamptz not null default now(),
  resolved boolean not null default false
);
create table public.wc_reviews (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.wc_pages(id) on delete cascade,
  version_id uuid not null references public.wc_versions(id),
  created_at timestamptz not null default now(),
  content_next integer not null default 0,
  comments_next integer not null default 0,
  content_done boolean not null default false,
  comments_done boolean not null default false
);
create table public.wc_messages (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.wc_pages(id) on delete cascade,
  thread_id uuid not null references public.wc_threads(id) on delete cascade,
  created_at timestamptz not null default now(),
  body text not null check (length(btrim(body)) between 1 and 12000),
  role text not null check (role in ('user','assistant')),
  question boolean not null default false,
  reply_to uuid unique references public.wc_messages(id),
  review_id uuid references public.wc_reviews(id),
  check ((role = 'assistant' and reply_to is not null and review_id is not null and not question)
      or (role = 'user' and reply_to is null and review_id is null))
);
create table public.wc_review_items (
  review_id uuid not null references public.wc_reviews(id) on delete cascade,
  position integer not null,
  item jsonb not null,
  primary key(review_id, position)
);
create index on public.wc_versions(page_id);
create index on public.wc_threads(page_id);
create index on public.wc_messages(page_id, created_at, id);

alter table public.wc_pages enable row level security;
alter table public.wc_versions enable row level security;
alter table public.wc_threads enable row level security;
alter table public.wc_messages enable row level security;
alter table public.wc_reviews enable row level security;
alter table public.wc_review_items enable row level security;
revoke all on public.wc_pages, public.wc_versions, public.wc_threads, public.wc_messages, public.wc_reviews, public.wc_review_items from public, anon, authenticated;
grant select on public.wc_pages, public.wc_versions, public.wc_threads, public.wc_messages to authenticated;

create policy wc_owner_page on public.wc_pages for select to authenticated using (owner = (select auth.uid()));
create policy wc_owner_version on public.wc_versions for select to authenticated using
  (exists (select from public.wc_pages p where p.id = page_id));
create policy wc_owner_thread on public.wc_threads for select to authenticated using
  (exists (select from public.wc_pages p where p.id = page_id));
create policy wc_owner_message on public.wc_messages for select to authenticated using
  (exists (select from public.wc_pages p where p.id = page_id));

create function public.wc_capture(
  source text, document_title text, document_kind text, document_hash text, capture_fingerprint text,
  is_complete boolean, note text, document_text text, snapshot_path text, binary_path text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account uuid := auth.uid();
  page uuid;
  version uuid;
  previous record;
begin
  if account is null or auth.jwt() ? 'client_id' then raise exception 'Extension session required'; end if;
  if source ~ '^file://' and document_kind <> 'pdf' then raise exception 'Only local PDFs can be saved'; end if;
  if (snapshot_path is not null and snapshot_path <> account::text || '/' || document_hash || '.txt')
    or (binary_path is not null and binary_path !~ ('^' || account::text || '/[0-9a-f]{64}\.pdf$'))
  then raise exception 'Invalid storage path'; end if;
  insert into public.wc_pages(owner, source_url) values (account, source) on conflict do nothing;
  select p.id, p.latest_version into page, version from public.wc_pages p
    where p.owner = account and p.source_url = source for update;
  select v.fingerprint, v.title into previous from public.wc_versions v where v.id = version;
  if version is null or previous.fingerprint <> capture_fingerprint or previous.title <> document_title then
    insert into public.wc_versions(page_id, title, kind, content_hash, fingerprint, complete, extraction_note, inline_text, text_path, pdf_path)
      values (page, document_title, document_kind, document_hash, capture_fingerprint, is_complete, note, document_text, snapshot_path, binary_path)
      returning id into version;
    update public.wc_pages set latest_version = version where id = page;
  end if;
  return jsonb_build_object('page_id', page, 'version_id', version);
end;
$$;

create function public.wc_add_message(
  page uuid, version uuid, thread uuid, selection jsonb, message text, message_id uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare target uuid := thread;
begin
  if auth.uid() is null or auth.jwt() ? 'client_id' then raise exception 'Extension session required'; end if;
  perform 1 from public.wc_pages where id = page and owner = auth.uid() for update;
  if not found then raise exception 'Page not found'; end if;
  if exists (select from public.wc_messages where id = message_id and page_id = page) then return message_id; end if;
  if target is null then
    if not exists (select from public.wc_versions where id = version and page_id = page)
      or selection is null
      or coalesce(length(selection->>'exact'), 0) not between 1 and 6000
      or octet_length(selection::text) > 32000
    then raise exception 'Invalid selection'; end if;
    insert into public.wc_threads(page_id, version_id, anchor) values(page, version, selection) returning id into target;
  else
    update public.wc_threads set resolved = false where id = target and page_id = page;
    if not found then raise exception 'Thread not found'; end if;
  end if;
  insert into public.wc_messages(id, page_id, thread_id, body, role, question)
    values(message_id, page, target, message, 'user', message ~* '(^|[^[:alnum:]_])@AI([^[:alnum:]_]|$)');
  return message_id;
end;
$$;

create function public.wc_set_resolved(thread uuid, state boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or auth.jwt() ? 'client_id' then raise exception 'Extension session required'; end if;
  update public.wc_threads t set resolved = state
    from public.wc_pages p where t.id = thread and t.page_id = p.id and p.owner = auth.uid();
  if not found then raise exception 'Thread not found'; end if;
end;
$$;

revoke all on function public.wc_capture(text,text,text,text,text,boolean,text,text,text,text),
  public.wc_add_message(uuid,uuid,uuid,jsonb,text,uuid), public.wc_set_resolved(uuid,boolean) from public, anon;
grant execute on function public.wc_capture(text,text,text,text,text,boolean,text,text,text,text),
  public.wc_add_message(uuid,uuid,uuid,jsonb,text,uuid), public.wc_set_resolved(uuid,boolean) to authenticated;

insert into storage.buckets (id, name, public) values ('web-comments', 'web-comments', false);
create policy wc_read_snapshot on storage.objects for select to authenticated using
  (bucket_id = 'web-comments' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy wc_insert_snapshot on storage.objects for insert to authenticated with check
  (bucket_id = 'web-comments' and (storage.foldername(name))[1] = (select auth.uid())::text
    and not (auth.jwt() ? 'client_id'));
alter publication supabase_realtime add table public.wc_messages, public.wc_threads, public.wc_pages;
