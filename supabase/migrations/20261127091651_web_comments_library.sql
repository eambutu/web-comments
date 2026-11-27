create table public.wc_library (
  page_id uuid primary key references public.wc_pages(id) on delete cascade,
  version_id uuid not null references public.wc_versions(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  snapshot_html text check (octet_length(snapshot_html) between 1 and 750000),
  imported_at timestamptz not null default now()
);
create index wc_library_owner_recent on public.wc_library(owner, imported_at desc, page_id);
alter table public.wc_library enable row level security;
revoke all on public.wc_library from public, anon, authenticated;
grant select on public.wc_library to authenticated;
create policy wc_read_library on public.wc_library for select to authenticated
  using (owner = (select auth.uid()));

create schema wc_library_api;
revoke all on schema wc_library_api from public;

create function wc_library_api.record_import(
  source text, document_title text, document_kind text, document_hash text, capture_fingerprint text,
  is_complete boolean, note text, document_text text, snapshot_path text, binary_path text, snapshot_html text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  saved jsonb;
  account uuid := auth.uid();
begin
  if account is null or auth.jwt() ? 'client_id' then raise exception 'A signed-in account is required.'; end if;
  if source !~ '^https?://' or length(source) > 2048
    or (document_kind = 'html' and (snapshot_html is null or binary_path is not null))
    or (document_kind = 'pdf' and (snapshot_html is not null or binary_path is null))
  then raise exception 'Invalid library snapshot.'; end if;

  saved := public.wc_capture(source, document_title, document_kind, document_hash, capture_fingerprint,
    is_complete, note, document_text, snapshot_path, binary_path);
  insert into public.wc_library(page_id, version_id, owner, snapshot_html)
    values ((saved->>'page_id')::uuid, (saved->>'version_id')::uuid, account, snapshot_html)
    on conflict (page_id) do update set version_id = excluded.version_id, snapshot_html = excluded.snapshot_html;
  return saved;
end;
$$;
revoke all on function wc_library_api.record_import(text,text,text,text,text,boolean,text,text,text,text,text)
  from public,anon,authenticated;
grant usage on schema wc_library_api to authenticated;
grant execute on function wc_library_api.record_import(text,text,text,text,text,boolean,text,text,text,text,text)
  to authenticated;

create function public.wc_save_import(
  source text, document_title text, document_kind text, document_hash text, capture_fingerprint text,
  is_complete boolean, note text, document_text text, snapshot_path text, binary_path text, snapshot_html text
) returns jsonb language sql security invoker set search_path = '' as $$
  select wc_library_api.record_import(source, document_title, document_kind, document_hash, capture_fingerprint,
    is_complete, note, document_text, snapshot_path, binary_path, snapshot_html);
$$;
revoke all on function public.wc_save_import(text,text,text,text,text,boolean,text,text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.wc_save_import(text,text,text,text,text,boolean,text,text,text,text,text)
  to authenticated;
