import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function testOnboarding({a,b,c,admin,userA,userB,connect,check}) {
  await check('Invitation replacement invalidates lost links, preserves other emails and checks recipient and owner',async()=>{
    const id=(await a.query("select public.create_household('Replace invitation','USD','UTC',$1) as id",[randomUUID()])).rows[0].id;
    const email=(await admin.query('select email from auth.users where id=$1',[userB])).rows[0].email;
    const old=(await a.query('select public.create_invitation($1,$2) as token',[id,email])).rows[0].token;
    await a.query("select public.create_invitation($1,'other@example.test')",[id]);
    await assert.rejects(a.query('select public.create_invitation($1,$2)',[id,email]),/active invitation already exists/);
    await assert.rejects(c.query('select public.replace_invitation($1,$2)',[id,email]),/owner permission required/);
    const token=(await a.query('select public.replace_invitation($1,$2) as token',[id,` ${email.toUpperCase()} `])).rows[0].token;
    assert.notEqual(token,old);assert.match(token,/^[a-f0-9]{64}$/);
    await assert.rejects(b.query('select public.accept_invitation($1)',[old]),/invalid or expired/);
    await assert.rejects(c.query('select public.accept_invitation($1)',[token]),/email does not match/);
    const rows=(await a.query('select email,status,revoked_at from public.invitations where household_id=$1',[id])).rows;
    assert.equal(rows.filter(row=>row.email===email && row.status==='pending').length,1);
    assert.ok(rows.find(row=>row.email===email && row.status==='revoked').revoked_at);
    assert.equal(rows.find(row=>row.email==='other@example.test').status,'pending');
    assert.equal((await a.query("select count(*) from public.audit_logs where household_id=$1 and action='revoke' and detail->>'reason'='replacement'",[id])).rows[0].count,'1');
    assert.equal((await b.query('select public.accept_invitation($1) as id',[token])).rows[0].id,id);
    await assert.rejects(b.query("select public.replace_invitation($1,'other@example.test')",[id]),/owner permission required/);
    await assert.rejects(a.query("select public.replace_invitation($1,'other@example.test')",[id]),/two active members/);
    assert.equal((await a.query("select status from public.invitations where household_id=$1 and email='other@example.test'",[id])).rows[0].status,'pending');
  });
  await check('Invitation replacement rolls back revocation when creation fails and serializes concurrent replacements',async()=>{
    const id=(await a.query("select public.create_household('Replacement rollback','USD','UTC',$1) as id",[randomUUID()])).rows[0].id;
    const email=(await admin.query('select email from auth.users where id=$1',[userB])).rows[0].email;
    await a.query('select public.create_invitation($1,$2)',[id,email]);
    await admin.query("update public.households set status='archived' where id=$1",[id]);
    await assert.rejects(a.query('select public.replace_invitation($1,$2)',[id,email]),/archived/);
    assert.equal((await a.query('select status from public.invitations where household_id=$1',[id])).rows[0].status,'pending');
    await admin.query("update public.households set status='active' where id=$1",[id]);
    const peer=await connect();await peer.query('set role authenticated');await peer.query("select set_config('request.jwt.claim.sub',$1,false)",[userA]);
    await Promise.all([a.query('select public.replace_invitation($1,$2)',[id,email]),peer.query('select public.replace_invitation($1,$2)',[id,email])]);
    assert.equal((await a.query("select count(*) from public.invitations where household_id=$1 and status='pending'",[id])).rows[0].count,'1');
    await admin.query('set role anon');
    try {await assert.rejects(admin.query('select public.replace_invitation($1,$2)',[id,email]),/permission denied/);}
    finally {await admin.query('reset role');}
  });
  await check('P8 onboarding concurrent retries create one empty ledger; mismatched payload and direct writes denied',async()=>{
    const key=randomUUID(),peer=await connect();
    await peer.query('set role authenticated');await peer.query("select set_config('request.jwt.claim.sub',$1,false)",[userA]);
    const sql="select public.create_household('First real ledger','CNY','Asia/Shanghai',$1) as id";
    const results=await Promise.all([a.query(sql,[key]),peer.query(sql,[key])]);
    const id=results[0].rows[0].id;assert.equal(results[1].rows[0].id,id);
    assert.equal((await a.query('select count(*) from public.household_members where household_id=$1',[id])).rows[0].count,'1');
    assert.equal((await a.query('select count(*) from public.cash_accounts where household_id=$1',[id])).rows[0].count,'2');
    for(const table of ['ledger_entries','proposals','investments','cash_transfers'])assert.equal((await a.query(`select count(*) from public.${table} where household_id=$1`,[id])).rows[0].count,'0');
    await assert.rejects(a.query("select public.create_household('Changed','CNY','Asia/Shanghai',$1)",[key]),/创建内容已变化/);
    assert.equal((await c.query('select count(*) from public.household_creation_requests where request_key=$1',[key])).rows[0].count,'0');
    await assert.rejects(a.query('delete from public.household_creation_requests where request_key=$1',[key]),/permission denied/);
  });
  await check('P8 invite acceptance retries only by original recipient; wrong email, third member and private bypass blocked',async()=>{
    const id=(await a.query("select public.create_household('Invitation retry','USD','UTC',$1) as id",[randomUUID()])).rows[0].id;
    const email=(await admin.query('select email from auth.users where id=$1',[userB])).rows[0].email;
    const token=(await a.query('select public.create_invitation($1,$2) as token',[id,email])).rows[0].token;
    await assert.rejects(c.query('select public.accept_invitation($1)',[token]),/email does not match/);
    assert.equal((await b.query('select public.accept_invitation($1) as id',[token])).rows[0].id,id);
    assert.equal((await b.query('select public.accept_invitation($1) as id',[token])).rows[0].id,id);
    assert.equal((await a.query('select count(*) from public.household_members where household_id=$1',[id])).rows[0].count,'2');
    assert.equal((await a.query("select count(*) from public.audit_logs where household_id=$1 and action='accept'",[id])).rows[0].count,'1');
    await assert.rejects(c.query('select public.accept_invitation($1)',[token]),/invalid or expired/);
    await assert.rejects(a.query("select public.create_invitation($1,'third@example.test')",[id]),/two active members/);
    await assert.rejects(b.query('select public.accept_invitation_before_retry($1)',[token]),/permission denied/);
    await admin.query("update public.households set status='archived' where id=$1",[id]);
    await assert.rejects(b.query('select public.accept_invitation($1)',[token]),/archived/);
  });
}
