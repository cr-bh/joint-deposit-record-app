-- P2 PR-04: approved USD-base rate snapshots and actual two-sided currency exchange.
create table public.fx_rate_snapshots (
  id uuid primary key default extensions.gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  proposal_id uuid not null unique references public.proposals(id),
  usd_to_cny numeric(20,10) not null check (usd_to_cny > 0),
  usd_to_hkd numeric(20,10) not null check (usd_to_hkd > 0),
  effective_at timestamptz not null,
  source_note text not null check (char_length(trim(source_note)) between 1 and 240),
  status public.proposal_status not null default 'approved' check (status = 'approved'),
  created_by uuid not null references public.profiles(id),
  approved_by uuid not null references public.profiles(id),
  approved_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index fx_rate_snapshots_current_idx on public.fx_rate_snapshots(household_id,effective_at desc,approved_at desc,id desc);

alter table public.fx_rates add column snapshot_id uuid references public.fx_rate_snapshots(id);
alter table public.fx_rates add column approved_by uuid references public.profiles(id);
alter table public.fx_rates add column approved_at timestamptz;
alter table public.fx_rates add column source_note text;
create unique index fx_rates_snapshot_pair_idx on public.fx_rates(snapshot_id,base_currency,quote_currency) where snapshot_id is not null;

alter table public.ledger_entries add column fx_snapshot_id uuid references public.fx_rate_snapshots(id);
alter table public.proposals add column fx_snapshot_id uuid references public.fx_rate_snapshots(id);

alter table public.cash_transfers drop constraint if exists cash_transfers_check;
alter table public.cash_transfers add column movement_type text not null default 'same_currency';
alter table public.cash_transfers add column destination_amount_minor bigint;
alter table public.cash_transfers add column destination_currency text;
alter table public.cash_transfers add column fx_snapshot_id uuid references public.fx_rate_snapshots(id);
update public.cash_transfers
set destination_amount_minor=amount_minor,destination_currency=currency
where destination_amount_minor is null or destination_currency is null;
alter table public.cash_transfers alter column destination_amount_minor set not null;
alter table public.cash_transfers alter column destination_currency set not null;
alter table public.cash_transfers add constraint cash_transfers_destination_amount_check check (destination_amount_minor > 0);
alter table public.cash_transfers add constraint cash_transfers_destination_currency_check check (destination_currency in ('USD','CNY','HKD'));
alter table public.cash_transfers add constraint cash_transfers_movement_check check (
  (movement_type='same_currency' and source_account_kind<>destination_account_kind and currency=destination_currency and amount_minor=destination_amount_minor and fx_snapshot_id is null) or
  (movement_type='currency_exchange' and currency<>destination_currency and fx_snapshot_id is not null)
);

alter table public.fx_rate_snapshots enable row level security;
create policy fx_rate_snapshots_read on public.fx_rate_snapshots for select using (public.is_household_member(household_id));
grant select on public.fx_rate_snapshots to authenticated;

alter function public.validate_proposal_payload(uuid,jsonb) rename to validate_p2_account_proposal_payload;

create function public.validate_proposal_payload(target_household uuid, payload_input jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  payload_type text := payload_input->>'type';
  source_kind text;
  destination_kind text;
  source_currency text;
  destination_currency_value text;
  source_amount bigint;
  destination_amount bigint;
  cny_rate numeric(20,10);
  hkd_rate numeric(20,10);
begin
  if payload_input is null or jsonb_typeof(payload_input)<>'object' then raise exception 'invalid payload'; end if;

  if payload_type='fx_rate_update' then
    if exists(
      select 1 from jsonb_object_keys(payload_input) as payload_key(key)
      where key not in ('type','amountMinor','currency','occurredAt','title','effectiveAt','usdToCny','usdToHkd','sourceNote')
    ) then raise exception 'unexpected payload field'; end if;
    if payload_input->>'currency'<>'USD' or jsonb_typeof(payload_input->'currency') is distinct from 'string' then raise exception 'rate base must be USD'; end if;
    if jsonb_typeof(payload_input->'amountMinor') is distinct from 'number' or (payload_input->>'amountMinor')::bigint<>0 then raise exception 'rate amount must be zero'; end if;
    if jsonb_typeof(payload_input->'occurredAt') is distinct from 'string' or coalesce(payload_input->>'occurredAt','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid occurrence date'; end if;
    perform (payload_input->>'occurredAt')::date;
    if jsonb_typeof(payload_input->'title') is distinct from 'string' or coalesce(char_length(trim(payload_input->>'title')),0) not between 1 and 160 then raise exception 'invalid title'; end if;
    if jsonb_typeof(payload_input->'effectiveAt') is distinct from 'string' then raise exception 'effective time is required'; end if;
    perform (payload_input->>'effectiveAt')::timestamptz;
    if jsonb_typeof(payload_input->'usdToCny') is distinct from 'string' or payload_input->>'usdToCny' !~ '^(0|[1-9][0-9]{0,8})([.][0-9]{1,10})?$' then raise exception 'invalid CNY rate'; end if;
    if jsonb_typeof(payload_input->'usdToHkd') is distinct from 'string' or payload_input->>'usdToHkd' !~ '^(0|[1-9][0-9]{0,8})([.][0-9]{1,10})?$' then raise exception 'invalid HKD rate'; end if;
    cny_rate := (payload_input->>'usdToCny')::numeric(20,10);
    hkd_rate := (payload_input->>'usdToHkd')::numeric(20,10);
    if cny_rate<=0 or hkd_rate<=0 then raise exception 'rates must be positive'; end if;
    if jsonb_typeof(payload_input->'sourceNote') is distinct from 'string' or coalesce(char_length(trim(payload_input->>'sourceNote')),0) not between 1 and 240 then raise exception 'rate source is required'; end if;
    return;
  end if;

  if payload_type='currency_exchange' then
    if exists(
      select 1 from jsonb_object_keys(payload_input) as payload_key(key)
      where key not in ('type','amountMinor','currency','occurredAt','title','sourceAccountKind','destinationAccountKind','destinationAmountMinor','destinationCurrency')
    ) then raise exception 'unexpected payload field'; end if;
    if jsonb_typeof(payload_input->'amountMinor') is distinct from 'number' or jsonb_typeof(payload_input->'destinationAmountMinor') is distinct from 'number' then raise exception 'exchange amounts are required'; end if;
    source_amount := (payload_input->>'amountMinor')::bigint;
    destination_amount := (payload_input->>'destinationAmountMinor')::bigint;
    if source_amount<=0 or source_amount>9999999999 or destination_amount<=0 or destination_amount>9999999999 then raise exception 'invalid exchange amounts'; end if;
    source_currency := payload_input->>'currency';
    destination_currency_value := payload_input->>'destinationCurrency';
    if jsonb_typeof(payload_input->'currency') is distinct from 'string' or jsonb_typeof(payload_input->'destinationCurrency') is distinct from 'string' or
       source_currency not in ('USD','CNY','HKD') or destination_currency_value not in ('USD','CNY','HKD') or source_currency=destination_currency_value then raise exception 'invalid exchange currencies'; end if;
    source_kind := payload_input->>'sourceAccountKind';
    destination_kind := payload_input->>'destinationAccountKind';
    if jsonb_typeof(payload_input->'sourceAccountKind') is distinct from 'string' or jsonb_typeof(payload_input->'destinationAccountKind') is distinct from 'string' or
       source_kind not in ('bank','brokerage') or destination_kind not in ('bank','brokerage') then raise exception 'invalid exchange accounts'; end if;
    if not exists(select 1 from public.cash_accounts where household_id=target_household and kind=source_kind) or
       not exists(select 1 from public.cash_accounts where household_id=target_household and kind=destination_kind) then raise exception 'cash account not found'; end if;
    if jsonb_typeof(payload_input->'occurredAt') is distinct from 'string' or coalesce(payload_input->>'occurredAt','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid occurrence date'; end if;
    perform (payload_input->>'occurredAt')::date;
    if jsonb_typeof(payload_input->'title') is distinct from 'string' or coalesce(char_length(trim(payload_input->>'title')),0) not between 1 and 160 then raise exception 'invalid title'; end if;
    return;
  end if;

  perform public.validate_p2_account_proposal_payload(target_household,payload_input);
end;
$$;

create or replace function public.submit_proposal(target_household uuid, payload_input jsonb, request_key uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  proposal_uuid uuid;
  snapshot_uuid uuid;
  report_currency text;
begin
  if request_key is null then raise exception 'idempotency key is required'; end if;
  perform public.require_active_household(target_household);
  perform public.validate_proposal_payload(target_household,payload_input);
  select reporting_currency into report_currency from public.households where id=target_household;
  if payload_input->>'type'<>'fx_rate_update' and (payload_input->>'type'='currency_exchange' or payload_input->>'currency'<>report_currency) then
    select id into snapshot_uuid from public.fx_rate_snapshots
    where household_id=target_household and status='approved' and effective_at<=now()
    order by effective_at desc,approved_at desc,id desc limit 1;
    if snapshot_uuid is null then raise exception 'approved exchange rate snapshot is required'; end if;
  end if;
  insert into public.proposals(household_id,submitter_id,payload,idempotency_key,fx_snapshot_id)
  values(target_household,auth.uid(),payload_input,request_key,snapshot_uuid)
  on conflict (household_id,submitter_id,idempotency_key) do nothing
  returning id into proposal_uuid;
  if proposal_uuid is null then
    select id into proposal_uuid from public.proposals where household_id=target_household and submitter_id=auth.uid() and idempotency_key=request_key;
  else
    insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id) values(target_household,auth.uid(),'submit','proposal',proposal_uuid);
  end if;
  return proposal_uuid;
end;
$$;

alter function public.decide_proposal(uuid,boolean,text) rename to decide_p2_account_proposal;

create function public.decide_proposal(proposal_uuid uuid, approve boolean, note text default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  p public.proposals;
  payload_type text;
  result_uuid uuid;
  snapshot_uuid uuid;
  next_sequence bigint;
begin
  select payload->>'type' into payload_type from public.proposals where id=proposal_uuid;
  if payload_type not in ('fx_rate_update','currency_exchange') then
    return public.decide_p2_account_proposal(proposal_uuid,approve,note);
  end if;

  select * into p from public.proposals where id=proposal_uuid for update;
  if p.id is null or not public.is_household_member(p.household_id) then raise exception 'not authorized'; end if;
  if p.submitter_id=auth.uid() then raise exception 'submitter cannot decide own proposal'; end if;
  if approve is null then raise exception 'decision is required'; end if;
  if p.status='approved' and approve then
    if payload_type='fx_rate_update' then select id into result_uuid from public.fx_rate_snapshots where proposal_id=p.id;
    else select id into result_uuid from public.cash_transfers where proposal_id=p.id; end if;
    return result_uuid;
  end if;
  if p.status='rejected' and not approve then return null; end if;
  if p.status not in ('pending_approval','overdue_pending') then raise exception 'proposal is not reviewable'; end if;
  if not approve then
    update public.proposals set status='rejected',decided_at=now(),decided_by=auth.uid(),decision_note=note where id=p.id;
    insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail)
    values(p.household_id,auth.uid(),'reject','proposal',p.id,jsonb_build_object('note',note));
    return null;
  end if;

  perform 1 from public.households where id=p.household_id and status='active' for update;
  if not found then raise exception 'household is archived'; end if;
  perform public.validate_proposal_payload(p.household_id,p.payload);
  if (p.payload->>'occurredAt')::date>current_date then raise exception 'future entries cannot be posted'; end if;

  if payload_type='fx_rate_update' then
    if (p.payload->>'effectiveAt')::timestamptz>now() then raise exception 'future rates cannot be approved'; end if;
    insert into public.fx_rate_snapshots(household_id,proposal_id,usd_to_cny,usd_to_hkd,effective_at,source_note,created_by,approved_by)
    values(p.household_id,p.id,(p.payload->>'usdToCny')::numeric(20,10),(p.payload->>'usdToHkd')::numeric(20,10),(p.payload->>'effectiveAt')::timestamptz,trim(p.payload->>'sourceNote'),p.submitter_id,auth.uid())
    returning id into result_uuid;
    insert into public.fx_rates(household_id,base_currency,quote_currency,rate,effective_at,created_by,snapshot_id,approved_by,approved_at,source_note)
    values
      (p.household_id,'USD','CNY',(p.payload->>'usdToCny')::numeric(20,10),(p.payload->>'effectiveAt')::timestamptz,p.submitter_id,result_uuid,auth.uid(),now(),trim(p.payload->>'sourceNote')),
      (p.household_id,'USD','HKD',(p.payload->>'usdToHkd')::numeric(20,10),(p.payload->>'effectiveAt')::timestamptz,p.submitter_id,result_uuid,auth.uid(),now(),trim(p.payload->>'sourceNote'));
  else
    snapshot_uuid := p.fx_snapshot_id;
    perform 1 from public.fx_rate_snapshots where id=snapshot_uuid and household_id=p.household_id and status='approved';
    if not found then snapshot_uuid := null; end if;
    if snapshot_uuid is null then raise exception 'approved exchange rate snapshot is required'; end if;
    select greatest(
      coalesce((select max(effective_sequence) from public.ledger_entries where household_id=p.household_id),0),
      coalesce((select max(effective_sequence) from public.cash_transfers where household_id=p.household_id),0)
    )+1 into next_sequence;
    insert into public.cash_transfers(
      household_id,proposal_id,source_account_kind,destination_account_kind,amount_minor,currency,destination_amount_minor,destination_currency,movement_type,fx_snapshot_id,occurred_at,effective_sequence,title
    ) values (
      p.household_id,p.id,p.payload->>'sourceAccountKind',p.payload->>'destinationAccountKind',(p.payload->>'amountMinor')::bigint,p.payload->>'currency',(p.payload->>'destinationAmountMinor')::bigint,p.payload->>'destinationCurrency','currency_exchange',snapshot_uuid,(p.payload->>'occurredAt')::date,next_sequence,p.payload->>'title'
    ) returning id into result_uuid;
  end if;

  update public.proposals set status='approved',decided_at=now(),decided_by=auth.uid(),decision_note=note where id=p.id;
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail)
  values(p.household_id,auth.uid(),'approve',case when payload_type='fx_rate_update' then 'fx_rate_snapshot' else 'cash_transfer' end,result_uuid,jsonb_build_object('proposalId',p.id));
  return result_uuid;
end;
$$;

create function public.assign_entry_fx_snapshot() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  report_currency text;
  snapshot_uuid uuid;
begin
  select reporting_currency into report_currency from public.households where id=new.household_id;
  if new.currency<>report_currency then
    select fx_snapshot_id into snapshot_uuid from public.proposals
    where id=new.proposal_id and household_id=new.household_id;
    perform 1 from public.fx_rate_snapshots where id=snapshot_uuid and household_id=new.household_id and status='approved';
    if not found then snapshot_uuid := null; end if;
    if snapshot_uuid is null then raise exception 'approved exchange rate snapshot is required'; end if;
    new.fx_snapshot_id := snapshot_uuid;
  end if;
  return new;
end;
$$;
create trigger assign_fx_snapshot_before_entry before insert on public.ledger_entries
for each row execute function public.assign_entry_fx_snapshot();

create trigger bump_version_on_fx_snapshot after insert or update or delete on public.fx_rate_snapshots
for each row execute function public.bump_household_ledger_version();

alter publication supabase_realtime add table public.fx_rate_snapshots;
revoke all on function public.validate_p2_account_proposal_payload(uuid,jsonb) from public;
revoke all on function public.validate_proposal_payload(uuid,jsonb) from public;
revoke all on function public.submit_proposal(uuid,jsonb,uuid) from public;
revoke all on function public.decide_p2_account_proposal(uuid,boolean,text) from public;
revoke all on function public.decide_proposal(uuid,boolean,text) from public;
revoke all on function public.assign_entry_fx_snapshot() from public;
grant execute on function public.submit_proposal(uuid,jsonb,uuid) to authenticated;
grant execute on function public.decide_proposal(uuid,boolean,text) to authenticated;
