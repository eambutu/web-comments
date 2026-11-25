create table wc_private.enrollment_ticket (
  singleton boolean primary key default true check (singleton),
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$')
);
alter table wc_private.enrollment_ticket enable row level security;

create function public.wc_check_enrollment_code(candidate_hash text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select from wc_private.enrollment_ticket where code_hash = candidate_hash)
    and not exists (select from wc_private.owner_account);
$$;
revoke all on function public.wc_check_enrollment_code(text) from public, anon, authenticated;
grant execute on function public.wc_check_enrollment_code(text) to service_role;
