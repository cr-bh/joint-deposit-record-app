-- P4: claim-linked partial/merged/cross-currency payments. All mutations are RPC-only.
alter table public.reimbursement_claims add column version bigint not null default 1 check (version>0);
-- PostgREST numeric JSON would pass through floating point before reaching the browser.
create view public.fx_rate_snapshots_exact with (security_invoker=true) as
select id,household_id,proposal_id,usd_to_cny::text,usd_to_hkd::text,effective_at,source_note,status,created_by,approved_by,approved_at,created_at from public.fx_rate_snapshots;
grant select on public.fx_rate_snapshots_exact to authenticated;
-- This revision covers the source obligation. Reservations/payments do not change it;
-- a later refund/correction must advance it, so pending payments can be revalidated.
create table public.settlement_batches (
  id uuid primary key default extensions.gen_random_uuid(),
  household_id uuid not null references public.households(id),
  proposal_id uuid not null unique references public.proposals(id),
  claimant_id uuid not null references public.profiles(id),
  account_kind text not null,
  currency text not null check (currency in ('USD','CNY','HKD')),
  amount_minor bigint not null check (amount_minor between 1 and 9999999999),
  fx_snapshot_id uuid references public.fx_rate_snapshots(id),
  ledger_entry_id uuid unique references public.ledger_entries(id),
  status text not null default 'reserved' check (status in ('reserved','posted','released')),
  created_at timestamptz not null default now(),
  foreign key (household_id,account_kind) references public.cash_accounts(household_id,kind),
  check ((status='posted')=(ledger_entry_id is not null))
);
alter table public.settlement_allocations alter column settlement_entry_id drop not null;
alter table public.settlement_allocations add column batch_id uuid references public.settlement_batches(id);
alter table public.settlement_allocations add column payment_minor bigint check (payment_minor>0);
alter table public.settlement_allocations add column claim_version bigint check (claim_version>0);
alter table public.settlement_allocations add column status text not null default 'posted' check (status in ('reserved','posted','released'));
alter table public.settlement_allocations add constraint settlement_allocation_lifecycle_check check (
  (status='posted' and settlement_entry_id is not null) or
  (status in ('reserved','released') and settlement_entry_id is null and batch_id is not null)
);
alter table public.settlement_allocations add constraint settlement_allocation_batch_fields_check check (
  batch_id is null or (payment_minor is not null and claim_version is not null)
);
create unique index settlement_allocation_batch_claim_idx on public.settlement_allocations(batch_id,claim_id);
create index settlement_batches_household_idx on public.settlement_batches(household_id,created_at desc,id);
-- Preserve only provable legacy payments: explicit payee, same currency, complete
-- linked allocations, equal cash total, same household, approved posted entry.
-- Unlinked/ambiguous history is left for the P8 migration review, never guessed.
insert into public.settlement_batches(household_id,proposal_id,claimant_id,account_kind,currency,amount_minor,fx_snapshot_id,ledger_entry_id,status,created_at)
select e.household_id,e.proposal_id,e.payee_member_id,e.account_kind,e.currency,e.amount_minor,e.fx_snapshot_id,e.id,'posted',e.created_at
from public.ledger_entries e join public.proposals p on p.id=e.proposal_id
where e.entry_type='settlement' and e.status='posted' and p.status='approved' and e.payee_member_id is not null
  and exists(select 1 from public.settlement_allocations a where a.settlement_entry_id=e.id)
  and e.amount_minor=(select sum(a.amount_minor) from public.settlement_allocations a where a.settlement_entry_id=e.id)
  and not exists(select 1 from public.settlement_allocations a join public.reimbursement_claims c on c.id=a.claim_id
    where a.settlement_entry_id=e.id and (a.household_id<>e.household_id or c.household_id<>e.household_id or c.claimant_id<>e.payee_member_id or c.currency<>e.currency));
update public.settlement_allocations a set batch_id=b.id,payment_minor=a.amount_minor,claim_version=c.version
from public.settlement_batches b,public.reimbursement_claims c
where a.settlement_entry_id=b.ledger_entry_id and c.id=a.claim_id;
alter table public.settlement_batches enable row level security;
create policy settlement_batches_read on public.settlement_batches for select using (public.is_household_member(household_id));
grant select on public.settlement_batches to authenticated;

-- Close the earlier free-amount settlement path, including all older validation wrappers.
alter function public.validate_proposal_payload(uuid,jsonb) rename to validate_p3_proposal_payload;
create function public.validate_proposal_payload(target_household uuid,payload_input jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if payload_input->>'type'='settlement' then raise exception '请从代付原单发起报销批次'; end if;
  perform public.validate_p3_proposal_payload(target_household,payload_input);
end;
$$;

alter function public.submit_proposal(uuid,jsonb,uuid) rename to submit_p3_proposal;
create function public.submit_proposal(target_household uuid,payload_input jsonb,request_key uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if payload_input->>'type'='settlement' then raise exception '请从代付原单发起报销批次'; end if;
  return public.submit_p3_proposal(target_household,payload_input,request_key);
end;
$$;

create function public.submit_settlement_batch(target_household uuid,payload_input jsonb,request_key uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  existing public.proposals; proposal_uuid uuid; batch_uuid uuid; recipient uuid;
  claim public.reimbursement_claims; item record; item_json jsonb; snapshot public.fx_rate_snapshots;
  original_sum numeric; reserved_sum numeric; paid_sum numeric;
  allocations_json jsonb:='[]'::jsonb; calculated jsonb; total bigint;
  payment_rate numeric; claim_rate numeric; denominator numeric; numerator numeric;
  cny numeric:=10000000000; hkd numeric:=10000000000;
begin
  perform public.require_active_household(target_household);
  -- The household lock is the common serialization point for cash/claim mutations.
  perform 1 from public.households where id=target_household and status='active' for update;
  if not found then raise exception 'household is archived'; end if;
  if request_key is null then raise exception 'idempotency key is required'; end if;
  select * into existing from public.proposals where household_id=target_household and submitter_id=auth.uid() and idempotency_key=request_key;
  if existing.id is not null then
    select id into batch_uuid from public.settlement_batches where proposal_id=existing.id;
    if batch_uuid is null or existing.payload->'request' is distinct from payload_input then raise exception '幂等键已被其他草稿使用'; end if;
    return batch_uuid;
  end if;
  if payload_input is null or jsonb_typeof(payload_input)<>'object' or exists(
    select 1 from jsonb_object_keys(payload_input) as keys(key)
    where key not in ('payeeMemberId','accountKind','currency','occurredAt','title','allocations')
  ) then raise exception 'invalid settlement payload'; end if;
  if jsonb_typeof(payload_input->'payeeMemberId') is distinct from 'string' then raise exception 'payee is required'; end if;
  recipient:=(payload_input->>'payeeMemberId')::uuid;
  if not exists(select 1 from public.household_members where household_id=target_household and user_id=recipient and active) then raise exception '收款人必须为活跃账本成员'; end if;
  if jsonb_typeof(payload_input->'currency') is distinct from 'string' or payload_input->>'currency' not in ('USD','CNY','HKD') then raise exception 'invalid currency'; end if;
  if jsonb_typeof(payload_input->'accountKind') is distinct from 'string' or not exists(select 1 from public.cash_accounts where household_id=target_household and kind=payload_input->>'accountKind') then raise exception 'cash account not found'; end if;
  if jsonb_typeof(payload_input->'title') is distinct from 'string' or coalesce(char_length(trim(payload_input->>'title')),0) not between 1 and 160 then raise exception 'invalid title'; end if;
  if jsonb_typeof(payload_input->'occurredAt') is distinct from 'string' or coalesce(payload_input->>'occurredAt','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid occurrence date'; end if;
  if (payload_input->>'occurredAt')::date>current_date then raise exception 'future entries cannot be posted'; end if;
  if jsonb_typeof(payload_input->'allocations') is distinct from 'array' then raise exception 'allocations are required'; end if;
  if jsonb_array_length(payload_input->'allocations') not between 1 and 100 then raise exception 'select 1 to 100 allocations'; end if;
  for item_json in select value from jsonb_array_elements(payload_input->'allocations') loop
    if jsonb_typeof(item_json)<>'object' or exists(select 1 from jsonb_object_keys(item_json) as keys(key) where key not in ('claimId','amountMinor','expectedVersion')) then raise exception 'invalid allocation fields'; end if;
    if jsonb_typeof(item_json->'claimId') is distinct from 'string' or jsonb_typeof(item_json->'amountMinor') is distinct from 'number' or
      jsonb_typeof(item_json->'expectedVersion') is distinct from 'number' then raise exception 'invalid allocation'; end if;
    perform (item_json->>'claimId')::uuid;
    if (item_json->>'amountMinor')::numeric<>trunc((item_json->>'amountMinor')::numeric) or (item_json->>'amountMinor')::numeric not between 1 and 9999999999 then raise exception 'invalid original amount'; end if;
    if (item_json->>'expectedVersion')::numeric<>trunc((item_json->>'expectedVersion')::numeric) or (item_json->>'expectedVersion')::numeric not between 1 and 9007199254740991 then raise exception 'invalid claim version'; end if;
  end loop;
  -- Lock once, merge repeated claims and validate against posted amounts + every live reservation.
  for item in
    select (value->>'claimId')::uuid as claim_id,sum((value->>'amountMinor')::numeric) as amount,
      min((value->>'expectedVersion')::bigint) as revision,max((value->>'expectedVersion')::bigint) as max_revision
    from jsonb_array_elements(payload_input->'allocations') group by 1 order by 1
  loop
    select * into claim from public.reimbursement_claims where id=item.claim_id and household_id=target_household for update;
    if claim.id is null or claim.claimant_id<>recipient then raise exception '不可报销无来源或其他成员的原单'; end if;
    if claim.status='voided' or not exists(select 1 from public.ledger_entries where id=claim.source_entry_id and status='posted' and entry_type='reimbursement' and payer_member_id=recipient) then raise exception '原单已失效'; end if;
    if claim.version<>item.revision or item.revision<>item.max_revision then raise exception '原单已变更，请刷新后重提'; end if;
    select coalesce(sum(a.amount_minor) filter(where a.status='posted' and e.status='posted'),0),
      coalesce(sum(a.amount_minor) filter(where a.status='reserved'),0)
    into paid_sum,reserved_sum from public.settlement_allocations a left join public.ledger_entries e on e.id=a.settlement_entry_id where a.claim_id=claim.id;
    if item.amount>claim.claimed_minor-paid_sum-reserved_sum then raise exception '原单可报销额度不足，可能已有待审批预留'; end if;
    allocations_json:=allocations_json||jsonb_build_array(jsonb_build_object('claimId',claim.id,'amountMinor',item.amount,'currency',claim.currency,'expectedVersion',claim.version));
  end loop;
  -- Foreign report/payment currencies need an approved snapshot; never use pending/manual legacy rates.
  if exists(select 1 from jsonb_array_elements(allocations_json) a where a->>'currency'<>payload_input->>'currency') or
    payload_input->>'currency'<>(select reporting_currency from public.households where id=target_household) then
    select * into snapshot from public.fx_rate_snapshots where household_id=target_household and status='approved' and effective_at<=now()
      order by effective_at desc,approved_at desc,id desc limit 1;
    if snapshot.id is null then raise exception '跨币种报销需要已确认汇率'; end if;
    cny:=snapshot.usd_to_cny*10000000000; hkd:=snapshot.usd_to_hkd*10000000000;
  end if;
  denominator:=10000000000*cny*hkd;
  payment_rate:=case payload_input->>'currency' when 'USD' then 10000000000 when 'CNY' then cny else hkd end;
  calculated:='[]'::jsonb;
  original_sum:=0;
  for item_json in select value from jsonb_array_elements(allocations_json) loop
    claim_rate:=case item_json->>'currency' when 'USD' then 10000000000 when 'CNY' then cny else hkd end;
    numerator:=(item_json->>'amountMinor')::numeric*payment_rate*div(denominator,claim_rate);
    original_sum:=original_sum+numerator;
    calculated:=calculated||jsonb_build_array(item_json||jsonb_build_object('floor',div(numerator,denominator),'remainder',mod(numerator,denominator)));
  end loop;
  total:=div(2*original_sum+denominator,2*denominator)::bigint;
  if total not between 1 and 9999999999 then raise exception '折算打款总额不足一分或超出限额'; end if;
  select jsonb_agg(value-'floor'-'remainder'||jsonb_build_object('paymentMinor',
    (value->>'floor')::numeric+case when rank<=(total-floors) then 1 else 0 end) order by value->>'claimId') into allocations_json
  from (select value,row_number() over(order by (value->>'remainder')::numeric desc,value->>'claimId') as rank,
    sum((value->>'floor')::numeric) over() as floors from jsonb_array_elements(calculated)) ranked;
  if exists(select 1 from jsonb_array_elements(allocations_json) a where (a->>'paymentMinor')::bigint<1) then raise exception '单笔折算打款不足一分，不能核销该原单'; end if;
  insert into public.proposals(household_id,submitter_id,idempotency_key,fx_snapshot_id,payload)
  values(target_household,auth.uid(),request_key,snapshot.id,jsonb_build_object('type','settlement','amountMinor',total,'currency',payload_input->>'currency',
    'accountKind',payload_input->>'accountKind','occurredAt',payload_input->>'occurredAt','title',trim(payload_input->>'title'),'payeeMemberId',recipient,'allocations',allocations_json,'request',payload_input)) returning id into proposal_uuid;
  insert into public.settlement_batches(household_id,proposal_id,claimant_id,account_kind,currency,amount_minor,fx_snapshot_id)
  values(target_household,proposal_uuid,recipient,payload_input->>'accountKind',payload_input->>'currency',total,snapshot.id) returning id into batch_uuid;
  insert into public.settlement_allocations(household_id,batch_id,claim_id,amount_minor,payment_minor,claim_version,status)
  select target_household,batch_uuid,(a->>'claimId')::uuid,(a->>'amountMinor')::bigint,(a->>'paymentMinor')::bigint,(a->>'expectedVersion')::bigint,'reserved'
  from jsonb_array_elements(allocations_json) a;
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail)
  values(target_household,auth.uid(),'reserve','settlement_batch',batch_uuid,jsonb_build_object('proposalId',proposal_uuid,'allocations',allocations_json));
  return batch_uuid;
end;
$$;

alter function public.decide_proposal(uuid,boolean,text) rename to decide_p3_proposal;
create function public.decide_proposal(proposal_uuid uuid,approve boolean,note text default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.proposals; batch public.settlement_batches; claim public.reimbursement_claims; allocation record;
  result_uuid uuid; next_sequence bigint; paid numeric; reserved numeric;
begin
  -- Same lock order as submitting and withdrawing: household, proposal, claims.
  select * into p from public.proposals where id=proposal_uuid;
  if p.id is null or not public.is_household_member(p.household_id) then raise exception 'not authorized'; end if;
  perform 1 from public.households where id=p.household_id for update;
  select * into p from public.proposals where id=proposal_uuid for update;
  if p.payload->>'type'<>'settlement' then return public.decide_p3_proposal(proposal_uuid,approve,note); end if;
  if p.submitter_id=auth.uid() then raise exception 'submitter cannot decide own proposal'; end if;
  if approve is null then raise exception 'decision is required'; end if;
  if note is not null and char_length(note)>500 then raise exception 'decision note is too long'; end if;
  select * into batch from public.settlement_batches where proposal_id=p.id for update;
  if batch.id is null then raise exception '旧报销缺少原单，请撤回后重新关联原单'; end if;
  if p.status='approved' and approve then return batch.ledger_entry_id; end if;
  if p.status='rejected' and not approve then return null; end if;
  if p.status not in ('pending_approval','overdue_pending') or batch.status<>'reserved' then raise exception 'proposal is not reviewable'; end if;
  if not approve then
    update public.settlement_allocations set status='released' where batch_id=batch.id and status='reserved';
    update public.settlement_batches set status='released' where id=batch.id;
    update public.proposals set status='rejected',decided_at=now(),decided_by=auth.uid(),decision_note=note where id=p.id;
    insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail) values(p.household_id,auth.uid(),'reject','settlement_batch',batch.id,jsonb_build_object('note',note));
    return null;
  end if;
  perform public.require_active_household(p.household_id);
  if (p.payload->>'occurredAt')::date>current_date then raise exception 'future entries cannot be posted'; end if;
  if not exists(select 1 from public.household_members where household_id=p.household_id and user_id=batch.claimant_id and active) then raise exception 'payee is no longer active'; end if;
  if not exists(select 1 from public.settlement_allocations where batch_id=batch.id and status='reserved') or
    batch.amount_minor<>(select sum(payment_minor) from public.settlement_allocations where batch_id=batch.id and status='reserved') then raise exception '批次核销明细不完整'; end if;
  for allocation in select * from public.settlement_allocations where batch_id=batch.id order by claim_id loop
    select * into claim from public.reimbursement_claims where id=allocation.claim_id and household_id=p.household_id for update;
    if claim.id is null or claim.status='voided' or claim.claimant_id<>batch.claimant_id or claim.version<>allocation.claim_version or allocation.status<>'reserved' then raise exception '原单已变更，请撤回后重提'; end if;
    if not exists(select 1 from public.ledger_entries where id=claim.source_entry_id and status='posted' and entry_type='reimbursement' and payer_member_id=batch.claimant_id) then raise exception '原单来源已失效'; end if;
    select coalesce(sum(a.amount_minor) filter(where a.status='posted' and e.status='posted'),0),coalesce(sum(a.amount_minor) filter(where a.status='reserved'),0)
    into paid,reserved from public.settlement_allocations a left join public.ledger_entries e on e.id=a.settlement_entry_id where a.claim_id=claim.id;
    if paid+reserved>claim.claimed_minor then raise exception '原单额度不足，请撤回后重提'; end if;
  end loop;
  select greatest(coalesce((select max(effective_sequence) from public.ledger_entries where household_id=p.household_id),0),coalesce((select max(effective_sequence) from public.cash_transfers where household_id=p.household_id),0))+1 into next_sequence;
  insert into public.ledger_entries(household_id,proposal_id,entry_type,amount_minor,currency,occurred_at,effective_sequence,title,member_id,payee_member_id,account_kind,fx_snapshot_id)
  values(p.household_id,p.id,'settlement',batch.amount_minor,batch.currency,(p.payload->>'occurredAt')::date,next_sequence,p.payload->>'title',p.submitter_id,batch.claimant_id,batch.account_kind,batch.fx_snapshot_id) returning id into result_uuid;
  update public.settlement_allocations set status='posted',settlement_entry_id=result_uuid where batch_id=batch.id;
  update public.settlement_batches set status='posted',ledger_entry_id=result_uuid where id=batch.id;
  update public.reimbursement_claims c set status=case when c.claimed_minor=(select sum(a.amount_minor) from public.settlement_allocations a join public.ledger_entries e on e.id=a.settlement_entry_id where a.claim_id=c.id and a.status='posted' and e.status='posted') then 'settled' else 'partially_settled' end
  where c.id in (select claim_id from public.settlement_allocations where batch_id=batch.id);
  update public.proposals set status='approved',decided_at=now(),decided_by=auth.uid(),decision_note=note where id=p.id;
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail) values(p.household_id,auth.uid(),'approve','settlement_batch',batch.id,jsonb_build_object('ledgerEntryId',result_uuid));
  return result_uuid;
end;
$$;

create function public.withdraw_proposal(proposal_uuid uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.proposals; batch_uuid uuid;
begin
  select * into p from public.proposals where id=proposal_uuid;
  if p.id is null or not public.is_household_member(p.household_id) or p.submitter_id<>auth.uid() then raise exception 'only submitter can withdraw'; end if;
  perform 1 from public.households where id=p.household_id for update;
  select * into p from public.proposals where id=proposal_uuid for update;
  if p.status='withdrawn' then return; end if;
  if p.status not in ('pending_approval','overdue_pending') then raise exception 'proposal cannot be withdrawn'; end if;
  select id into batch_uuid from public.settlement_batches where proposal_id=p.id for update;
  if batch_uuid is not null then
    update public.settlement_allocations set status='released' where batch_id=batch_uuid and status='reserved';
    update public.settlement_batches set status='released' where id=batch_uuid;
  end if;
  update public.proposals set status='withdrawn',decided_at=now(),decided_by=auth.uid() where id=p.id;
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id) values(p.household_id,auth.uid(),'withdraw','proposal',p.id);
end;
$$;

-- Guard direct or outdated internal settlement writes as well as the public RPC.
create function public.require_settlement_batch_entry() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if new.entry_type='settlement' and not exists(select 1 from public.settlement_batches b where b.proposal_id=new.proposal_id and b.household_id=new.household_id and b.status='reserved' and b.amount_minor=new.amount_minor and b.currency=new.currency and b.claimant_id=new.payee_member_id and b.account_kind=new.account_kind) then raise exception 'settlement entry requires a reserved claim-linked batch'; end if;
  return new;
end;
$$;
create trigger require_batch_before_settlement_entry before insert on public.ledger_entries for each row execute function public.require_settlement_batch_entry();
create trigger bump_version_on_settlement_batch after insert or update or delete on public.settlement_batches for each row execute function public.bump_household_ledger_version();
alter publication supabase_realtime add table public.settlement_batches,public.settlement_allocations;

revoke all on function public.submit_p3_proposal(uuid,jsonb,uuid),public.validate_p3_proposal_payload(uuid,jsonb),public.validate_proposal_payload(uuid,jsonb),public.decide_p3_proposal(uuid,boolean,text),public.decide_p2_account_proposal(uuid,boolean,text),public.require_settlement_batch_entry() from public,authenticated;
revoke all on function public.submit_settlement_batch(uuid,jsonb,uuid),public.decide_proposal(uuid,boolean,text),public.withdraw_proposal(uuid) from public;
revoke all on function public.submit_proposal(uuid,jsonb,uuid) from public;
grant execute on function public.submit_proposal(uuid,jsonb,uuid),public.submit_settlement_batch(uuid,jsonb,uuid),public.decide_proposal(uuid,boolean,text),public.withdraw_proposal(uuid) to authenticated;
