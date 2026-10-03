// Disposable PostgreSQL only. No production URL, credentials or persistent user changes.
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const directory = await mkdtemp(join(tmpdir(), 'gongzhu-p4-db-'));
const port = Number(process.env.GONGZHU_TEST_PG_PORT ?? 55439);
const password = randomUUID();
const database = new EmbeddedPostgres({ databaseDir: join(directory, 'data'), user: 'postgres', password, port,
  persistent: false, initdbFlags: ['--locale=C', '--encoding=UTF8'], postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'wal_level=logical'], onLog: () => {}, onError: () => {} });
const connections = [];
const connect = async () => {
  const client = new Client({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres' });
  await client.connect(); connections.push(client); return client;
};
const userA = randomUUID(), userB = randomUUID(), outsider = randomUUID();
let checks = 0;
async function check(name, work) { await work(); checks++; console.log(`PASS ${name}`); }
try {
  await database.initialise(); await database.start();
  const admin = await connect();
  await admin.query(`create schema auth; create schema extensions;
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to authenticated,anon;
    grant execute on function auth.uid() to authenticated,anon;
    create publication supabase_realtime;
    alter default privileges in schema public grant select,insert,update,delete on tables to authenticated;
    alter default privileges in schema public grant usage on sequences to authenticated;`);
  const migrationDir = new URL('../supabase/migrations/', import.meta.url);
  const migrations = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
  const oldMember=randomUUID(),oldPartner=randomUUID(),oldHousehold=randomUUID(),oldSource=randomUUID(),oldPayment=randomUUID();
  let oldClaim;
  for (const name of migrations) {
    if(name.includes('_p4_')) {
      // Seed a populated P3 database before applying P4: its existing partial payment must survive.
      await admin.query('insert into auth.users(id,email) values($1,$2),($3,$4)',[oldMember,'old-a@example.test',oldPartner,'old-b@example.test']);
      await admin.query("insert into public.households(id,name,created_by) values($1,'P3 upgrade',$2)",[oldHousehold,oldMember]);
      await admin.query("insert into public.household_members(household_id,user_id,role) values($1,$2,'owner'),($1,$3,'member')",[oldHousehold,oldMember,oldPartner]);
      await admin.query("insert into public.cash_accounts(household_id,kind,name) values($1,'bank','bank'),($1,'brokerage','brokerage')",[oldHousehold]);
      const sourceProposal=randomUUID(),paymentProposal=randomUUID();
      await admin.query("insert into public.proposals(id,household_id,submitter_id,idempotency_key,status,payload) values($1,$2,$3,$4,'approved',$5::jsonb),($6,$2,$3,$7,'approved',$8::jsonb)",
        [sourceProposal,oldHousehold,oldMember,randomUUID(),JSON.stringify({type:'reimbursement',title:'legacy source',currency:'USD',amountMinor:12000,occurredAt:'2026-09-01',payerMemberId:oldMember}),paymentProposal,randomUUID(),JSON.stringify({type:'settlement',title:'legacy payment',currency:'USD',amountMinor:5000,occurredAt:'2026-09-02',payeeMemberId:oldMember})]);
      await admin.query("insert into public.ledger_entries(id,household_id,proposal_id,entry_type,amount_minor,currency,occurred_at,effective_sequence,title,payer_member_id) values($1,$2,$3,'reimbursement',12000,'USD','2026-09-01',1,'legacy source',$4)",[oldSource,oldHousehold,sourceProposal,oldMember]);
      await admin.query("insert into public.ledger_entries(id,household_id,proposal_id,entry_type,amount_minor,currency,occurred_at,effective_sequence,title,payee_member_id,account_kind) values($1,$2,$3,'settlement',5000,'USD','2026-09-02',2,'legacy payment',$4,'bank')",[oldPayment,oldHousehold,paymentProposal,oldMember]);
      oldClaim=(await admin.query('select id from public.reimbursement_claims where source_entry_id=$1',[oldSource])).rows[0].id;
      await admin.query('insert into public.settlement_allocations(household_id,settlement_entry_id,claim_id,amount_minor) values($1,$2,$3,5000)',[oldHousehold,oldPayment,oldClaim]);
    }
    try { await admin.query(await readFile(new URL(name, migrationDir), 'utf8')); }
    catch (error) { console.error(`Migration failed: ${name}`); throw error; }
  }
  console.log(`PASS clean install: ${migrations.length} migrations (PostgreSQL ${(await admin.query('show server_version')).rows[0].server_version})`);
  await admin.query('insert into auth.users(id,email) values($1,$2),($3,$4),($5,$6)',[userA,'a@example.test',userB,'b@example.test',outsider,'c@example.test']);
  const a = await connect(), b = await connect(), c = await connect();
  for (const [connection, uid] of [[a,userA],[b,userB],[c,outsider]]) {
    await connection.query('set role authenticated'); await connection.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);
  }
  await check('P3 populated upgrade preserves old allocation and subtracts it from available quota',async()=>{
    const oldA=await connect(),oldB=await connect();
    for(const [connection,uid] of [[oldA,oldMember],[oldB,oldPartner]]) {await connection.query('set role authenticated');await connection.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);}
    const oldAllocation=(await oldA.query('select * from public.settlement_allocations where claim_id=$1',[oldClaim])).rows[0];
    assert.equal(oldAllocation.amount_minor,'5000');assert.equal(oldAllocation.status,'posted');assert(oldAllocation.batch_id);assert.equal(oldAllocation.payment_minor,'5000');
    const payload={payeeMemberId:oldMember,accountKind:'bank',currency:'USD',occurredAt:'2026-09-03',title:'remaining legacy balance',allocations:[{claimId:oldClaim,amountMinor:8000,expectedVersion:1}]};
    await assert.rejects(oldA.query('select public.submit_settlement_batch($1,$2::jsonb,$3)',[oldHousehold,JSON.stringify(payload),randomUUID()]),/额度不足/);
    payload.allocations[0].amountMinor=7000;
    const batch=(await oldA.query('select public.submit_settlement_batch($1,$2::jsonb,$3) as id',[oldHousehold,JSON.stringify(payload),randomUUID()])).rows[0].id;
    const pid=(await oldA.query('select proposal_id from public.settlement_batches where id=$1',[batch])).rows[0].proposal_id;
    await oldB.query('select public.decide_proposal($1,true,null)',[pid]);
    assert.equal((await oldA.query('select status from public.reimbursement_claims where id=$1',[oldClaim])).rows[0].status,'settled');
  });
  const household = (await a.query("select public.create_household('P4 test','USD') as id")).rows[0].id;
  await admin.query("insert into public.household_members(household_id,user_id,role) values($1,$2,'member')",[household,userB]);
  const category = (await a.query("select id,name from public.spending_categories where household_id=$1 and name='交通'",[household])).rows[0];
  const rpcSubmit = async (connection,payload,key=randomUUID()) => (await connection.query('select public.submit_proposal($1,$2::jsonb,$3) as id',[household,JSON.stringify(payload),key])).rows[0].id;
  const decide = async (connection,id,approve=true) => (await connection.query('select public.decide_proposal($1,$2,null) as id',[id,approve])).rows[0].id;
  const fxPayload = { type:'fx_rate_update',amountMinor:0,currency:'USD',occurredAt:'2026-09-01',title:'rates',effectiveAt:'2026-09-01T00:00:00Z',usdToCny:'7.2',usdToHkd:'7.8',sourceNote:'test fixture' };
  await decide(b, await rpcSubmit(a,fxPayload));
  const claim = async (amount,currency='USD',payer=userA) => {
    const id = await rpcSubmit(a,{type:'reimbursement',amountMinor:amount,currency,occurredAt:'2026-09-02',title:'source',categoryId:category.id,category:category.name,payerMemberId:payer});
    const entry = await decide(b,id);
    return (await a.query('select * from public.reimbursement_claims where source_entry_id=$1',[entry])).rows[0];
  };
  const request = (claims,currency='USD',payee=userA) => ({payeeMemberId:payee,accountKind:'bank',currency,occurredAt:'2026-09-03',title:'payment',allocations:claims.map(([original,amount])=>({claimId:original.id,amountMinor:amount,expectedVersion:Number(original.version)}))});
  const submit = async (connection,payload,key=randomUUID()) => (await connection.query('select public.submit_settlement_batch($1,$2::jsonb,$3) as id',[household,JSON.stringify(payload),key])).rows[0].id;
  const proposal = async batch => (await a.query('select proposal_id from public.settlement_batches where id=$1',[batch])).rows[0].proposal_id;
  await check('P3 approval atomically creates a unique claim owned by the actual payer',async()=>{
    const id=await rpcSubmit(a,{type:'reimbursement',amountMinor:1000,currency:'USD',occurredAt:'2026-09-02',title:'recorded for B',categoryId:category.id,category:category.name,payerMemberId:userB});
    const entry=await decide(b,id); assert.equal(await decide(b,id),entry);
    const rows=(await a.query('select * from public.reimbursement_claims where source_entry_id=$1',[entry])).rows;
    assert.equal(rows.length,1); assert.equal(rows[0].claimant_id,userB);
  });
  await check('T10 cross-currency batch reserves originals, posts USD150 once, never duplicates expense',async()=>{
    const cny=await claim(72000,'CNY'), hkd=await claim(78000,'HKD');
    const payload=request([[cny,36000],[hkd,78000]]), key=randomUUID();
    const batch=await submit(a,payload,key), id=await proposal(batch);
    const before=(await a.query("select coalesce(sum(case when entry_type='settlement' then -amount_minor when entry_type='deposit' then amount_minor else 0 end) filter(where currency='USD'),0) as cash, count(*) filter(where entry_type='reimbursement') as expenses from public.ledger_entries where household_id=$1 and status='posted'",[household])).rows[0];
    assert.equal(await submit(a,payload,key),batch);
    await assert.rejects(submit(a,{...payload,title:'different'},key),/幂等键/);
    assert.equal((await a.query('select amount_minor from public.settlement_batches where id=$1',[batch])).rows[0].amount_minor,'15000');
    assert.equal((await a.query('select count(*) from public.ledger_entries where proposal_id=$1',[id])).rows[0].count,'0');
    assert.equal((await a.query("select sum(amount_minor) from public.settlement_allocations where batch_id=$1 and status='reserved'",[batch])).rows[0].sum,'114000');
    await assert.rejects(decide(a,id),/submitter cannot/);
    const entry=await decide(b,id); assert.equal(await decide(b,id),entry);
    const e=(await a.query('select * from public.ledger_entries where id=$1',[entry])).rows[0];
    assert.equal(e.entry_type,'settlement'); assert.equal(e.amount_minor,'15000'); assert.equal(e.currency,'USD'); assert.equal(e.payee_member_id,userA);
    const after=(await a.query("select coalesce(sum(case when entry_type='settlement' then -amount_minor when entry_type='deposit' then amount_minor else 0 end) filter(where currency='USD'),0) as cash, count(*) filter(where entry_type='reimbursement') as expenses from public.ledger_entries where household_id=$1 and status='posted'",[household])).rows[0];
    assert.equal(Number(after.cash)-Number(before.cash),-15000);assert.equal(after.expenses,before.expenses);
    const rows=(await a.query('select claim_id,amount_minor,payment_minor,status from public.settlement_allocations where batch_id=$1',[batch])).rows;
    assert.equal(rows.length,2); assert.equal(rows.reduce((sum,row)=>sum+Number(row.payment_minor),0),15000); assert(rows.every(row=>row.status==='posted'));
    assert.equal((await a.query('select status from public.reimbursement_claims where id=$1',[hkd.id])).rows[0].status,'settled');
    await decide(b,await rpcSubmit(a,{...fxPayload,usdToCny:'7.5'}));
    const next=await submit(a,request([[cny,36000]]));
    assert.equal((await a.query('select amount_minor from public.settlement_batches where id=$1',[next])).rows[0].amount_minor,'4800');
    assert.equal((await a.query('select amount_minor from public.settlement_batches where id=$1',[batch])).rows[0].amount_minor,'15000');
    await a.query('select public.withdraw_proposal($1)',[await proposal(next)]);
    await decide(b,await rpcSubmit(a,fxPayload));
  });
  await check('AC-15 partial payment of 100 against 300 leaves original 200 outstanding',async()=>{
    const original=await claim(30000),batch=await submit(a,request([[original,10000]])),pid=await proposal(batch);
    const entry=await decide(b,pid);
    assert.equal((await a.query('select amount_minor from public.ledger_entries where id=$1',[entry])).rows[0].amount_minor,'10000');
    const paid=(await a.query("select sum(amount_minor) from public.settlement_allocations where claim_id=$1 and status='posted'",[original.id])).rows[0].sum;
    assert.equal(Number(original.claimed_minor)-Number(paid),20000);
    assert.equal((await a.query('select status from public.reimbursement_claims where id=$1',[original.id])).rows[0].status,'partially_settled');
  });
  await check('two real sessions concurrently reserve 80 of 100: exactly one succeeds',async()=>{
    const original=await claim(10000), payload=request([[original,8000]]);
    const results=await Promise.allSettled([submit(a,payload),submit(b,payload)]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(results.filter(result=>result.status==='rejected').length,1);
    assert.equal((await a.query("select sum(amount_minor) from public.settlement_allocations where claim_id=$1 and status='reserved'",[original.id])).rows[0].sum,'8000');
    assert.equal(Number(original.claimed_minor)-8000,2000);
    const result=results.find(result=>result.status==='fulfilled'); const submitter=results[0].status==='fulfilled'?a:b;
    const id=await proposal(result.value); await submitter.query('select public.withdraw_proposal($1)',[id]);
    await submitter.query('select public.withdraw_proposal($1)',[id]);
    const replacement=await submit(a,request([[original,10000]])); await decide(b,await proposal(replacement),false);
    const retry=await submit(a,request([[original,10000]])); await decide(b,await proposal(retry));
  });
  await check('duplicate concurrent approval produces one cash event and one allocation',async()=>{
    const original=await claim(10000), batch=await submit(a,request([[original,5000]])), id=await proposal(batch);
    const secondB=await connect(); await secondB.query('set role authenticated');await secondB.query("select set_config('request.jwt.claim.sub',$1,false)",[userB]);
    const [one,two]=await Promise.all([decide(b,id),decide(secondB,id)]); assert.equal(one,two);
    assert.equal((await a.query('select count(*) from public.ledger_entries where proposal_id=$1',[id])).rows[0].count,'1');
    assert.equal((await a.query("select count(*) from public.settlement_allocations where batch_id=$1 and status='posted'",[batch])).rows[0].count,'1');
  });
  await check('overdue keeps reservations; withdrawal and rejection release without cash',async()=>{
    const original=await claim(10000), batch=await submit(a,request([[original,8000]])), id=await proposal(batch);
    await admin.query("update public.proposals set status='overdue_pending' where id=$1",[id]);
    await assert.rejects(submit(b,request([[original,8000]])),/额度不足/);
    await assert.rejects(b.query('select public.withdraw_proposal($1)',[id]),/only submitter/);
    await a.query('select public.withdraw_proposal($1)',[id]);
    assert.equal((await a.query('select status from public.settlement_batches where id=$1',[batch])).rows[0].status,'released');
    const replacement=await submit(a,request([[original,10000]]));await decide(b,await proposal(replacement),false);await decide(b,await proposal(replacement),false);
    assert.equal((await a.query("select count(*) from public.settlement_allocations where claim_id=$1 and status='reserved'",[original.id])).rows[0].count,'0');
    assert.equal((await a.query('select count(*) from public.ledger_entries where proposal_id=$1',[id])).rows[0].count,'0');
  });
  await check('T10 pennies: total 0.42 / 3x0.14; zero total and zero line rejected atomically',async()=>{
    const originals=[await claim(100,'CNY'),await claim(100,'CNY'),await claim(100,'CNY')];
    const batch=await submit(a,request(originals.map(row=>[row,100])));
    const rows=(await a.query('select payment_minor from public.settlement_allocations where batch_id=$1',[batch])).rows;
    assert(rows.every(row=>row.payment_minor==='14'));
    const ties=[await claim(10,'CNY'),await claim(10,'CNY'),await claim(10,'CNY')];
    const tiedBatch=await submit(a,request(ties.map(row=>[row,10]).reverse()));
    const tiedRows=(await a.query('select payment_minor from public.settlement_allocations where batch_id=$1 order by claim_id',[tiedBatch])).rows;
    assert.deepEqual(tiedRows.map(row=>Number(row.payment_minor)),[2,1,1]);
    const tiny=[await claim(1,'CNY'),await claim(1,'CNY'),await claim(1,'CNY')];
    const usd=await claim(100);
    await assert.rejects(submit(a,request(tiny.map(row=>[row,1]))),/不足一分/);
    await assert.rejects(submit(a,request([[usd,100],[tiny[0],1]])),/不足一分/);
    assert.equal((await a.query('select count(*) from public.settlement_allocations where claim_id=$1',[tiny[0].id])).rows[0].count,'0');
  });
  await check('same claim repeated is merged before rounding; fractional and forged fields rejected',async()=>{
    const original=await claim(10000), payload=request([[original,3000],[original,2000]]);
    const batch=await submit(a,payload); assert.equal((await a.query('select count(*) from public.settlement_allocations where batch_id=$1',[batch])).rows[0].count,'1');
    await assert.rejects(submit(a,{...payload,amountMinor:1}),/invalid settlement payload/);
    await assert.rejects(submit(a,request([[original,0.1]])),/invalid original amount/);
    await assert.rejects(rpcSubmit(a,{type:'settlement',amountMinor:100,currency:'USD',occurredAt:'2026-09-03',title:'unsourced'}),/原单/);
    await assert.rejects(a.query('select public.decide_p2_account_proposal($1,true,null)',[await proposal(batch)]),/permission denied/);
  });
  await check('cross-member, nonexistent, stale and overpay failures leave no partial reservations',async()=>{
    const original=await claim(10000), other=await claim(10000,'USD',userB);
    await assert.rejects(submit(a,request([[original,5000],[other,5000]])),/其他成员/);
    await assert.rejects(submit(a,request([[{id:randomUUID(),version:1},5000]])),/无来源/);
    await assert.rejects(submit(a,request([[original,10001]])),/额度不足/);
    await assert.rejects(submit(a,request([[{...original,version:2},1000]])),/原单已变更/);
    assert.equal((await a.query('select count(*) from public.settlement_allocations where claim_id=$1',[original.id])).rows[0].count,'0');
  });
  await check('dependency revision rechecked at approval; failed approval keeps reservation and no cash',async()=>{
    const original=await claim(10000),batch=await submit(a,request([[original,5000]])),id=await proposal(batch);
    await admin.query('update public.reimbursement_claims set version=version+1 where id=$1',[original.id]);
    await assert.rejects(decide(b,id),/原单已变更/);
    assert.equal((await a.query('select status from public.proposals where id=$1',[id])).rows[0].status,'pending_approval');
    assert.equal((await a.query('select count(*) from public.ledger_entries where proposal_id=$1',[id])).rows[0].count,'0');
    await a.query('select public.withdraw_proposal($1)',[id]);
  });
  await check('approve racing withdraw has exactly one terminal effect, no stranded reservation',async()=>{
    const original=await claim(10000),batch=await submit(a,request([[original,5000]])),id=await proposal(batch);
    const results=await Promise.allSettled([decide(b,id),a.query('select public.withdraw_proposal($1)',[id])]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    const row=(await a.query('select status,ledger_entry_id from public.settlement_batches where id=$1',[batch])).rows[0];
    assert(['posted','released'].includes(row.status));assert.equal(row.ledger_entry_id!==null,row.status==='posted');
    assert.equal((await a.query("select count(*) from public.settlement_allocations where batch_id=$1 and status='reserved'",[batch])).rows[0].count,'0');
  });
  await check('RLS both members can read, outsider cannot; direct DML and old RPC bypass denied',async()=>{
    for(const table of ['reimbursement_claims','settlement_allocations','settlement_batches','fx_rate_snapshots_exact']) {
      assert((await b.query(`select count(*) from public.${table}`)).rows[0].count>0);
      assert.equal((await c.query(`select count(*) from public.${table}`)).rows[0].count,'0');
    }
    await assert.rejects(submit(c,request([[await claim(100),50]])),/not authorized/);
    const mutation=await a.query('update public.reimbursement_claims set claimed_minor=1 returning id');assert.equal(mutation.rowCount,0);
    await assert.rejects(a.query("insert into public.settlement_batches(household_id,proposal_id,claimant_id,account_kind,currency,amount_minor) values($1,$2,$3,'bank','USD',1)",[household,randomUUID(),userA]),/row-level security/);
    const exact=(await a.query('select usd_to_cny from public.fx_rate_snapshots_exact limit 1')).rows[0].usd_to_cny;assert.equal(typeof exact,'string');
  });
} finally {
  for (const connection of connections) await connection.end().catch(() => {});
  await database.stop().catch(() => {}); await rm(directory,{recursive:true,force:true});
}
console.log(`Database checks passed: ${checks}`);
