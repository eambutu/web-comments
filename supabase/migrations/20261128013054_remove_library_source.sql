grant delete on public.wc_library to authenticated;

create policy wc_remove_own_library_source on public.wc_library
  for delete to authenticated
  using (owner = (select auth.uid()) and not ((select auth.jwt()) ? 'client_id'));
