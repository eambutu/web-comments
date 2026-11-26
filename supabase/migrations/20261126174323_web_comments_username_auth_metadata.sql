create or replace function wc_private.record_account_username()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into wc_private.account_usernames(username, user_id)
  values (new.raw_app_meta_data->>'web_comments_username', new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- Auth can attach app metadata in an update after inserting a new account.
create or replace trigger wc_record_account_username
after insert or update of raw_app_meta_data on auth.users
for each row when (new.raw_app_meta_data ? 'web_comments_username')
execute function wc_private.record_account_username();

insert into wc_private.account_usernames(username, user_id)
select raw_app_meta_data->>'web_comments_username', id
from auth.users
where raw_app_meta_data ? 'web_comments_username'
on conflict (user_id) do nothing;
