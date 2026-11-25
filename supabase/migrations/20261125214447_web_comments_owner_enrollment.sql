create schema wc_private;
revoke all on schema wc_private from public, anon, authenticated;

create table wc_private.owner_account (
  singleton boolean primary key default true check (singleton),
  user_id uuid unique references auth.users(id) on delete set null
);
alter table wc_private.owner_account enable row level security;

create function wc_private.record_owner_account()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into wc_private.owner_account (user_id) values (new.id);
  return new;
end;
$$;
revoke all on function wc_private.record_owner_account() from public, anon, authenticated;

-- Auth creates the user and claims the single owner slot in the same transaction.
-- Only a server administrator can add the marker in app metadata.
create trigger wc_record_owner_account
after insert on auth.users
for each row
when ((new.raw_app_meta_data -> 'web_comments_owner') = 'true'::jsonb)
execute function wc_private.record_owner_account();
