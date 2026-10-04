-- Settings/archive changes must reach the same subscriptions as financial rows.
-- Publication membership does not grant reads: existing household RLS applies.
do $$begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='households') then
  alter publication supabase_realtime add table public.households;
 end if;
end$$;
