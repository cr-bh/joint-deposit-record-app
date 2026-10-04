import assert from 'node:assert/strict';
import {emptyProjectSql} from './prepare-empty-project.mjs';
export async function testEmptyProject({admin,connect,check}) {
 await check('P8 empty-project bootstrap is atomic, records migration versions, seeds no users/data and refuses reapplication',async()=>{
  await admin.query('create database gongzhu_empty_bootstrap');
  const fresh=await connect('gongzhu_empty_bootstrap');
  await fresh.query(`create schema auth;create schema extensions;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
    create publication supabase_realtime;
    alter default privileges in schema public grant select,insert,update,delete on tables to authenticated,anon;
    alter default privileges in schema public grant usage on sequences to authenticated,anon;`);
  const sql=await emptyProjectSql();await fresh.query(sql);
  const count=(await fresh.query('select count(*) from supabase_migrations.schema_migrations')).rows[0].count;assert.equal(count,'19');
  for(const table of ['auth.users','public.households','public.ledger_entries'])assert.equal((await fresh.query(`select count(*) from ${table}`)).rows[0].count,'0');
  assert.equal((await fresh.query("select count(*) from pg_tables where schemaname='public' and not rowsecurity")).rows[0].count,'0');
  await assert.rejects(fresh.query(sql),/database is not empty/);await fresh.query('rollback');
  assert.equal((await fresh.query('select count(*) from supabase_migrations.schema_migrations')).rows[0].count,count);
 });
}
