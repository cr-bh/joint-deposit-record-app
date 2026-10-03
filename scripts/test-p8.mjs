import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {loadDomain} from './test-p7.mjs';
export async function testP8({a,b,c,admin,userA,userB,connect,check}) {
 const domain=await loadDomain();
 const pendingInvites=new Map();
 const create=async(withInvitation=false)=>{
  const h=(await a.query("select public.create_household('P8 acceptance','USD','Asia/Hong_Kong') id")).rows[0].id;
  if(withInvitation) {
   const email=(await admin.query('select email from auth.users where id not in ($1,$2) limit 1',[userA,userB])).rows[0].email;
   pendingInvites.set(h,(await a.query('select public.create_invitation($1,$2) token',[h,email])).rows[0].token);
  }
  await admin.query("insert into public.household_members(household_id,user_id,role) values($1,$2,'member')",[h,userB]);
  return h;
 };
 const plan=async h=>(await a.query('select public.get_household_management_plan($1) data',[h])).rows[0].data;
 const submit=async(h,p)=> (await a.query('select public.submit_proposal($1,$2::jsonb,$3) id',[h,JSON.stringify(p),randomUUID()])).rows[0].id;
 const decide=async(id,connection=b,approve=true)=>(await connection.query('select public.decide_proposal($1,$2,null) id',[id,approve])).rows[0].id;
 const request=async(h,action='archive',key=randomUUID(),connection=a)=>{
  const review=await plan(h);
  return (await connection.query('select public.submit_household_management($1,$2,$3,$4,$5) id',[h,action,'P8 two-member review',review.version,key])).rows[0].id;
 };
 const payload=(type,amount,extra={})=>({type,amountMinor:amount,currency:'USD',occurredAt:'2026-09-02',title:'P8 '+type,...extra});
 let h,archiveId,archiveRequest,category,investment,invitation;
 try {
  await check('P8 archive nonzero/negative cash and debt; frozen rows use production domain calculator',async()=>{
   h=await create(true);category=(await a.query('select id,name from public.spending_categories where household_id=$1 limit 1',[h])).rows[0];
   await decide(await submit(h,payload('deposit',10000,{payerMemberId:userA,accountKind:'bank'})));
   await decide(await submit(h,payload('expense',15000,{categoryId:category.id,category:category.name,accountKind:'bank'})));
   await decide(await submit(h,payload('reimbursement',30000,{categoryId:category.id,category:category.name,payerMemberId:userA})));
   investment=(await a.query("select public.create_investment_direct($1,'Archive ETF','A','ETF','USD','份','snapshot','monthly') id",[h])).rows[0].id;
   await decide(await submit(h,payload('investment_buy',10000,{investmentId:investment,quantityMicro:1000000})));
   const basis=(await a.query('select public.get_investment_basis($1,$2) basis',[investment,'2026-09-02'])).rows[0].basis;
   await decide(await submit(h,payload('investment_valuation',0,{investmentId:investment,valuationMode:'total_market',totalValueMinor:15000,basis})));
   const before=domain.managementOverview((await plan(h)).snapshot);
   assert.equal(before.cashMinor,-15000);assert.equal(before.investmentMinor,15000);assert.equal(before.assetsMinor,0);assert.equal(before.payablesMinor,30000);assert.equal(before.netMinor,-30000);
   invitation=pendingInvites.get(h);
   archiveRequest=await request(h);await assert.rejects(decide(archiveRequest,a),/submitter/);
   archiveId=await decide(archiveRequest);
   const frozen=(await a.query('select snapshot from public.household_archives where id=$1',[archiveId])).rows[0].snapshot;
   assert.deepEqual(domain.managementOverview(frozen),before);
   assert.equal((await a.query('select status,archive_snapshot_id from public.households where id=$1',[h])).rows[0].status,'archived');
   assert.equal(await decide(archiveRequest),archiveId);assert.equal((await a.query('select count(*) from public.household_archives where household_id=$1',[h])).rows[0].count,'1');
  });
  await check('P8 archived writes/old RPC/direct DML denied across financial and metadata paths; outsider snapshot hidden',async()=>{
   await assert.rejects(submit(h,payload('deposit',100,{payerMemberId:userA})),/archived/);
   await assert.rejects(a.query('select public.submit_settlement_batch($1,$2::jsonb,$3)',[h,'{}',randomUUID()]),/archived/);
   await assert.rejects(a.query('select public.submit_correction($1,$2::jsonb,$3)',[h,'{}',randomUUID()]),/archived/);
   await assert.rejects(submit(h,payload('fx_rate_update',0,{effectiveAt:'2026-09-02T00:00:00Z',usdToCny:'7.2',usdToHkd:'7.8',sourceNote:'archived'})),/archived/);
   await assert.rejects(submit(h,payload('investment_valuation',0,{investmentId:investment})),/archived/);
   const ordinary=(await a.query("select id from public.proposals where household_id=$1 and payload->>'type'='deposit' limit 1",[h])).rows[0].id;
   await assert.rejects(decide(ordinary),/archived/);
   await assert.rejects(c.query('select public.accept_invitation($1)',[invitation]),/invalid or expired/);
   assert.equal((await admin.query("select count(*) from public.invitations where household_id=$1 and status='pending'",[h])).rows[0].count,'0');
   await assert.rejects(a.query("select public.create_spending_category($1,'Forbidden')",[h]),/archived/);
   await assert.rejects(a.query("select public.create_spending_project($1,'Forbidden')",[h]),/archived/);
   await assert.rejects(a.query("select public.set_household_time_zone($1,'UTC')",[h]),/archived/);
   await assert.rejects(a.query("select public.update_investment_metadata($1,'X','X','ETF','份','X','weekly')",[investment]),/archived/);
   await assert.rejects(a.query("select public.get_investment_basis($1,'2026-09-02')",[investment]),/archived/);
   await assert.rejects(a.query("select public.create_invitation($1,'outsider@example.test')",[h]),/archived/);
   await assert.rejects(a.query("select public.archive_household($1,'single owner')",[h]),/permission denied/);
   await assert.rejects(a.query('select public.capture_household_snapshot($1)',[h]),/permission denied/);
   assert.equal((await c.query('select count(*) from public.household_archives where household_id=$1',[h])).rows[0].count,'0');
   await assert.rejects(c.query('select public.get_household_management_plan($1)',[h]),/not authorized/);
   assert.equal((await a.query("update public.households set status='active' where id=$1 returning id",[h])).rowCount,0);
   assert.equal((await a.query("update public.household_archives set snapshot='{}'::jsonb where id=$1 returning id",[archiveId])).rowCount,0);
  });
  await check('P8 restore needs peer, reject/withdraw retain archive, successful restore preserves history and enables writes',async()=>{
   let id=await request(h,'restore');await assert.rejects(decide(id,a),/submitter/);await assert.rejects(decide(id,c),/not authorized/);
   await decide(id,b,false);assert.equal((await plan(h)).status,'archived');
   id=await request(h,'restore');await a.query('select public.withdraw_proposal($1)',[id]);assert.equal((await plan(h)).status,'archived');await assert.rejects(decide(id),/not reviewable/);
   id=await request(h,'restore');await decide(id);await decide(id);assert.equal((await plan(h)).status,'active');
   const frozen=(await a.query('select snapshot from public.household_archives where id=$1',[archiveId])).rows[0].snapshot;
   const before=domain.managementOverview(frozen);
   await decide(await submit(h,payload('deposit',100,{payerMemberId:userA,accountKind:'bank'})));
   assert.equal(domain.managementOverview((await plan(h)).snapshot).cashMinor,before.cashMinor+100);
   assert.equal(domain.managementOverview(frozen).cashMinor,before.cashMinor); // retained archive does not mutate after new live writes
  });
  await check('P8 management idempotency, concurrent requests and approvals; stale review cannot freeze new state',async()=>{
   const ledger=await create(),key=randomUUID(),review=await plan(ledger);
   const args=[ledger,'archive','same reason',review.version,key];
   const id=(await a.query('select public.submit_household_management($1,$2,$3,$4,$5) id',args)).rows[0].id;
   assert.equal((await a.query('select public.submit_household_management($1,$2,$3,$4,$5) id',args)).rows[0].id,id);
   await assert.rejects(a.query('select public.submit_household_management($1,$2,$3,$4,$5)',[ledger,'archive','changed',review.version,key]),/幂等键/);
   await assert.rejects(request(ledger),/已有归档|版本/);
   const ordinary=await submit(ledger,payload('deposit',100,{payerMemberId:userA}));await assert.rejects(decide(id),/版本已变化/);
   await a.query('select public.withdraw_proposal($1)',[id]);await decide(ordinary);
   const newId=await request(ledger),peer=await connect();await peer.query('set role authenticated');await peer.query("select set_config('request.jwt.claim.sub',$1,false)",[userB]);
   const results=await Promise.all([decide(newId,b),decide(newId,peer)]);assert.equal(results[0],results[1]);
   assert.equal((await a.query('select count(*) from public.household_archives where household_id=$1',[ledger])).rows[0].count,'1');
  });
  await check('P8 archive approval racing ordinary submission serializes; no new financial proposal after archive',async()=>{
   const ledger=await create(),id=await request(ledger);
   const results=await Promise.allSettled([decide(id),submit(ledger,payload('deposit',100,{payerMemberId:userA}))]);
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
   const state=(await plan(ledger)).status;
   if(state==='archived')assert.equal((await a.query("select count(*) from public.proposals where household_id=$1 and payload->>'type'='deposit'",[ledger])).rows[0].count,'0');
   else assert.equal((await a.query('select count(*) from public.household_archives where household_id=$1',[ledger])).rows[0].count,'0');
  });
  await check('P8 archive racing invitation acceptance cannot add a third member; legacy archive can restore without inventing a snapshot',async()=>{
   const ledger=await create(true),token=pendingInvites.get(ledger);
   const id=await request(ledger);
   const results=await Promise.allSettled([decide(id),c.query('select public.accept_invitation($1)',[token])]);
   assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
   assert.equal((await admin.query('select count(*) from public.household_members where household_id=$1 and active',[ledger])).rows[0].count,'2');
   const legacy=await create();
   await admin.query("update public.households set status='archived',time_zone_confirmed=false where id=$1",[legacy]);
   const legacyPlan=await plan(legacy);assert.equal(legacyPlan.blockers.length,0);
   assert.equal(domain.managementOverview(legacyPlan.snapshot).assetsMinor,null);
   assert.equal(domain.managementOverview(legacyPlan.snapshot).netMinor,null);
   await decide(await request(legacy,'restore'));
   assert.equal((await plan(legacy)).status,'active');assert.equal((await plan(legacy)).snapshot.configuration.time_zone_confirmed,false);
   assert.equal((await a.query('select count(*) from public.household_archives where household_id=$1',[legacy])).rows[0].count,'0');
  });
  await check('P8 injected archive failure rolls back snapshot, household, approval and audit',async()=>{
   const ledger=await create(),id=await request(ledger),before=(await plan(ledger)).version;
   await admin.query(`create function public.fail_archive_test() returns trigger language plpgsql as $$begin if new.id='${ledger}' and new.status='archived' then raise exception 'archive injected failure';end if;return new;end;$$;create trigger fail_archive_test before update on public.households for each row execute function public.fail_archive_test();`);
   try {await assert.rejects(decide(id),/injected failure/);assert.equal((await plan(ledger)).status,'active');assert.equal((await plan(ledger)).version,before);assert.equal((await a.query('select count(*) from public.household_archives where household_id=$1',[ledger])).rows[0].count,'0');assert.equal((await a.query('select status from public.proposals where id=$1',[id])).rows[0].status,'pending_approval');}
   finally {await admin.query('drop trigger fail_archive_test on public.households;drop function public.fail_archive_test()');}
   await decide(id);
  });
  await check('P8 pending approvals and unknown historical payer block archive; report does not invent facts',async()=>{
   const ledger=await create(),ordinary=await submit(ledger,payload('deposit',100,{payerMemberId:userA}));
   await assert.rejects(request(ledger),/待审批/);await a.query('select public.withdraw_proposal($1)',[ordinary]);
   const pid=randomUUID();await admin.query("insert into public.proposals(id,household_id,submitter_id,idempotency_key,status,payload) values($1,$2,$3,$4,'approved',$5)",[pid,ledger,userA,randomUUID(),JSON.stringify(payload('deposit',100))]);
   await admin.query("insert into public.ledger_entries(household_id,proposal_id,entry_type,status,amount_minor,currency,occurred_at,effective_sequence,title,account_kind) values($1,$2,'deposit','posted',100,'USD','2026-09-02',1,'Unknown old payer','bank')",[ledger,pid]);
   const review=await plan(ledger);assert.equal(review.migrationIssues.length,1);assert.match(review.migrationIssues[0].reason,/实际出资/);await assert.rejects(request(ledger),/历史数据待核对/);
   assert.equal((await a.query('select payer_member_id from public.ledger_entries where proposal_id=$1',[pid])).rows[0].payer_member_id,null);
  });
 } finally {await rm(domain.directory,{recursive:true,force:true});}
}
