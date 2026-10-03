import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function testLedgerUX({a,b,c,admin,household,category,rpcSubmit,decide,check,userA}) {
  const expense = {type:'expense',amountMinor:100,currency:'USD',occurredAt:'2026-09-02',title:'Automatic project',categoryId:category.id,category:category.name,accountKind:'bank'};
  const count = async name => (await a.query('select count(*) from public.spending_projects where household_id=$1 and normalized_name=$2',[household,name.trim().replace(/\s+/g, ' ').toLowerCase()])).rows[0].count;
  await check('UX auto project create, normalized reuse and approval retain canonical name/ID',async()=>{
    const first = await rpcSubmit(a,{...expense,project:'  秋季   旅行  '});
    const second = await rpcSubmit(a,{...expense,type:'reimbursement',accountKind:undefined,payerMemberId:userA,project:'秋季 旅行'});
    assert.equal(await count('秋季 旅行'),'1');
    const rows = (await a.query('select payload from public.proposals where id=any($1::uuid[])',[ [first,second] ])).rows;
    assert.equal(rows[0].payload.projectId,rows[1].payload.projectId);assert.equal(rows[0].payload.project,'秋季 旅行');
    const entry = await decide(b,first);
    const posted = (await a.query('select project_id,project_name from public.ledger_entries where id=$1',[entry])).rows[0];
    assert.equal(posted.project_name,'秋季 旅行');assert.equal(posted.project_id,rows[0].payload.projectId);
  });
  await check('UX concurrent member submissions reuse one project; retry and changed-content protection',async()=>{
    const key = randomUUID(),payload={...expense,project:'Concurrent UX Trip'};
    const [one,two] = await Promise.all([rpcSubmit(a,payload,key),rpcSubmit(b,{...payload,project:'concurrent ux trip'})]);
    assert.notEqual(one,two);assert.equal(await count(payload.project),'1');assert.equal(await rpcSubmit(a,payload,key),one);
    await assert.rejects(rpcSubmit(a,{...payload,title:'changed'},key),/幂等键/);
    await assert.rejects(rpcSubmit(a,{...payload,project:'Other UX Trip'},key),/幂等键/);assert.equal(await count('Other UX Trip'),'0');
    const project=(await a.query('select payload from public.proposals where id=$1',[one])).rows[0].payload.projectId;
    await a.query('select public.set_spending_project_archived($1,true)',[project]);
    assert.equal(await rpcSubmit(a,payload,key),one); // successful request remains retryable after later archival
    await assert.rejects(rpcSubmit(a,payload),/已归档/);
    await a.query('select public.set_spending_project_archived($1,false)',[project]);
  });
  await check('UX invalid submission rolls back project, audit and version; optional project creates nothing',async()=>{
    const name='Rollback UX Project';
    const before=(await a.query('select ledger_version from public.households where id=$1',[household])).rows[0].ledger_version;
    const logs=(await admin.query('select count(*) from public.audit_logs where household_id=$1',[household])).rows[0].count;
    await assert.rejects(rpcSubmit(a,{...expense,amountMinor:0,project:name}));
    assert.equal(await count(name),'0');
    assert.equal((await a.query('select ledger_version from public.households where id=$1',[household])).rows[0].ledger_version,before);
    assert.equal((await admin.query('select count(*) from public.audit_logs where household_id=$1',[household])).rows[0].count,logs);
    await assert.rejects(rpcSubmit(a,{...expense,project:42}));
    await assert.rejects(rpcSubmit(a,{...expense,project:'   '}));
    await assert.rejects(rpcSubmit(a,{...expense,project:'x'.repeat(61)}));
    const total=(await a.query('select count(*) from public.spending_projects where household_id=$1',[household])).rows[0].count;
    await rpcSubmit(a,expense);
    assert.equal((await a.query('select count(*) from public.spending_projects where household_id=$1',[household])).rows[0].count,total);
  });
  await check('UX outsider and private RPC denied; archive and reference validation preserved',async()=>{
    await assert.rejects(c.query('select public.submit_proposal($1,$2::jsonb,$3)',[household,JSON.stringify({...expense,project:'Outsider UX'}),randomUUID()]),/not authorized/);
    assert.equal(await count('Outsider UX'),'0');
    await assert.rejects(a.query('select public.submit_p7_proposal($1,$2::jsonb,$3)',[household,JSON.stringify(expense),randomUUID()]),/permission denied/);
    await assert.rejects(rpcSubmit(a,{...expense,project:'Bad ref',projectId:randomUUID()}));
    assert.equal(await count('Bad ref'),'0');
  });
}
