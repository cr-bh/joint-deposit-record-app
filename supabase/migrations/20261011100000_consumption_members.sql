-- Consumption beneficiaries are independent of payer/submitter and never allocate money.
-- Existing rows and pending proposals remain unknown (NULL); no historical inference.
alter table public.ledger_entries
  add column consumer_scope text,
  add column consumer_member_id uuid,
  add constraint ledger_consumer_shape check (
    (consumer_scope is null and consumer_member_id is null)
    or (consumer_scope is not null and entry_type in ('expense','reimbursement','expense_refund') and (
      (consumer_scope='common' and consumer_member_id is null)
      or (consumer_scope='member' and consumer_member_id is not null)
    ))
  ),
  add constraint ledger_consumer_membership foreign key(household_id,consumer_member_id)
    references public.household_members(household_id,user_id);

alter function public.validate_proposal_payload(uuid,jsonb) rename to validate_before_consumption_members;
create function public.validate_proposal_payload(target_household uuid,payload_input jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if payload_input ? 'consumerScope' or payload_input ? 'consumerMemberId' then
    if payload_input->>'type' not in ('expense','reimbursement') then
      raise exception 'consumer is only allowed for consumption';
    end if;
    if jsonb_typeof(payload_input->'consumerScope') is distinct from 'string'
       or payload_input->>'consumerScope' not in ('common','member') then
      raise exception 'invalid consumer scope';
    end if;
    if payload_input->>'consumerScope'='common' then
      if payload_input ? 'consumerMemberId' then raise exception 'shared consumption cannot name a member'; end if;
    else
      if jsonb_typeof(payload_input->'consumerMemberId') is distinct from 'string' then
        raise exception 'consumer member is required';
      end if;
      if not exists(select 1 from public.household_members where household_id=target_household
        and user_id=(payload_input->>'consumerMemberId')::uuid and active) then
        raise exception 'consumer must be an active household member';
      end if;
    end if;
  end if;
  -- Older validators are strict about keys; retain their full financial/date checks.
  perform public.validate_before_consumption_members(target_household,payload_input-'consumerScope'-'consumerMemberId');
end;$$;

create function public.assign_consumption_members() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare p jsonb;
begin
  if new.entry_type in ('expense','reimbursement') then
    select payload into p from public.proposals where id=new.proposal_id and household_id=new.household_id;
    new.consumer_scope:=p->>'consumerScope';
    new.consumer_member_id:=nullif(p->>'consumerMemberId','')::uuid;
  elsif new.entry_type='expense_refund' then
    select consumer_scope,consumer_member_id into new.consumer_scope,new.consumer_member_id
      from public.ledger_entries where id=new.refund_source_entry_id and household_id=new.household_id;
  end if;
  return new;
end;$$;
create trigger assign_consumption_members before insert on public.ledger_entries
  for each row execute function public.assign_consumption_members();
revoke all on function public.validate_before_consumption_members(uuid,jsonb),
  public.validate_proposal_payload(uuid,jsonb),public.assign_consumption_members() from public,anon,authenticated;

-- A retry must preserve the beneficiary too. Serialize consumption submissions before
-- checking the key so concurrent, different drafts cannot silently reuse one proposal.
alter function public.submit_proposal(uuid,jsonb,uuid) rename to submit_before_consumption_members;
create function public.submit_proposal(target_household uuid,payload_input jsonb,request_key uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare previous public.proposals;canonical jsonb:=payload_input;
begin
  if payload_input->>'type' not in ('expense','reimbursement') then
    return public.submit_before_consumption_members(target_household,payload_input,request_key);
  end if;
  perform public.require_active_household(target_household);
  perform 1 from public.households where id=target_household for update;
  perform public.require_active_household(target_household);
  select * into previous from public.proposals where household_id=target_household
    and submitter_id=auth.uid() and idempotency_key=request_key;
  if previous.id is not null then
    if payload_input ? 'project' and not payload_input ? 'projectId'
       and public.normalize_spending_dimension_name(previous.payload->>'project')
           =public.normalize_spending_dimension_name(payload_input->>'project') then
      canonical:=payload_input||jsonb_build_object('projectId',previous.payload->>'projectId','project',previous.payload->>'project');
    end if;
    if previous.payload is distinct from canonical then raise exception '幂等键已用于不同内容'; end if;
    return previous.id;
  end if;
  return public.submit_before_consumption_members(target_household,payload_input,request_key);
end;$$;
revoke all on function public.submit_before_consumption_members(uuid,jsonb,uuid),
  public.submit_proposal(uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.submit_proposal(uuid,jsonb,uuid) to authenticated;
