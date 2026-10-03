import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function testP6({a,b,c,admin,household,userA,claim,request,submit,proposal,rpcSubmit,decide,createInvestment,buyPayload,basisFor,check}) {
 const correction=async(db,p,key=randomUUID())=>(await db.query('select public.submit_correction($1,$2::jsonb,$3) id',[household,JSON.stringify(p),key])).rows[0].id;
 const refund=(source,amount,recipient='member')=>({type:'expense_refund',sourceEntryId:source,recipient,amountMinor:amount,occurredAt:'2026-09-04',title:'linked refund',...(recipient==='common'?{accountKind:'bank'}:{})});
 const financials=async(id)=>(await admin.query('select public.claim_financials_internal($1) f',[id])).rows[0].f;
 const fresh=async(id)=>(await a.query('select * from public.reimbursement_claims where id=$1',[id])).rows[0];
 const returning=async(id,amount,currency='USD')=>({type:'member_return',claimId:id,originalAmountMinor:amount,expectedVersion:Number((await fresh(id)).version),currency,accountKind:'bank',occurredAt:'2026-09-05',title:'return overpayment'});
 const voiding=(id,kind='entry',extra={})=>({type:'void_record',targetId:id,targetKind:kind,reason:'incorrect record',...extra});
 const plan=async(id,kind='entry')=>(await a.query('select public.get_void_plan($1,$2,$3) p',[household,kind,id])).rows[0].p;
 const pay=async(original,amount)=>decide(b,await proposal(await submit(a,request([[original,amount]]))));
 await check('P6 AC25 G300/S300/member refund100/return100: original currency debt, personal cash zero, no contribution',async()=>{
  const x=await claim(30000);await pay(x,30000);const rp=await correction(a,refund(x.source_entry_id,10000));await assert.rejects(decide(a,rp),/submitter cannot/);const rid=await decide(b,rp);
  const r=(await a.query('select * from public.ledger_entries where id=$1',[rid])).rows[0];assert.equal(r.account_kind,null);assert.equal(r.category,'交通');assert.equal(r.currency,'USD');assert.equal(r.refund_source_entry_id,x.source_entry_id);
  assert.equal((await financials(x.id)).refunded,10000);assert.equal((await financials(x.id)).paid,30000);
  const ret=await correction(a,await returning(x.id,10000));const e=await decide(b,ret);assert.equal(await decide(b,ret),e);assert.equal((await financials(x.id)).returned,10000);
  const row=(await a.query('select * from public.ledger_entries where id=$1',[e])).rows[0];assert.equal(row.entry_type,'member_return');assert.equal(row.recovery_original_minor,'10000');assert.equal(row.payer_member_id,userA);
  await assert.rejects(correction(a,await returning(x.id,1)),/应返共同款/);
  await assert.rejects(plan(rid),/返还/);const vp=await correction(a,voiding(e));await decide(b,vp);const vrefund=await correction(a,voiding(rid));await decide(b,vrefund);assert.equal((await financials(x.id)).refunded,0);assert.equal((await financials(x.id)).returned,0);
 });
 await check('P6 AC26 common refund increases cash, inherits use, does not reduce original member debt',async()=>{
  const x=await claim(30000);const id=await decide(b,await correction(a,refund(x.source_entry_id,10000,'common')));const r=(await a.query('select * from public.ledger_entries where id=$1',[id])).rows[0];assert.equal(r.category,'交通');assert.equal(r.account_kind,'bank');assert.equal((await financials(x.id)).refunded,0);assert.equal((await fresh(x.id)).claimed_minor,'30000');await assert.rejects(plan(x.source_entry_id),/退款/);
 });
 await check('P6 AC63 partial paid100/original300/refund250 yields recovery50; returns are per original',async()=>{
  const x=await claim(30000);await pay(x,10000);await decide(b,await correction(a,refund(x.source_entry_id,25000)));const f=await financials(x.id);assert.equal(Math.max(f.paid-(f.original-f.refunded),0),5000);await assert.rejects(submit(a,request([[await fresh(x.id),1]])),/额度不足|原单状态/);await decide(b,await correction(a,await returning(x.id,5000)));
  const other=await claim(10000);await assert.rejects(correction(a,await returning(other.id,1)),/应返共同款/);
 });
 await check('P6 AC64 reserved80/original100/refund50 fails atomically until payment withdrawn',async()=>{
  const x=await claim(10000),batch=await submit(a,request([[x,8000]])),p=await correction(a,refund(x.source_entry_id,5000));await assert.rejects(decide(b,p),/预留冲突/);assert.equal((await financials(x.id)).refunded,0);assert.equal((await a.query('select count(*) from public.ledger_entries where proposal_id=$1',[p])).rows[0].count,'0');await a.query('select public.withdraw_proposal($1)',[await proposal(batch)]);await decide(b,p);await assert.rejects(submit(a,request([[await fresh(x.id),5001]])),/额度不足/);await pay(await fresh(x.id),5000);
 });
 await check('P6 concurrent refund approvals cannot exceed source; bypass and forged metadata denied',async()=>{
  const x=await claim(10000),p=await correction(a,refund(x.source_entry_id,8000)),q=await correction(b,refund(x.source_entry_id,8000));const results=await Promise.allSettled([decide(b,p),decide(a,q)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await financials(x.id)).refunded,8000);
  await assert.rejects(rpcSubmit(a,{...refund(x.source_entry_id,1),currency:'USD'}),/原单/);await assert.rejects(correction(a,{...refund(x.source_entry_id,1),currency:'CNY'}),/unexpected refund/);await assert.rejects(correction(c,refund(x.source_entry_id,1)),/not authorized/);await assert.rejects(c.query('select public.get_void_plan($1,$2,$3)',[household,'entry',x.source_entry_id]),/not authorized/);
 });
 await check('P6 return reservations serialize, withdrawal releases, foreign payment freezes exact FX',async()=>{
  const x=await claim(72000,'CNY');await pay(x,72000);await decide(b,await correction(a,refund(x.source_entry_id,36000)));
  const payload=await returning(x.id,28800),results=await Promise.allSettled([correction(a,payload),correction(b,payload)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await financials(x.id)).returnReserved,28800);const winner=results.findIndex(r=>r.status==='fulfilled');await [a,b][winner].query('select public.withdraw_proposal($1)',[results[winner].value]);
  const q=await correction(a,await returning(x.id,36000));const id=await decide(b,q),r=(await a.query('select * from public.ledger_entries where id=$1',[id])).rows[0];assert.equal(r.amount_minor,'5000');assert.equal(r.currency,'USD');assert.equal(r.recovery_original_minor,'36000');assert(r.fx_snapshot_id);assert.equal((await financials(x.id)).returned,36000);
 });
 await check('P6 AC28 void payment releases every allocation and restores debt without reverse cash entry',async()=>{
  const x=await claim(10000),y=await claim(20000),batch=await submit(a,request([[x,10000],[y,20000]])),entry=await decide(b,await proposal(batch));await assert.rejects(plan(x.source_entry_id),/核销|打款/);
  const impact=await plan(entry);assert.equal(impact.claimEffects.length,2);assert.equal(impact.cashEffects[0].deltaMinor,30000);const count=(await a.query('select count(*) from public.ledger_entries')).rows[0].count;
  const id=await correction(a,voiding(entry));await decide(b,id);assert.equal(await decide(b,id),id);assert.equal((await a.query('select count(*) from public.ledger_entries')).rows[0].count,count);assert.equal((await financials(x.id)).paid,0);assert.equal((await financials(y.id)).paid,0);assert.equal((await a.query('select status from public.settlement_batches where id=$1',[batch])).rows[0].status,'voided');assert((await a.query('select status from public.settlement_allocations where batch_id=$1',[batch])).rows.every(r=>r.status==='voided'));
  const sourceVoid=await correction(a,voiding(x.source_entry_id));await decide(b,sourceVoid);assert.equal((await fresh(x.id)).status,'voided');
 });
 await check('P6 AC47 combined funding and buy void together, exactly restores both currency legs',async()=>{
  const i=await createInvestment(),p=await rpcSubmit(a,{...buyPayload(i),funding:{currency:'CNY',amountMinor:72000,destinationAmountMinor:9500,occurredAt:'2026-09-01'}}),e=await decide(b,p),t=(await a.query('select * from public.cash_transfers where proposal_id=$1',[p])).rows[0];
  const impact=await plan(t.id,'transfer');assert.equal(impact.entries.length,1);assert.equal(impact.transfers.length,1);assert(impact.cashEffects.some(x=>x.currency==='CNY'&&x.deltaMinor===72000));assert(impact.cashEffects.some(x=>x.currency==='USD'&&x.deltaMinor===500));assert.equal(impact.investmentEffects[0].after.quantityMicro,0);
  await decide(b,await correction(a,voiding(t.id,'transfer')));assert.equal((await a.query('select status from public.ledger_entries where id=$1',[e])).rows[0].status,'voided');assert.equal((await a.query('select status from public.cash_transfers where id=$1',[t.id])).rows[0].status,'voided');assert.equal((await a.query('select status from public.proposals where id=$1',[p])).rows[0].status,'approved');
 });
 await check('P6 AC27/70 later sale prevents source/combined void; linked external buy blocks transfer void',async()=>{
  const i=await createInvestment(),p=await rpcSubmit(a,{...buyPayload(i),funding:{currency:'USD',amountMinor:10000,destinationAmountMinor:10000,occurredAt:'2026-09-01'}}),e=await decide(b,p),t=(await a.query('select id from public.cash_transfers where proposal_id=$1',[p])).rows[0].id;
  await decide(b,await rpcSubmit(a,{...buyPayload(i,500000,5000,'2026-09-03'),type:'investment_sell'}));await assert.rejects(plan(e),/后续持仓/);assert.equal((await a.query('select status from public.cash_transfers where id=$1',[t])).rows[0].status,'posted');
  const j=await createInvestment(),fund=await rpcSubmit(a,{...buyPayload(j),funding:{currency:'USD',amountMinor:10000,destinationAmountMinor:10000,occurredAt:'2026-09-01'}});await decide(b,fund);const ft=(await a.query('select id from public.cash_transfers where proposal_id=$1',[fund])).rows[0].id;await decide(b,await rpcSubmit(a,{...buyPayload(j),linkedTransferId:ft}));await assert.rejects(plan(ft,'transfer'),/关联|转入/);
 });
 await check('P6 valuation dependency requires valuation void first; pending valuation must be withdrawn',async()=>{
  const i=await createInvestment(),e=await decide(b,await rpcSubmit(a,buyPayload(i))),p=await rpcSubmit(a,{type:'investment_valuation',investmentId:i,currency:'USD',amountMinor:0,title:'value',occurredAt:'2026-09-02',valuationMode:'total_market',totalValueMinor:12000,basis:await basisFor(i)});await decide(b,p);const v=(await a.query('select id from public.investment_valuations where proposal_id=$1',[p])).rows[0].id;
  const vp=await correction(a,voiding(e));await assert.rejects(decide(b,vp),/估值依据/);assert.equal((await a.query('select status from public.ledger_entries where id=$1',[e])).rows[0].status,'posted');await decide(b,await correction(a,voiding(v,'valuation')));await decide(b,vp);
  const j=await createInvestment(),je=await decide(b,await rpcSubmit(a,buyPayload(j))),pending=await rpcSubmit(a,{type:'investment_valuation',investmentId:j,currency:'USD',amountMinor:0,title:'pending value',occurredAt:'2026-09-02',valuationMode:'total_market',totalValueMinor:10000,basis:await basisFor(j)}),voidP=await correction(a,voiding(je));await assert.rejects(decide(b,voidP),/待审估值/);await a.query('select public.withdraw_proposal($1)',[pending]);await decide(b,voidP);
 });
 await check('P6 immutable void reason, frozen impact recheck, independent replacement pending and RLS',async()=>{
  const payload={type:'expense',amountMinor:1000,currency:'USD',accountKind:'bank',occurredAt:'2026-09-01',title:'wrong expense',category:'交通'},e=await decide(b,await rpcSubmit(a,payload));await assert.rejects(correction(a,voiding(e,'entry',{reason:' '})),/作废原因/);const key=randomUUID(),req=voiding(e,'entry',{replacementPayload:{...payload,amountMinor:2000,title:'correct expense'}}),p=await correction(a,req,key);assert.equal(await correction(a,req,key),p);await assert.rejects(correction(a,{...req,reason:'different'},key),/幂等键/);await decide(b,p);
  const v=(await a.query('select * from public.void_requests where proposal_id=$1',[p])).rows[0];assert.equal(v.reason,'incorrect record');assert(v.replacement_proposal_id);const replacement=(await a.query('select * from public.proposals where id=$1',[v.replacement_proposal_id])).rows[0];assert.equal(replacement.status,'pending_approval');assert.equal(replacement.submitter_id,userA);assert.equal((await a.query('select count(*) from public.ledger_entries where proposal_id=$1',[replacement.id])).rows[0].count,'0');await assert.rejects(decide(a,replacement.id),/submitter cannot/);await decide(b,replacement.id);
  assert.equal((await c.query('select count(*) from public.void_requests where household_id=$1',[household])).rows[0].count,'0');assert.equal((await a.query("update public.void_requests set reason='tamper' returning id")).rowCount,0);
  const i=await createInvestment(),buy=await decide(b,await rpcSubmit(a,buyPayload(i))),stale=await correction(a,voiding(buy));await decide(b,await rpcSubmit(a,buyPayload(i,1000000,10000,'2026-09-03')));await assert.rejects(decide(b,stale),/影响已变化/);assert.equal((await a.query('select status from public.ledger_entries where id=$1',[buy])).rows[0].status,'posted');
 });
 await check('P6 standalone record can be audited voided; cash helper private; reject/withdraw never post',async()=>{
  const legacy=await decide(b,await rpcSubmit(a,{type:'deposit',amountMinor:1234,currency:'USD',occurredAt:'2026-09-01',title:'standalone deposit',payerMemberId:userA,accountKind:'bank'}));const impact=await plan(legacy);assert.equal(impact.entries.length,1);assert.equal(impact.cashEffects[0].afterMinor-impact.cashEffects[0].beforeMinor,-1234);await decide(b,await correction(a,voiding(legacy)));assert.equal((await a.query('select status from public.ledger_entries where id=$1',[legacy])).rows[0].status,'voided');await assert.rejects(a.query('select public.cash_balance_internal($1,$2,$3)',[household,'bank','USD']),/permission denied/);
  const x=await claim(10000),p=await correction(a,refund(x.source_entry_id,1000)),q=await correction(a,refund(x.source_entry_id,2000));await decide(b,p,false);await a.query('select public.withdraw_proposal($1)',[q]);assert.equal((await financials(x.id)).refunded,0);await assert.rejects(correction(a,{...refund(x.source_entry_id,1),occurredAt:'2026-09-01'}),/早于原消费/);
 });
 await check('P6 injected void second-step failure preserves transfer, buy, proposal and audit atomically',async()=>{
  const i=await createInvestment(),original=await rpcSubmit(a,{...buyPayload(i),funding:{currency:'USD',amountMinor:10000,destinationAmountMinor:10000,occurredAt:'2026-09-01'}}),entry=await decide(b,original),p=await correction(a,voiding(entry)),t=(await a.query('select id from public.cash_transfers where proposal_id=$1',[original])).rows[0].id;
  await admin.query(`create function public.test_fail_void() returns trigger language plpgsql as $$begin if new.id='${t}' and new.status='voided' then raise exception 'injected void failure';end if;return new;end;$$;create trigger test_fail_void before update on public.cash_transfers for each row execute function public.test_fail_void();`);
  try {await assert.rejects(decide(b,p),/injected void failure/);assert.equal((await a.query('select status from public.ledger_entries where id=$1',[entry])).rows[0].status,'posted');assert.equal((await a.query('select status from public.cash_transfers where id=$1',[t])).rows[0].status,'posted');assert.equal((await a.query('select status from public.proposals where id=$1',[p])).rows[0].status,'pending_approval');assert.equal((await a.query("select count(*) from public.audit_logs where entity_id=$1 and action='approve'",[p])).rows[0].count,'0');}
  finally {await admin.query('drop trigger test_fail_void on public.cash_transfers;drop function public.test_fail_void()');}
  await decide(b,p);
 });
}
