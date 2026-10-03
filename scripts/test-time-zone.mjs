import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function testTimeZone({a,b,c,admin,userB,check}) {
 const create = async zone => (await a.query("select public.create_household('Timezone acceptance','USD',$1) id",[zone])).rows[0].id;
 await check('Time zone: browser zone persisted, valid IANA only; legacy UTC requires confirmation',async()=>{
  const h=await create('Asia/Hong_Kong');
  const row=(await a.query('select time_zone,time_zone_confirmed from public.households where id=$1',[h])).rows[0];
  assert.deepEqual(row,{time_zone:'Asia/Hong_Kong',time_zone_confirmed:true});
  await assert.rejects(create('Bogus/Zone'),/invalid ledger time zone/);
  await assert.rejects(create('UTC0'),/invalid ledger time zone/);
  const old=(await a.query("select public.create_household('Legacy timezone','USD') id")).rows[0].id;
  assert.equal((await a.query('select time_zone_confirmed from public.households where id=$1',[old])).rows[0].time_zone_confirmed,false);
  await a.query("select public.set_household_time_zone($1,'America/New_York')",[old]);
  await assert.rejects(c.query("select public.set_household_time_zone($1,'UTC')",[old]),/not authorized/);
 });
 await check('Time zone: API/RPC business date honors ledger zone, independent of hostile caller zone',async()=>{
  for (const zone of ['Pacific/Kiritimati','America/Adak']) {
   const h=await create(zone); await admin.query("insert into public.household_members(household_id,user_id,role) values($1,$2,'member')",[h,userB]);
   const date=(await admin.query("select (now() at time zone $1)::date::text today, ((now() at time zone $1)::date+1)::text future",[zone])).rows[0];
   const cat=(await a.query("select id,name from public.spending_categories where household_id=$1 limit 1",[h])).rows[0];
   const payload={type:'expense',amountMinor:100,currency:'USD',occurredAt:date.today,title:'business date',categoryId:cat.id,category:cat.name,accountKind:'bank'};
   await a.query("set time zone 'Etc/GMT+12'");await b.query("set time zone 'Etc/GMT+12'");
   const id=(await a.query('select public.submit_proposal($1,$2::jsonb,$3) id',[h,JSON.stringify(payload),randomUUID()])).rows[0].id;
   const entry=(await b.query('select public.decide_proposal($1,true,null) id',[id])).rows[0].id;
   assert.equal((await a.query('select occurred_at::text date from public.ledger_entries where id=$1',[entry])).rows[0].date,date.today);
   await assert.rejects(a.query('select public.submit_proposal($1,$2::jsonb,$3)',[h,JSON.stringify({...payload,occurredAt:date.future}),randomUUID()]),/future/);
   await assert.rejects(a.query("select public.set_household_time_zone($1,'UTC')",[h]),/已确认时区不能直接修改/);
  }
  await a.query("set time zone 'UTC'");await b.query("set time zone 'UTC'");
 });
}
