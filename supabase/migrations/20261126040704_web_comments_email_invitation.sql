alter table wc_private.enrollment_ticket
  add column invite_email text,
  add column expires_at timestamptz,
  add check ((invite_email is null) = (expires_at is null));

create function public.wc_owner_invitee(candidate_hash text)
returns text language sql stable security definer set search_path = '' as $$
  select invite_email
  from wc_private.enrollment_ticket
  where code_hash = candidate_hash and expires_at > now()
    and not exists (select from wc_private.owner_account);
$$;
revoke all on function public.wc_owner_invitee(text) from public, anon, authenticated;
grant execute on function public.wc_owner_invitee(text) to service_role;
revoke execute on function public.wc_check_enrollment_code(text) from service_role;
