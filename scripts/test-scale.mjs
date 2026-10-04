import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { rm } from 'node:fs/promises';
import { loadDomain, normalize } from './test-p7.mjs';

export async function testScale({a,b,admin,userA,userB,check}) {
  await check('AC-07/77 10,000 PostgreSQL rows: all page sizes reconcile cash and spending using production calculators',async()=>{
    const h=(await a.query("select public.create_household('Disposable 10k scale check','USD','UTC') id")).rows[0].id;
    await admin.query("insert into public.household_members(household_id,user_id,role) values($1,$2,'member')",[h,userB]);
    const fxProposal=(await a.query('select public.submit_proposal($1,$2::jsonb,gen_random_uuid()) id',[h,JSON.stringify({type:'fx_rate_update',currency:'USD',amountMinor:0,occurredAt:'2026-09-01',title:'Scale fixture FX',effectiveAt:'2026-09-01T00:00:00Z',usdToCny:'7.2',usdToHkd:'7.8',sourceNote:'Disposable scale fixture'})])).rows[0].id;
    await b.query('select public.decide_proposal($1,true,null)',[fxProposal]);
    const start=performance.now();
    const fxId=(await a.query("select id from public.fx_rate_snapshots where household_id=$1 and status='approved'",[h])).rows[0].id;
    // Bounded fixture transactions match normal incremental usage and avoid
    // benchmarking a 20,000-update HOT chain in one administrative transaction.
    for(let first=1;first<=10000;first+=100) {
    const last=first+99;
    await admin.query('begin');
    try {
      await admin.query(`with fixtures as (
        select n,gen_random_uuid() id,case when n%4=0 then 'deposit' else 'expense' end kind,
         case n%3 when 0 then 'USD' when 1 then 'CNY' else 'HKD' end currency,(n%10000)+1 amount
        from generate_series($4::int,$5::int) n
      ) insert into public.proposals(id,household_id,submitter_id,idempotency_key,status,payload,fx_snapshot_id)
        select id,$1::uuid,$2::uuid,gen_random_uuid(),'approved',jsonb_build_object('type',kind,'amountMinor',amount,'currency',currency,'occurredAt','2026-09-01','title','Scale fixture','accountKind','bank','payerMemberId',$2::uuid,'sequence',n),$3::uuid from fixtures`,[h,userA,fxId,first,last]);
      await admin.query(`insert into public.ledger_entries(household_id,proposal_id,entry_type,amount_minor,currency,occurred_at,effective_sequence,title,member_id,payer_member_id,account_kind)
        select $1::uuid,id,payload->>'type',(payload->>'amountMinor')::bigint,payload->>'currency','2026-09-01',(payload->>'sequence')::bigint,'Scale fixture',$2::uuid,$2::uuid,'bank' from public.proposals where household_id=$1 and payload->>'title'='Scale fixture' and (payload->>'sequence')::int between $3::int and $4::int`,[h,userA,first,last]);
      await admin.query('commit');
    } catch(error) {await admin.query('rollback');throw error;}
    }
    const expected=Object.fromEntries((await a.query("select currency,sum(case when entry_type='deposit' then amount_minor else -amount_minor end)::bigint cash,sum(amount_minor) filter(where entry_type='expense')::bigint spending,count(*)::int count from public.ledger_entries where household_id=$1 and status='posted' group by currency",[h])).rows.map(r=>[r.currency,{cash:Number(r.cash),spending:Number(r.spending),count:r.count}]));
    const domain=await loadDomain();
    try {
      for(const size of [97,500,1000]) {
        const rows=[];
        for(let offset=0;;offset+=size) {
          const page=(await a.query('select * from public.ledger_entries where household_id=$1 order by occurred_at,effective_sequence,id limit $2 offset $3',[h,size,offset])).rows;
          rows.push(...page.map(normalize)); if(page.length<size)break;
        }
        assert.equal(rows.length,10000);
        const events=rows.reverse().map(domain.ledgerEventFromRow),balances=domain.accountCashBalances(events);
        for(const currency of ['USD','CNY','HKD']) assert.equal(balances.bank[currency],expected[currency].cash);
        const usd=events.filter(e=>e.currency==='USD');
        const report=domain.buildSpendingReport(usd,'USD',{},domain.normalizeLedgerFilters({start:'2026-09-01',end:'2026-09-01'}));
        assert.equal(report.grossMinor,expected.USD.spending);
        assert.equal(report.records.length,usd.filter(e=>e.type==='expense').length);
      }
      console.log(`INFO 10k fixture insert + 3 RLS pagination/projection runs: ${Math.round(performance.now()-start)}ms (local disposable PG; not a hosted latency SLA)`);
    } finally {await rm(domain.directory,{recursive:true,force:true});}
  });
}
