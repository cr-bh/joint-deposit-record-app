-- P2 PR-03: explicit bank/brokerage cash accounts and atomic same-currency transfers.
create table public.cash_accounts (
  household_id uuid not null references public.households(id) on delete cascade,
  kind text not null check (kind in ('bank','brokerage')),
  name text not null check (char_length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  primary key (household_id, kind)
);

insert into public.cash_accounts(household_id,kind,name)
select id, kind, case kind when 'bank' then '共同银行' else '共同券商' end
from public.households cross join (values ('bank'),('brokerage')) as kinds(kind)
on conflict (household_id,kind) do nothing;

alter table public.ledger_entries add column account_kind text;
update public.ledger_entries
set account_kind=case
  when entry_type in ('investment_buy','investment_sell','dividend') then 'brokerage'
  when entry_type='reimbursement' then null
  else 'bank'
end
where account_kind is null;
alter table public.ledger_entries add constraint ledger_entries_account_kind_check
  check (
    (entry_type='reimbursement' and account_kind is null) or
    (entry_type<>'reimbursement' and account_kind in ('bank','brokerage'))
  ) not valid;
alter table public.ledger_entries add constraint ledger_entries_account_household_fk
  foreign key (household_id,account_kind) references public.cash_accounts(household_id,kind) not valid;

create table public.cash_transfers (
  id uuid primary key default extensions.gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  proposal_id uuid not null unique references public.proposals(id),
  source_account_kind text not null,
  destination_account_kind text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency in ('USD','CNY','HKD')),
  occurred_at date not null,
  effective_sequence bigint not null,
  title text not null check (char_length(trim(title)) between 1 and 160),
  status public.entry_status not null default 'posted',
  created_at timestamptz not null default now(),
  check (source_account_kind <> destination_account_kind),
  foreign key (household_id,source_account_kind) references public.cash_accounts(household_id,kind),
  foreign key (household_id,destination_account_kind) references public.cash_accounts(household_id,kind),
  unique (household_id,effective_sequence)
);
create index cash_transfers_household_date_idx on public.cash_transfers(household_id,occurred_at desc,effective_sequence desc);

alter table public.cash_accounts enable row level security;
alter table public.cash_transfers enable row level security;
create policy cash_accounts_read on public.cash_accounts for select using (public.is_household_member(household_id));
create policy cash_transfers_read on public.cash_transfers for select using (public.is_household_member(household_id));
grant select on public.cash_accounts,public.cash_transfers to authenticated;

create or replace function public.create_household(household_name text, reporting_currency_input text default 'USD')
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare household_uuid uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if reporting_currency_input not in ('USD','CNY','HKD') then raise exception 'invalid currency'; end if;
  if coalesce(char_length(trim(household_name)),0) not between 1 and 80 then raise exception 'invalid household name'; end if;
  insert into public.households(name,reporting_currency,created_by)
  values(trim(household_name),reporting_currency_input,auth.uid()) returning id into household_uuid;
  insert into public.household_members(household_id,user_id,role) values(household_uuid,auth.uid(),'owner');
  insert into public.cash_accounts(household_id,kind,name)
  values(household_uuid,'bank','共同银行'),(household_uuid,'brokerage','共同券商');
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id)
  values(household_uuid,auth.uid(),'create','household',household_uuid);
  return household_uuid;
end;
$$;

alter function public.validate_proposal_payload(uuid,jsonb) rename to validate_p1_proposal_payload;

create function public.validate_proposal_payload(target_household uuid, payload_input jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  payload_type text := payload_input->>'type';
  amount bigint;
  source_kind text;
  destination_kind text;
begin
  if payload_input is null or jsonb_typeof(payload_input)<>'object' then raise exception 'invalid payload'; end if;
  if payload_type='account_transfer' then
    if exists(
      select 1 from jsonb_object_keys(payload_input) as payload_key(key)
      where key not in ('type','amountMinor','currency','occurredAt','title','sourceAccountKind','destinationAccountKind')
    ) then raise exception 'unexpected payload field'; end if;
    if jsonb_typeof(payload_input->'amountMinor') is distinct from 'number' then raise exception 'amount is required'; end if;
    amount := (payload_input->>'amountMinor')::bigint;
    if amount<=0 or amount>9999999999 then raise exception 'invalid amount'; end if;
    if jsonb_typeof(payload_input->'currency') is distinct from 'string' or payload_input->>'currency' not in ('USD','CNY','HKD') then raise exception 'invalid currency'; end if;
    if jsonb_typeof(payload_input->'occurredAt') is distinct from 'string' or coalesce(payload_input->>'occurredAt','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid occurrence date'; end if;
    perform (payload_input->>'occurredAt')::date;
    if jsonb_typeof(payload_input->'title') is distinct from 'string' or coalesce(char_length(trim(payload_input->>'title')),0) not between 1 and 160 then raise exception 'invalid title'; end if;
    if jsonb_typeof(payload_input->'sourceAccountKind') is distinct from 'string' or jsonb_typeof(payload_input->'destinationAccountKind') is distinct from 'string' then raise exception 'transfer accounts are required'; end if;
    source_kind := payload_input->>'sourceAccountKind';
    destination_kind := payload_input->>'destinationAccountKind';
    if source_kind not in ('bank','brokerage') or destination_kind not in ('bank','brokerage') or source_kind=destination_kind then raise exception 'invalid transfer accounts'; end if;
    if not exists(select 1 from public.cash_accounts where household_id=target_household and kind=source_kind) or
       not exists(select 1 from public.cash_accounts where household_id=target_household and kind=destination_kind) then raise exception 'cash account not found'; end if;
    return;
  end if;

  if payload_input ? 'accountKind' then
    if payload_type not in ('deposit','expense','expense_refund','settlement') then raise exception 'account is not allowed'; end if;
    if jsonb_typeof(payload_input->'accountKind') is distinct from 'string' or payload_input->>'accountKind' not in ('bank','brokerage') then raise exception 'invalid account'; end if;
    if not exists(select 1 from public.cash_accounts where household_id=target_household and kind=payload_input->>'accountKind') then raise exception 'cash account not found'; end if;
  end if;
  perform public.validate_p1_proposal_payload(target_household,payload_input-'accountKind');
end;
$$;

-- Recreate the submitter after wrapping validation so every session resolves the
-- current validator instead of a previously cached reference to the renamed one.
create or replace function public.submit_proposal(target_household uuid, payload_input jsonb, request_key uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare proposal_uuid uuid;
begin
  if request_key is null then raise exception 'idempotency key is required'; end if;
  perform public.require_active_household(target_household);
  perform public.validate_proposal_payload(target_household,payload_input);

  insert into public.proposals(household_id,submitter_id,payload,idempotency_key)
  values(target_household,auth.uid(),payload_input,request_key)
  on conflict (household_id,submitter_id,idempotency_key) do nothing
  returning id into proposal_uuid;

  if proposal_uuid is null then
    select id into proposal_uuid from public.proposals
    where household_id=target_household and submitter_id=auth.uid() and idempotency_key=request_key;
  else
    insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id)
    values(target_household,auth.uid(),'submit','proposal',proposal_uuid);
  end if;
  return proposal_uuid;
end;
$$;

create or replace function public.decide_proposal(proposal_uuid uuid, approve boolean, note text default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  p public.proposals;
  inv public.investments;
  entry_uuid uuid;
  payload_type text;
  amount bigint;
  quantity bigint;
  reference_price_1e4 bigint;
  valuation_1e4 bigint;
  next_sequence bigint;
  target_account_kind text;
begin
  select * into p from public.proposals where id=proposal_uuid for update;
  if p.id is null or not public.is_household_member(p.household_id) then raise exception 'not authorized'; end if;
  if p.submitter_id=auth.uid() then raise exception 'submitter cannot decide own proposal'; end if;
  if approve is null then raise exception 'decision is required'; end if;
  if p.status='approved' and approve then
    select id into entry_uuid from public.ledger_entries where proposal_id=p.id;
    if entry_uuid is null then select id into entry_uuid from public.investment_valuations where proposal_id=p.id; end if;
    if entry_uuid is null then select id into entry_uuid from public.cash_transfers where proposal_id=p.id; end if;
    return entry_uuid;
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
  payload_type := p.payload->>'type';

  if payload_type in ('investment_buy','investment_sell','dividend','investment_valuation') then
    select * into inv from public.investments
    where id=(p.payload->>'investmentId')::uuid and household_id=p.household_id and archived_at is null for update;
    if inv.id is null then raise exception 'investment not found'; end if;
    if inv.currency<>p.payload->>'currency' then raise exception 'investment currency mismatch'; end if;
  end if;

  if payload_type='account_transfer' then
    select greatest(
      coalesce((select max(effective_sequence) from public.ledger_entries where household_id=p.household_id),0),
      coalesce((select max(effective_sequence) from public.cash_transfers where household_id=p.household_id),0)
    )+1 into next_sequence;
    insert into public.cash_transfers(household_id,proposal_id,source_account_kind,destination_account_kind,amount_minor,currency,occurred_at,effective_sequence,title)
    values(p.household_id,p.id,p.payload->>'sourceAccountKind',p.payload->>'destinationAccountKind',(p.payload->>'amountMinor')::bigint,p.payload->>'currency',(p.payload->>'occurredAt')::date,next_sequence,p.payload->>'title')
    returning id into entry_uuid;
  elsif payload_type='investment_valuation' then
    valuation_1e4 := coalesce(nullif(p.payload->>'unitValueTenThousandths','')::bigint,nullif(p.payload->>'unitValueMinor','')::bigint*100);
    insert into public.investment_valuations(household_id,investment_id,proposal_id,value_date,unit_value_minor,unit_value_1e4,currency,note,created_by)
    values(p.household_id,inv.id,p.id,(p.payload->>'occurredAt')::date,round(valuation_1e4::numeric/100)::bigint,valuation_1e4,p.payload->>'currency',p.payload->>'title',p.submitter_id)
    returning id into entry_uuid;
  else
    amount := (p.payload->>'amountMinor')::bigint;
    if payload_type in ('investment_buy','investment_sell') then
      quantity := (p.payload->>'quantityMilli')::bigint;
      reference_price_1e4 := coalesce(nullif(p.payload->>'unitPriceTenThousandths','')::bigint,nullif(p.payload->>'unitPriceMinor','')::bigint*100);
      if payload_type='investment_sell' and quantity>public.current_investment_quantity(inv.id) then raise exception 'sell quantity exceeds confirmed holding'; end if;
    end if;
    select greatest(
      coalesce((select max(effective_sequence) from public.ledger_entries where household_id=p.household_id),0),
      coalesce((select max(effective_sequence) from public.cash_transfers where household_id=p.household_id),0)
    )+1 into next_sequence;
    target_account_kind := case
      when payload_type in ('investment_buy','investment_sell','dividend') then 'brokerage'
      when payload_type='reimbursement' then null
      else coalesce(p.payload->>'accountKind','bank')
    end;
    insert into public.ledger_entries(
      household_id,proposal_id,entry_type,amount_minor,currency,occurred_at,effective_sequence,title,category,
      member_id,payer_member_id,payee_member_id,investment_id,quantity_milli,unit_price_minor,unit_price_1e4,account_kind
    ) values (
      p.household_id,p.id,payload_type,amount,p.payload->>'currency',(p.payload->>'occurredAt')::date,next_sequence,p.payload->>'title',p.payload->>'category',
      p.submitter_id,nullif(p.payload->>'payerMemberId','')::uuid,nullif(p.payload->>'payeeMemberId','')::uuid,
      nullif(p.payload->>'investmentId','')::uuid,nullif(p.payload->>'quantityMilli','')::bigint,
      case when reference_price_1e4 is null then null else round(reference_price_1e4::numeric/100)::bigint end,reference_price_1e4,target_account_kind
    ) returning id into entry_uuid;
  end if;

  update public.proposals set status='approved',decided_at=now(),decided_by=auth.uid(),decision_note=note where id=p.id;
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id)
  values(p.household_id,auth.uid(),'approve','proposal',p.id);
  return entry_uuid;
end;
$$;

drop trigger if exists bump_version_on_cash_account on public.cash_accounts;
create trigger bump_version_on_cash_account after insert or update or delete on public.cash_accounts
for each row execute function public.bump_household_ledger_version();
drop trigger if exists bump_version_on_cash_transfer on public.cash_transfers;
create trigger bump_version_on_cash_transfer after insert or update or delete on public.cash_transfers
for each row execute function public.bump_household_ledger_version();

alter publication supabase_realtime add table public.cash_accounts,public.cash_transfers;
revoke all on function public.validate_p1_proposal_payload(uuid,jsonb) from public;
revoke all on function public.validate_proposal_payload(uuid,jsonb) from public;
revoke all on function public.submit_proposal(uuid,jsonb,uuid) from public;
revoke all on function public.decide_proposal(uuid,boolean,text) from public;
grant execute on function public.submit_proposal(uuid,jsonb,uuid) to authenticated;
grant execute on function public.decide_proposal(uuid,boolean,text) to authenticated;
