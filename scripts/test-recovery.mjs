// Cold backup of the disposable cluster only. Never accepts a remote connection.
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

async function fingerprint(client) {
  const tables = (await client.query("select schemaname,tablename from pg_tables where schemaname in ('public','auth','supabase_migrations') order by schemaname,tablename")).rows;
  const data = [];
  for (const {schemaname,tablename} of tables) {
    // Identifiers come from pg_catalog, never a user-supplied URL or file.
    const quote = text => '"' + text.replaceAll('"','""') + '"';
    const rows = await client.query(`select md5(coalesce(string_agg(row_to_json(t)::text,E'\n' order by row_to_json(t)::text),'')) hash,count(*)::int count from ${quote(schemaname)}.${quote(tablename)} t`);
    data.push({table:`${schemaname}.${tablename}`,...rows.rows[0]});
  }
  const policies = (await client.query("select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname")).rows;
  const functions = (await client.query("select p.proname,pg_get_function_identity_arguments(p.oid) args,p.prosecdef,p.proacl::text acl,md5(pg_get_functiondef(p.oid)) hash from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' order by 1,2")).rows;
  const rls = (await client.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by relname")).rows;
  return {data,policies,functions,rls};
}

export async function testRecovery({admin,connections,database,directory,port,password,check,userA,userB}) {
  let before;
  await check('AC-79 failed upgrade rolls back schema, data, version and audit before retry', async () => {
    before = await fingerprint(admin);
    await admin.query('begin');
    try {
      await admin.query('create table public.failed_upgrade_probe(id int); update public.households set ledger_version=ledger_version+100');
      await admin.query("select 1/0");
      assert.fail('failure was not injected');
    } catch (error) { assert.equal(error.code,'22012'); }
    await admin.query('rollback');
    assert.deepEqual(await fingerprint(admin),before);
    await admin.query('begin; create table public.failed_upgrade_probe(id int); drop table public.failed_upgrade_probe; commit');
    assert.deepEqual(await fingerprint(admin),before);
  });
  await check('AC-79 cold backup restores rows, migration history, functions, RLS and permissions into a second cluster', async () => {
    await admin.query('checkpoint');
    while (connections.length) await connections.pop().end();
    await database.stop();
    const backup = join(directory,'verified-backup'), restored = join(directory,'restored');
    await cp(join(directory,'data'),backup,{recursive:true});
    await cp(backup,restored,{recursive:true});
    const restoredDatabase = new EmbeddedPostgres({databaseDir:restored,user:'postgres',password,port:port+1,persistent:false,postgresFlags:['-c','listen_addresses=127.0.0.1','-c','wal_level=logical'],onLog:()=>{},onError:()=>{}});
    const client = new Client({host:'127.0.0.1',port:port+1,user:'postgres',password,database:'postgres'});
    try {
      await restoredDatabase.start(); await client.connect();
      assert.deepEqual(await fingerprint(client),before);
      await client.query('set role authenticated');
      await client.query("select set_config('request.jwt.claim.sub',$1,false)",[userA]);
      const memberships = (await client.query('select household_id from public.household_members where user_id=$1 and active',[userA])).rows;
      assert(memberships.length>0);
      const h=memberships[0].household_id;
      assert.equal((await client.query('select public.is_household_member($1) member',[h])).rows[0].member,true);
      await client.query("select set_config('request.jwt.claim.sub',$1,false)",[userB]);
      await assert.rejects(client.query('select public.archive_household($1,$2)',[h,'unsafe old API']),/双人归档|permission denied/);
      await client.query('reset role; set role anon');
      await assert.rejects(client.query('select public.get_household_management_plan($1)',[h]),/permission denied/);
    } finally {
      await client.end().catch(()=>{}); await restoredDatabase.stop().catch(()=>{});
    }
  });
}
