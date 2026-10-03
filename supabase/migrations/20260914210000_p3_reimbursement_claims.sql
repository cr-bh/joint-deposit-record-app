-- P3 PR-06: every approved member-paid expense atomically becomes one payable claim.
alter table public.reimbursement_claims add column if not exists source_proposal_id uuid references public.proposals(id);
alter table public.reimbursement_claims add column if not exists category_id uuid references public.spending_categories(id);
alter table public.reimbursement_claims add column if not exists category text;
alter table public.reimbursement_claims add column if not exists project_id uuid references public.spending_projects(id);
alter table public.reimbursement_claims add column if not exists project_name text;
create unique index if not exists reimbursement_claims_source_proposal_idx on public.reimbursement_claims(source_proposal_id) where source_proposal_id is not null;

create function public.create_claim_for_reimbursement_entry() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare claim_uuid uuid;
begin
  if new.entry_type<>'reimbursement' or new.status<>'posted' then return new; end if;
  if new.payer_member_id is null then raise exception 'reimbursement payer is required'; end if;
  if not exists(select 1 from public.household_members where household_id=new.household_id and user_id=new.payer_member_id and active) then
    raise exception 'reimbursement payer must be an active household member';
  end if;
  insert into public.reimbursement_claims(
    household_id,source_entry_id,source_proposal_id,claimant_id,currency,claimed_minor,status,
    category_id,category,project_id,project_name,created_at
  ) values (
    new.household_id,new.id,new.proposal_id,new.payer_member_id,new.currency,new.amount_minor,'open',
    new.category_id,new.category,new.project_id,new.project_name,new.created_at
  ) on conflict (source_entry_id) do nothing returning id into claim_uuid;
  if claim_uuid is not null then
    insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail)
    values(new.household_id,auth.uid(),'create','reimbursement_claim',claim_uuid,jsonb_build_object('sourceEntryId',new.id,'claimantId',new.payer_member_id));
  end if;
  return new;
end;
$$;

create trigger create_claim_after_reimbursement_entry after insert on public.ledger_entries
for each row execute function public.create_claim_for_reimbursement_entry();

-- Existing rows with an explicit verified payer can be migrated without guessing from submitter/member_id.
insert into public.reimbursement_claims(
  household_id,source_entry_id,source_proposal_id,claimant_id,currency,claimed_minor,status,
  category_id,category,project_id,project_name,created_at
)
select entry.household_id,entry.id,entry.proposal_id,entry.payer_member_id,entry.currency,entry.amount_minor,
  case when entry.status='voided' then 'voided' else 'open' end,
  entry.category_id,entry.category,entry.project_id,entry.project_name,entry.created_at
from public.ledger_entries entry
where entry.entry_type='reimbursement' and entry.payer_member_id is not null
on conflict (source_entry_id) do nothing;

update public.reimbursement_claims claim
set source_proposal_id=entry.proposal_id,
    category_id=entry.category_id,
    category=entry.category,
    project_id=entry.project_id,
    project_name=entry.project_name
from public.ledger_entries entry
where entry.id=claim.source_entry_id;

grant select on public.reimbursement_claims,public.settlement_allocations to authenticated;
alter publication supabase_realtime add table public.reimbursement_claims;

create trigger bump_version_on_reimbursement_claim after insert or update or delete on public.reimbursement_claims
for each row execute function public.bump_household_ledger_version();
create trigger bump_version_on_settlement_allocation after insert or update or delete on public.settlement_allocations
for each row execute function public.bump_household_ledger_version();

revoke all on function public.create_claim_for_reimbursement_entry() from public;
