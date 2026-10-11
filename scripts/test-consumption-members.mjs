import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function testConsumptionMembers({a,b,c,admin,household,category,rpcSubmit,decide,check,userA,userB,outsider,connect}) {
 const twin=await connect();await twin.query('set role authenticated');await twin.query("select set_config('request.jwt.claim.sub',$1,false)",[userA]);
 const base={type:'reimbursement',amountMinor:1000,currency:'USD',occurredAt:'2026-09-02',title:'A pays for B',categoryId:category.id,category:category.name,payerMemberId:userA};
 const row=async id=>(await a.query('select * from public.ledger_entries where id=$1',[id])).rows[0];
 const correction=async p=>(await a.query('select public.submit_correction($1,$2::jsonb,$3) id',[household,JSON.stringify(p),randomUUID()])).rows[0].id;
 let source;
 await check('Consumers independent of payer: approval, retry, claim amount and legacy unknown',async()=>{
  const payload={...base,consumerScope:'member',consumerMemberId:userB},key=randomUUID(),p=await rpcSubmit(a,payload,key);
  assert.equal(await rpcSubmit(a,payload,key),p);
  await assert.rejects(rpcSubmit(a,{...payload,consumerMemberId:userA},key),/幂等键/);
  await assert.rejects(decide(a,p),/submitter/);
  source=await decide(b,p);assert.equal(await decide(b,p),source);
  const concurrentKey=randomUUID();
  const attempts=await Promise.allSettled([rpcSubmit(a,{...payload,title:'concurrent consumer'},concurrentKey),rpcSubmit(twin,{...payload,title:'concurrent consumer',consumerMemberId:userA},concurrentKey)]);
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  const e=await row(source);assert.equal(e.consumer_member_id,userB);assert.equal(e.consumer_scope,'member');assert.equal(e.payer_member_id,userA);assert.equal(e.amount_minor,'1000');
  const claim=(await a.query('select claimant_id,claimed_minor from public.reimbursement_claims where source_entry_id=$1',[source])).rows[0];
  assert.equal(claim.claimant_id,userA);assert.equal(claim.claimed_minor,'1000');
  const legacy=await row(await decide(b,await rpcSubmit(a,base)));assert.equal(legacy.consumer_scope,null);assert.equal(legacy.consumer_member_id,null);
  const shared=await row(await decide(b,await rpcSubmit(a,{...base,consumerScope:'common'})));assert.equal(shared.consumer_scope,'common');assert.equal(shared.consumer_member_id,null);
 });
 await check('Consumer payload integrity, outsider and direct row writes denied',async()=>{
  for(const extra of [{consumerScope:'member'},{consumerMemberId:userB},{consumerScope:'common',consumerMemberId:userA},{consumerScope:'other'},{consumerScope:null},{consumerScope:'member',consumerMemberId:outsider}]) await assert.rejects(rpcSubmit(a,{...base,...extra}));
  await assert.rejects(rpcSubmit(a,{type:'deposit',amountMinor:100,currency:'USD',occurredAt:'2026-09-02',title:'invalid consumption',payerMemberId:userA,consumerScope:'common'}));
  await assert.rejects(c.query('select public.submit_proposal($1,$2::jsonb,$3)',[household,JSON.stringify({...base,consumerScope:'member',consumerMemberId:outsider}),randomUUID()]),/not authorized/);
  const denied=await a.query('update public.ledger_entries set consumer_member_id=$1 where id=$2',[userA,source]);assert.equal(denied.rowCount,0);assert.equal((await row(source)).consumer_member_id,userB);
  await assert.rejects(a.query('select public.validate_before_consumption_members($1,$2::jsonb)',[household,JSON.stringify(base)]),/permission denied/);
 });
 await check('Both refund destinations inherit consumer; refund cannot forge beneficiary',async()=>{
  for(const recipient of ['member','common']) {
   const payload={type:'expense_refund',sourceEntryId:source,recipient,amountMinor:100,occurredAt:'2026-09-03',title:'consumer inheritance',...(recipient==='common'?{accountKind:'bank'}:{})};
   await assert.rejects(correction({...payload,consumerScope:'common'}),/unexpected/);
   const e=await row(await decide(b,await correction(payload)));assert.equal(e.consumer_scope,'member');assert.equal(e.consumer_member_id,userB);assert.equal(e.payer_member_id,userA);
  }
  const common=await decide(b,await rpcSubmit(a,{...base,type:'expense',payerMemberId:undefined,accountKind:'bank',consumerScope:'common'}));
  const e=await row(await decide(b,await correction({type:'expense_refund',sourceEntryId:common,recipient:'common',amountMinor:100,accountKind:'bank',occurredAt:'2026-09-03',title:'shared refund'})));
  assert.equal(e.consumer_scope,'common');assert.equal(e.consumer_member_id,null);
 });
 await check('Voiding replacement retains consumer; management snapshot retains consumption facts',async()=>{
  const payload={...base,type:'expense',payerMemberId:undefined,accountKind:'bank',consumerScope:'member',consumerMemberId:userB};
  const e=await decide(b,await rpcSubmit(a,payload));
  const vp=await correction({type:'void_record',targetKind:'entry',targetId:e,reason:'correct amount',replacementPayload:{...payload,amountMinor:1200}});await decide(b,vp);
  const replacement=(await a.query('select replacement_proposal_id from public.void_requests where proposal_id=$1',[vp])).rows[0].replacement_proposal_id;
  const r=await row(await decide(b,replacement));assert.equal(r.consumer_scope,'member');assert.equal(r.consumer_member_id,userB);assert.equal(r.amount_minor,'1200');
  const frozen=(await a.query('select public.get_household_management_plan($1) p',[household])).rows[0].p.snapshot.entries.find(x=>x.id===r.id);assert.equal(frozen.consumer_member_id,userB);
  // Composite FK prevents assigning a member from a different ledger even for an internal write.
  await assert.rejects(admin.query('update public.ledger_entries set consumer_member_id=$1 where id=$2',[outsider,r.id]),/foreign key/);
 });
 await check('Archive freezes consumer metadata; legacy upgrade rows remain unknown',async()=>{
  const h=(await a.query("select public.create_household('Consumer archive','USD','UTC') id")).rows[0].id;
  await admin.query("insert into public.household_members(household_id,user_id,role) values($1,$2,'member')",[h,userB]);
  const cat=(await a.query('select id,name from public.spending_categories where household_id=$1 limit 1',[h])).rows[0];
  const payload={...base,type:'expense',payerMemberId:undefined,accountKind:'bank',categoryId:cat.id,category:cat.name,consumerScope:'member',consumerMemberId:userB};
  const p=(await a.query('select public.submit_proposal($1,$2::jsonb,$3) id',[h,JSON.stringify(payload),randomUUID()])).rows[0].id;
  const entry=await decide(b,p),plan=(await a.query('select public.get_household_management_plan($1) p',[h])).rows[0].p;
  const archive=(await a.query("select public.submit_household_management($1,'archive','consumer snapshot', $2,$3) id",[h,plan.version,randomUUID()])).rows[0].id;
  await decide(b,archive);
  const snapshot=(await a.query('select snapshot from public.household_archives where household_id=$1',[h])).rows[0].snapshot;
  assert.equal(snapshot.entries.find(e=>e.id===entry).consumer_member_id,userB);
  assert.equal(snapshot.entries.find(e=>e.id===entry).consumer_scope,'member');
  assert.equal((await admin.query("select count(*) from public.ledger_entries where title='legacy source' and (consumer_scope is not null or consumer_member_id is not null)")).rows[0].count,'0');
 });
}
