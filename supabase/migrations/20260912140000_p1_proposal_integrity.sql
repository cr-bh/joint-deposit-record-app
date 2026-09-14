-- P1 proposal integrity: stable replay order, typed payload validation, and idempotent decisions.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
do $$
begin
  if exists(
    select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace
    where e.extname='pgcrypto' and n.nspname <> 'extensions'
  ) then
    alter extension pgcrypto set schema extensions;
  end if;
end;
$$;

alter table public.households add column if not exists ledger_version bigint not null default 0;
alter table public.ledger_entries add column if not exists effective_sequence bigint;
alter table public.ledger_entries add column if not exists payer_member_id uuid references public.profiles(id);
alter table public.ledger_entries add column if not exists payee_member_id uuid references public.profiles(id);
alter table public.ledger_entries add column if not exists unit_price_1e4 bigint;
alter table public.investment_valuations add column if not exists unit_value_1e4 bigint;
alter table public.investments add column if not exists latest_price_1e4 bigint;

update public.ledger_entries set unit_price_1e4=unit_price_minor*100 where unit_price_1e4 is null and unit_price_minor is not null;
update public.investment_valuations set unit_value_1e4=unit_value_minor*100 where unit_value_1e4 is null;
update public.investments set latest_price_1e4=latest_price_minor*100 where latest_price_1e4 is null and latest_price_minor is not null;
alter table public.investment_valuations alter column unit_value_1e4 set not null;

with ranked as (
  select id, row_number() over (partition by household_id order by occurred_at, created_at, id) as sequence
  from public.ledger_entries
  where effective_sequence is null
)
update public.ledger_entries as entry
set effective_sequence = ranked.sequence
from ranked
where entry.id = ranked.id;

alter table public.ledger_entries alter column effective_sequence set not null;
create unique index if not exists entries_household_sequence_idx on public.ledger_entries(household_id, effective_sequence);
create index if not exists entries_household_replay_idx on public.ledger_entries(household_id, occurred_at, effective_sequence, id);

alter table public.ledger_entries drop constraint if exists ledger_entries_amount_minor_check;
alter table public.ledger_entries add constraint ledger_entries_amount_minor_check
  check ((entry_type = 'investment_sell' and amount_minor >= 0) or (entry_type <> 'investment_sell' and amount_minor > 0));
alter table public.ledger_entries add constraint ledger_entries_trade_quantity_check
  check (entry_type not in ('investment_buy','investment_sell') or (quantity_milli is not null and quantity_milli > 0)) not valid;
alter table public.ledger_entries add constraint ledger_entries_reference_price_check
  check (unit_price_minor is null or unit_price_minor > 0) not valid;
alter table public.ledger_entries add constraint ledger_entries_reference_price_1e4_check
  check (unit_price_1e4 is null or unit_price_1e4 > 0) not valid;
alter table public.investment_valuations add constraint investment_valuations_value_1e4_check
  check (unit_value_1e4 > 0) not valid;
alter table public.investments add constraint investments_latest_price_1e4_check
  check (latest_price_1e4 is null or latest_price_1e4 > 0) not valid;

create or replace function public.shares_active_household(target_user uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(
    select 1
    from public.household_members mine
    join public.household_members peer on peer.household_id = mine.household_id
    where mine.user_id = auth.uid() and mine.active and peer.user_id = target_user and peer.active
  );
$$;
drop policy if exists profile_household_peer_read on public.profiles;
create policy profile_household_peer_read on public.profiles for select using (public.shares_active_household(id));

create or replace function public.validate_proposal_payload(target_household uuid, payload_input jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  payload_type text;
  amount bigint;
  quantity bigint;
  reference_price_1e4 bigint;
  valuation_1e4 bigint;
  investment_uuid uuid;
begin
  if payload_input is null or jsonb_typeof(payload_input) <> 'object' then raise exception 'invalid payload'; end if;
  if exists(
    select 1 from jsonb_object_keys(payload_input) as payload_key(key)
    where key not in ('type','amountMinor','currency','occurredAt','title','category','investmentId','quantityMilli','unitPriceMinor','unitValueMinor','unitPriceTenThousandths','unitValueTenThousandths','payerMemberId','payeeMemberId')
  ) then raise exception 'unexpected payload field'; end if;

  if jsonb_typeof(payload_input->'type') is distinct from 'string' then raise exception 'invalid type'; end if;
  if jsonb_typeof(payload_input->'currency') is distinct from 'string' then raise exception 'invalid currency'; end if;
  if jsonb_typeof(payload_input->'occurredAt') is distinct from 'string' then raise exception 'invalid occurrence date'; end if;
  if jsonb_typeof(payload_input->'title') is distinct from 'string' then raise exception 'invalid title'; end if;
  payload_type := payload_input->>'type';
  if payload_type is null or payload_type not in ('deposit','expense','expense_refund','reimbursement','settlement','investment_buy','investment_sell','dividend','investment_valuation') then raise exception 'invalid type'; end if;
  if payload_input->>'currency' is null or payload_input->>'currency' not in ('USD','CNY','HKD') then raise exception 'invalid currency'; end if;
  if coalesce(length(trim(payload_input->>'title')), 0) not between 1 and 160 then raise exception 'invalid title'; end if;
  if coalesce(payload_input->>'occurredAt','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid occurrence date'; end if;
  perform (payload_input->>'occurredAt')::date;
  if jsonb_typeof(payload_input->'amountMinor') is distinct from 'number' then raise exception 'amount is required'; end if;
  amount := (payload_input->>'amountMinor')::bigint;
  if amount > 9999999999 then raise exception 'amount exceeds limit'; end if;

  if payload_type = 'investment_valuation' then
    if amount <> 0 then raise exception 'valuation amount must be zero'; end if;
  elsif payload_type = 'investment_sell' then
    if amount < 0 then raise exception 'invalid amount'; end if;
  elsif amount <= 0 then
    raise exception 'invalid amount';
  end if;

  if payload_type in ('expense','reimbursement') and (
    jsonb_typeof(payload_input->'category') is distinct from 'string' or coalesce(length(trim(payload_input->>'category')), 0) not between 1 and 60
  ) then raise exception 'category is required'; end if;
  if payload_input ? 'category' and payload_type not in ('expense','expense_refund','reimbursement') then raise exception 'category is not allowed'; end if;
  if payload_type = 'expense_refund' and payload_input ? 'category' and (
    jsonb_typeof(payload_input->'category') is distinct from 'string' or coalesce(length(trim(payload_input->>'category')), 0) not between 1 and 60
  ) then raise exception 'invalid category'; end if;

  if payload_input ? 'investmentId' and payload_type not in ('investment_buy','investment_sell','dividend','investment_valuation') then raise exception 'investment is not allowed'; end if;
  if payload_input ? 'quantityMilli' and payload_type not in ('investment_buy','investment_sell') then raise exception 'quantity is not allowed'; end if;
  if payload_input ? 'unitPriceMinor' and payload_input ? 'unitPriceTenThousandths' then raise exception 'ambiguous reference price'; end if;
  if payload_input ? 'unitValueMinor' and payload_input ? 'unitValueTenThousandths' then raise exception 'ambiguous valuation'; end if;
  if (payload_input ? 'unitPriceMinor' or payload_input ? 'unitPriceTenThousandths') and payload_type not in ('investment_buy','investment_sell') then raise exception 'reference price is not allowed'; end if;
  if (payload_input ? 'unitValueMinor' or payload_input ? 'unitValueTenThousandths') and payload_type <> 'investment_valuation' then raise exception 'valuation is not allowed'; end if;
  if payload_input ? 'payerMemberId' and payload_type not in ('deposit','reimbursement') then raise exception 'payer is not allowed'; end if;
  if payload_input ? 'payeeMemberId' and payload_type <> 'settlement' then raise exception 'payee is not allowed'; end if;

  if payload_type in ('investment_buy','investment_sell','dividend','investment_valuation') then
    if jsonb_typeof(payload_input->'investmentId') is distinct from 'string' or coalesce(payload_input->>'investmentId','') = '' then raise exception 'investment is required'; end if;
    investment_uuid := (payload_input->>'investmentId')::uuid;
    if not exists(select 1 from public.investments where id=investment_uuid and household_id=target_household and archived_at is null) then raise exception 'investment not found'; end if;
  end if;

  if payload_type in ('investment_buy','investment_sell') then
    if jsonb_typeof(payload_input->'quantityMilli') is distinct from 'number' then raise exception 'quantity is required'; end if;
    quantity := (payload_input->>'quantityMilli')::bigint;
    if quantity <= 0 or quantity > 9999999999999 then raise exception 'invalid quantity'; end if;
    if payload_input ? 'unitPriceTenThousandths' then
      if jsonb_typeof(payload_input->'unitPriceTenThousandths') is distinct from 'number' then raise exception 'invalid reference price'; end if;
      reference_price_1e4 := (payload_input->>'unitPriceTenThousandths')::bigint;
      if reference_price_1e4 <= 0 or reference_price_1e4 > 999999999999 then raise exception 'invalid reference price'; end if;
    elsif payload_input ? 'unitPriceMinor' then
      if jsonb_typeof(payload_input->'unitPriceMinor') is distinct from 'number' then raise exception 'invalid legacy reference price'; end if;
      reference_price_1e4 := (payload_input->>'unitPriceMinor')::bigint*100;
      if reference_price_1e4 <= 0 or reference_price_1e4 > 999999999999 then raise exception 'invalid legacy reference price'; end if;
    end if;
  end if;

  if payload_type = 'investment_valuation' then
    if payload_input ? 'unitValueTenThousandths' then
      if jsonb_typeof(payload_input->'unitValueTenThousandths') is distinct from 'number' then raise exception 'invalid valuation'; end if;
      valuation_1e4 := (payload_input->>'unitValueTenThousandths')::bigint;
    elsif payload_input ? 'unitValueMinor' then
      if jsonb_typeof(payload_input->'unitValueMinor') is distinct from 'number' then raise exception 'invalid legacy valuation'; end if;
      valuation_1e4 := (payload_input->>'unitValueMinor')::bigint*100;
    else
      raise exception 'valuation is required';
    end if;
    if valuation_1e4 <= 0 or valuation_1e4 > 999999999999 then raise exception 'invalid valuation'; end if;
  end if;

  if payload_type in ('deposit','reimbursement') and jsonb_typeof(payload_input->'payerMemberId') is distinct from 'string' then
    raise exception 'payer is required';
  end if;

  if payload_input ? 'payerMemberId' and (
    jsonb_typeof(payload_input->'payerMemberId') is distinct from 'string' or not exists(
    select 1 from public.household_members where household_id=target_household and user_id=(payload_input->>'payerMemberId')::uuid and active
  )) then raise exception 'payer is not an active household member'; end if;
  if payload_input ? 'payeeMemberId' and (
    jsonb_typeof(payload_input->'payeeMemberId') is distinct from 'string' or not exists(
    select 1 from public.household_members where household_id=target_household and user_id=(payload_input->>'payeeMemberId')::uuid and active
  )) then raise exception 'payee is not an active household member'; end if;
end;
$$;

create or replace function public.submit_proposal(target_household uuid, payload_input jsonb, request_key uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare proposal_uuid uuid;
begin
  if request_key is null then raise exception 'idempotency key is required'; end if;
  perform public.require_active_household(target_household);
  perform public.validate_proposal_payload(target_household, payload_input);

  insert into public.proposals(household_id, submitter_id, payload, idempotency_key)
  values(target_household, auth.uid(), payload_input, request_key)
  on conflict (household_id, submitter_id, idempotency_key) do nothing
  returning id into proposal_uuid;

  if proposal_uuid is null then
    select id into proposal_uuid from public.proposals
    where household_id=target_household and submitter_id=auth.uid() and idempotency_key=request_key;
  else
    insert into public.audit_logs(household_id, actor_id, action, entity_type, entity_id)
    values(target_household, auth.uid(), 'submit', 'proposal', proposal_uuid);
  end if;
  return proposal_uuid;
end;
$$;

create or replace function public.decide_proposal(proposal_uuid uuid, approve boolean, note text default null) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
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
begin
  select * into p from public.proposals where id=proposal_uuid for update;
  if p.id is null or not public.is_household_member(p.household_id) then raise exception 'not authorized'; end if;
  if p.submitter_id=auth.uid() then raise exception 'submitter cannot decide own proposal'; end if;
  if approve is null then raise exception 'decision is required'; end if;

  if p.status='approved' and approve then
    select id into entry_uuid from public.ledger_entries where proposal_id=p.id;
    if entry_uuid is null then select id into entry_uuid from public.investment_valuations where proposal_id=p.id; end if;
    return entry_uuid;
  end if;
  if p.status='rejected' and not approve then return null; end if;
  if p.status not in ('pending_approval','overdue_pending') then raise exception 'proposal is not reviewable'; end if;

  if not approve then
    update public.proposals set status='rejected', decided_at=now(), decided_by=auth.uid(), decision_note=note where id=p.id;
    insert into public.audit_logs(household_id, actor_id, action, entity_type, entity_id, detail)
    values(p.household_id, auth.uid(), 'reject', 'proposal', p.id, jsonb_build_object('note', note));
    return null;
  end if;

  perform 1 from public.households where id=p.household_id and status='active' for update;
  if not found then raise exception 'household is archived'; end if;
  perform public.validate_proposal_payload(p.household_id, p.payload);
  if (p.payload->>'occurredAt')::date > current_date then raise exception 'future entries cannot be posted'; end if;

  payload_type := p.payload->>'type';
  if payload_type in ('investment_buy','investment_sell','dividend','investment_valuation') then
    select * into inv from public.investments
    where id=(p.payload->>'investmentId')::uuid and household_id=p.household_id and archived_at is null
    for update;
    if inv.id is null then raise exception 'investment not found'; end if;
    if inv.currency <> p.payload->>'currency' then raise exception 'investment currency mismatch'; end if;
  end if;

  if payload_type='investment_valuation' then
    valuation_1e4 := coalesce(
      nullif(p.payload->>'unitValueTenThousandths','')::bigint,
      nullif(p.payload->>'unitValueMinor','')::bigint*100
    );
    insert into public.investment_valuations(household_id,investment_id,proposal_id,value_date,unit_value_minor,unit_value_1e4,currency,note,created_by)
    values(p.household_id,inv.id,p.id,(p.payload->>'occurredAt')::date,round(valuation_1e4::numeric/100)::bigint,valuation_1e4,p.payload->>'currency',p.payload->>'title',p.submitter_id)
    returning id into entry_uuid;
  else
    amount := (p.payload->>'amountMinor')::bigint;
    if payload_type in ('investment_buy','investment_sell') then
      quantity := (p.payload->>'quantityMilli')::bigint;
      reference_price_1e4 := coalesce(
        nullif(p.payload->>'unitPriceTenThousandths','')::bigint,
        nullif(p.payload->>'unitPriceMinor','')::bigint*100
      );
      if payload_type='investment_sell' and quantity > public.current_investment_quantity(inv.id) then raise exception 'sell quantity exceeds confirmed holding'; end if;
    end if;
    select coalesce(max(effective_sequence),0)+1 into next_sequence from public.ledger_entries where household_id=p.household_id;
    insert into public.ledger_entries(
      household_id,proposal_id,entry_type,amount_minor,currency,occurred_at,effective_sequence,title,category,
      member_id,payer_member_id,payee_member_id,investment_id,quantity_milli,unit_price_minor,unit_price_1e4
    ) values (
      p.household_id,p.id,payload_type,amount,p.payload->>'currency',(p.payload->>'occurredAt')::date,next_sequence,p.payload->>'title',p.payload->>'category',
      p.submitter_id,nullif(p.payload->>'payerMemberId','')::uuid,nullif(p.payload->>'payeeMemberId','')::uuid,
      nullif(p.payload->>'investmentId','')::uuid,nullif(p.payload->>'quantityMilli','')::bigint,
      case when reference_price_1e4 is null then null else round(reference_price_1e4::numeric/100)::bigint end,reference_price_1e4
    ) returning id into entry_uuid;
  end if;

  update public.proposals set status='approved', decided_at=now(), decided_by=auth.uid(), decision_note=note where id=p.id;
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id)
  values(p.household_id,auth.uid(),'approve','proposal',p.id);
  return entry_uuid;
end;
$$;

-- Price changes use investment_valuation proposals. Remove the legacy direct-write entry points.
drop function if exists public.set_investment_price_1e4(uuid,date,bigint,text);
drop function if exists public.set_investment_price(uuid,date,bigint,text);

create or replace function public.bump_household_ledger_version() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare target_household uuid;
begin
  if tg_op = 'DELETE' then
    target_household := old.household_id;
  else
    target_household := new.household_id;
  end if;
  update public.households set ledger_version=ledger_version+1 where id=target_household;
  if tg_op = 'UPDATE' and old.household_id <> new.household_id then
    update public.households set ledger_version=ledger_version+1 where id=old.household_id;
  end if;
  if tg_op = 'DELETE' then
    return old;
  else
    return new;
  end if;
end;
$$;

drop trigger if exists bump_version_on_entry on public.ledger_entries;
create trigger bump_version_on_entry after insert or update or delete on public.ledger_entries
for each row execute function public.bump_household_ledger_version();
drop trigger if exists bump_version_on_proposal on public.proposals;
create trigger bump_version_on_proposal after insert or update or delete on public.proposals
for each row execute function public.bump_household_ledger_version();
drop trigger if exists bump_version_on_investment on public.investments;
create trigger bump_version_on_investment after insert or update or delete on public.investments
for each row execute function public.bump_household_ledger_version();
drop trigger if exists bump_version_on_valuation on public.investment_valuations;
create trigger bump_version_on_valuation after insert or update or delete on public.investment_valuations
for each row execute function public.bump_household_ledger_version();
drop trigger if exists bump_version_on_member on public.household_members;
create trigger bump_version_on_member after insert or update or delete on public.household_members
for each row execute function public.bump_household_ledger_version();

-- Serialize invitation capacity checks on the household row. Different invitation
-- rows can otherwise both observe one available seat and create a third member.
create or replace function public.create_invitation(target_household uuid, invited_email_input text) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  token text;
  normalized text := lower(trim(invited_email_input));
  household_status text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select status into household_status from public.households where id=target_household for update;
  if household_status is null or not public.is_household_owner(target_household) then raise exception 'owner permission required'; end if;
  if household_status <> 'active' then raise exception 'household is archived'; end if;
  if (select count(*) from public.household_members where household_id=target_household and active) >= 2 then raise exception 'household already has two active members'; end if;
  if normalized !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid email'; end if;
  if exists(select 1 from public.invitations where household_id=target_household and lower(email)=normalized and status='pending' and expires_at > now()) then raise exception 'an active invitation already exists for this email'; end if;
  token := encode(extensions.gen_random_bytes(32),'hex');
  insert into public.invitations(household_id,email,token_hash,expires_at,invited_by)
  values(target_household,normalized,encode(extensions.digest(token,'sha256'),'hex'),now()+interval '7 days',auth.uid());
  insert into public.audit_logs(household_id,actor_id,action,entity_type,detail)
  values(target_household,auth.uid(),'create','invitation',jsonb_build_object('email',normalized));
  return token;
end;
$$;

create or replace function public.accept_invitation(raw_token text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  inv public.invitations;
  user_email text;
  target_household uuid;
  household_status text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select lower(email) into user_email from auth.users where id=auth.uid();
  select household_id into target_household from public.invitations
  where token_hash=encode(extensions.digest(raw_token,'sha256'),'hex');
  if target_household is null then raise exception 'invitation is invalid or expired'; end if;

  select status into household_status from public.households where id=target_household for update;
  select * into inv from public.invitations
  where token_hash=encode(extensions.digest(raw_token,'sha256'),'hex') for update;
  if inv.id is null or inv.status <> 'pending' or inv.expires_at <= now() then raise exception 'invitation is invalid or expired'; end if;
  if lower(inv.email) <> user_email then raise exception 'invitation email does not match signed-in account'; end if;
  if household_status <> 'active' then raise exception 'household is archived'; end if;
  if exists(select 1 from public.household_members where household_id=target_household and user_id=auth.uid()) then raise exception 'already a member'; end if;
  if (select count(*) from public.household_members where household_id=target_household and active) >= 2 then raise exception 'household already has two active members'; end if;

  insert into public.household_members(household_id,user_id,role) values(target_household,auth.uid(),'member');
  update public.invitations set status='accepted',accepted_at=now(),accepted_by=auth.uid() where id=inv.id;
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id)
  values(target_household,auth.uid(),'accept','invitation',inv.id);
  return target_household;
end;
$$;

revoke all on function public.shares_active_household(uuid) from public;
revoke all on function public.validate_proposal_payload(uuid,jsonb) from public;
revoke all on function public.submit_proposal(uuid,jsonb,uuid) from public;
revoke all on function public.decide_proposal(uuid,boolean,text) from public;
revoke all on function public.bump_household_ledger_version() from public;
revoke all on function public.create_invitation(uuid,text) from public;
revoke all on function public.accept_invitation(text) from public;
grant execute on function public.shares_active_household(uuid) to authenticated;
grant execute on function public.submit_proposal(uuid,jsonb,uuid) to authenticated;
grant execute on function public.decide_proposal(uuid,boolean,text) to authenticated;
grant execute on function public.create_invitation(uuid,text) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
