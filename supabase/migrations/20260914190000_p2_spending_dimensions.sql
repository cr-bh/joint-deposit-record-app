-- P2 PR-05: shared spending categories/projects, immutable entry snapshots, and archive-safe history.
create function public.normalize_spending_dimension_name(raw_name text)
returns text language sql immutable set search_path=pg_catalog as $$
  select lower(regexp_replace(trim(raw_name),'[[:space:]]+',' ','g'));
$$;

create table public.spending_categories (
  id uuid primary key default extensions.gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 30 and name=trim(name)),
  normalized_name text not null,
  is_system boolean not null default false,
  archived_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (household_id,normalized_name),
  check (normalized_name=public.normalize_spending_dimension_name(name))
);

create table public.spending_projects (
  id uuid primary key default extensions.gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60 and name=trim(name)),
  normalized_name text not null,
  archived_at timestamptz,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (household_id,normalized_name),
  check (normalized_name=public.normalize_spending_dimension_name(name))
);

insert into public.spending_categories(household_id,name,normalized_name,is_system,created_by)
select household.id, category.name, public.normalize_spending_dimension_name(category.name), true, household.created_by
from public.households household
cross join unnest(array['日常生活','餐饮','居住','家居','交通','旅行','医疗健康','礼物','订阅服务','宠物','教育','其他','玩乐','日用','购物']) as category(name)
on conflict (household_id,normalized_name) do nothing;

-- Preserve every valid legacy category as a selectable shared category before IDs are introduced.
insert into public.spending_categories(household_id,name,normalized_name,is_system,created_by)
select distinct household.id, legacy.name, public.normalize_spending_dimension_name(legacy.name), false, household.created_by
from public.households household
join (
  select household_id,trim(category) as name from public.ledger_entries where category is not null
  union
  select household_id,trim(payload->>'category') as name from public.proposals where payload ? 'category'
) legacy on legacy.household_id=household.id
where char_length(legacy.name) between 1 and 30
  and public.normalize_spending_dimension_name(legacy.name) not in ('代付','报销','成员代付','报销付款')
on conflict (household_id,normalized_name) do nothing;

create function public.seed_spending_categories() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  insert into public.spending_categories(household_id,name,normalized_name,is_system,created_by)
  select new.id, category.name, public.normalize_spending_dimension_name(category.name), true, new.created_by
  from unnest(array['日常生活','餐饮','居住','家居','交通','旅行','医疗健康','礼物','订阅服务','宠物','教育','其他','玩乐','日用','购物']) as category(name);
  return new;
end;
$$;
create trigger seed_spending_categories_after_household after insert on public.households
for each row execute function public.seed_spending_categories();

alter table public.spending_categories enable row level security;
alter table public.spending_projects enable row level security;
create policy spending_categories_read on public.spending_categories for select using (public.is_household_member(household_id));
create policy spending_projects_read on public.spending_projects for select using (public.is_household_member(household_id));
grant select on public.spending_categories,public.spending_projects to authenticated;

create function public.create_spending_category(target_household uuid, category_name text)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  category_uuid uuid;
  clean_name text := trim(category_name);
  normalized text := public.normalize_spending_dimension_name(category_name);
begin
  perform public.require_active_household(target_household);
  if char_length(clean_name) not between 1 and 30 then raise exception 'invalid category name'; end if;
  if normalized in ('代付','报销','成员代付','报销付款') then raise exception 'event type cannot be a category'; end if;
  insert into public.spending_categories(household_id,name,normalized_name,created_by)
  values(target_household,clean_name,normalized,auth.uid()) returning id into category_uuid;
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail)
  values(target_household,auth.uid(),'create','spending_category',category_uuid,jsonb_build_object('name',clean_name));
  return category_uuid;
exception when unique_violation then raise exception 'category already exists';
end;
$$;

create function public.create_spending_project(target_household uuid, project_name text)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  project_uuid uuid;
  clean_name text := trim(project_name);
  normalized text := public.normalize_spending_dimension_name(project_name);
begin
  perform public.require_active_household(target_household);
  if char_length(clean_name) not between 1 and 60 then raise exception 'invalid project name'; end if;
  insert into public.spending_projects(household_id,name,normalized_name,created_by)
  values(target_household,clean_name,normalized,auth.uid()) returning id into project_uuid;
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail)
  values(target_household,auth.uid(),'create','spending_project',project_uuid,jsonb_build_object('name',clean_name));
  return project_uuid;
exception when unique_violation then raise exception 'project already exists';
end;
$$;

create function public.set_spending_category_archived(category_uuid uuid, archived boolean)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare target_household uuid;
begin
  if archived is null then raise exception 'archived state is required'; end if;
  select household_id into target_household from public.spending_categories where id=category_uuid for update;
  if target_household is null then raise exception 'category not found'; end if;
  perform public.require_active_household(target_household);
  update public.spending_categories set archived_at=case when archived then now() else null end where id=category_uuid;
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id)
  values(target_household,auth.uid(),case when archived then 'archive' else 'restore' end,'spending_category',category_uuid);
end;
$$;

create function public.set_spending_project_archived(project_uuid uuid, archived boolean)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare target_household uuid;
begin
  if archived is null then raise exception 'archived state is required'; end if;
  select household_id into target_household from public.spending_projects where id=project_uuid for update;
  if target_household is null then raise exception 'project not found'; end if;
  perform public.require_active_household(target_household);
  update public.spending_projects set archived_at=case when archived then now() else null end where id=project_uuid;
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id)
  values(target_household,auth.uid(),case when archived then 'archive' else 'restore' end,'spending_project',project_uuid);
end;
$$;

alter table public.ledger_entries add column category_id uuid references public.spending_categories(id);
alter table public.ledger_entries add column project_id uuid references public.spending_projects(id);
alter table public.ledger_entries add column project_name text;
update public.ledger_entries entry
set category_id=category.id
from public.spending_categories category
where category.household_id=entry.household_id
  and category.normalized_name=public.normalize_spending_dimension_name(entry.category)
  and entry.category_id is null;

alter function public.validate_proposal_payload(uuid,jsonb) rename to validate_p2_fx_proposal_payload;
create function public.validate_proposal_payload(target_household uuid, payload_input jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  payload_type text := payload_input->>'type';
  category_uuid uuid;
  project_uuid uuid;
  category_record public.spending_categories;
  project_record public.spending_projects;
begin
  if payload_type in ('expense','reimbursement') and not (payload_input ? 'categoryId') then
    select * into category_record from public.spending_categories
    where household_id=target_household
      and normalized_name=public.normalize_spending_dimension_name(payload_input->>'category')
      and archived_at is null
    for share;
    if category_record.id is null then raise exception 'active category is required'; end if;
  end if;
  if payload_input ? 'categoryId' then
    if payload_type not in ('expense','expense_refund','reimbursement') or jsonb_typeof(payload_input->'categoryId') is distinct from 'string' then raise exception 'category reference is not allowed'; end if;
    category_uuid := (payload_input->>'categoryId')::uuid;
    select * into category_record from public.spending_categories where id=category_uuid and household_id=target_household and archived_at is null for share;
    if category_record.id is null then raise exception 'category not found'; end if;
    if category_record.name is distinct from trim(payload_input->>'category') then raise exception 'category snapshot mismatch'; end if;
  end if;
  if payload_input ? 'projectId' or payload_input ? 'project' then
    if payload_type not in ('expense','expense_refund','reimbursement') or jsonb_typeof(payload_input->'projectId') is distinct from 'string' or jsonb_typeof(payload_input->'project') is distinct from 'string' then raise exception 'project reference is invalid'; end if;
    project_uuid := (payload_input->>'projectId')::uuid;
    select * into project_record from public.spending_projects where id=project_uuid and household_id=target_household and archived_at is null for share;
    if project_record.id is null then raise exception 'project not found'; end if;
    if project_record.name is distinct from trim(payload_input->>'project') then raise exception 'project snapshot mismatch'; end if;
  end if;
  perform public.validate_p2_fx_proposal_payload(target_household,payload_input-'categoryId'-'projectId'-'project');
end;
$$;

create function public.assign_spending_dimensions() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  proposal_payload jsonb;
  category_uuid uuid;
begin
  if new.entry_type in ('expense','expense_refund','reimbursement') then
    select payload into proposal_payload from public.proposals where id=new.proposal_id and household_id=new.household_id;
    new.category_id := nullif(proposal_payload->>'categoryId','')::uuid;
    if new.category_id is null then
      select id into category_uuid from public.spending_categories
      where household_id=new.household_id
        and normalized_name=public.normalize_spending_dimension_name(proposal_payload->>'category')
        and archived_at is null;
      new.category_id := category_uuid;
    end if;
    new.project_id := nullif(proposal_payload->>'projectId','')::uuid;
    new.project_name := nullif(proposal_payload->>'project','');
  end if;
  return new;
end;
$$;
create trigger assign_spending_dimensions_before_entry before insert on public.ledger_entries
for each row execute function public.assign_spending_dimensions();

create trigger bump_version_on_custom_spending_category after insert on public.spending_categories
for each row when (not new.is_system) execute function public.bump_household_ledger_version();
create trigger bump_version_on_changed_spending_category after update or delete on public.spending_categories
for each row execute function public.bump_household_ledger_version();
create trigger bump_version_on_spending_project after insert or update or delete on public.spending_projects
for each row execute function public.bump_household_ledger_version();

alter publication supabase_realtime add table public.spending_categories,public.spending_projects;
revoke all on function public.normalize_spending_dimension_name(text) from public;
revoke all on function public.seed_spending_categories() from public;
revoke all on function public.create_spending_category(uuid,text) from public;
revoke all on function public.create_spending_project(uuid,text) from public;
revoke all on function public.set_spending_category_archived(uuid,boolean) from public;
revoke all on function public.set_spending_project_archived(uuid,boolean) from public;
revoke all on function public.validate_p2_fx_proposal_payload(uuid,jsonb) from public;
revoke all on function public.validate_proposal_payload(uuid,jsonb) from public;
revoke all on function public.assign_spending_dimensions() from public;
grant execute on function public.create_spending_category(uuid,text) to authenticated;
grant execute on function public.create_spending_project(uuid,text) to authenticated;
grant execute on function public.set_spending_category_archived(uuid,boolean) to authenticated;
grant execute on function public.set_spending_project_archived(uuid,boolean) to authenticated;
grant execute on function public.submit_proposal(uuid,jsonb,uuid) to authenticated;
grant execute on function public.decide_proposal(uuid,boolean,text) to authenticated;
