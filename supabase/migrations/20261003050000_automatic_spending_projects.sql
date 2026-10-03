-- Resolve names within the submission transaction. Invalid proposals leave no orphan project.
alter function public.submit_proposal(uuid,jsonb,uuid) rename to submit_p7_proposal;
create function public.submit_proposal(target_household uuid,payload_input jsonb,request_key uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  project public.spending_projects;
  previous public.proposals;
  project_uuid uuid;
  name_input text;
  canonical jsonb := payload_input;
begin
  if payload_input->>'type' in ('expense','reimbursement') and payload_input ? 'project' and not payload_input ? 'projectId' then
    perform 1 from public.households where id=target_household for update;
    perform public.require_active_household(target_household);
    if jsonb_typeof(payload_input->'project') <> 'string' then raise exception 'invalid project name'; end if;
    name_input := regexp_replace(trim(payload_input->>'project'),'\s+',' ','g');
    if char_length(name_input) not between 1 and 60 then raise exception 'invalid project name'; end if;
    select * into previous from public.proposals where household_id=target_household and submitter_id=auth.uid() and idempotency_key=request_key;
    if previous.id is not null then
      if public.normalize_spending_dimension_name(previous.payload->>'project') is distinct from public.normalize_spending_dimension_name(name_input) then
        raise exception '幂等键已用于不同内容';
      end if;
      canonical := payload_input || jsonb_build_object('projectId',previous.payload->>'projectId','project',previous.payload->>'project');
      if previous.payload is distinct from canonical then raise exception '幂等键已用于不同内容'; end if;
      return previous.id;
    else
      select * into project from public.spending_projects where household_id=target_household and normalized_name=public.normalize_spending_dimension_name(name_input);
      if project.id is not null and project.archived_at is not null then raise exception '该事项已归档，请在账本设置中恢复后使用'; end if;
      if project.id is null then
        project_uuid := public.create_spending_project(target_household,name_input);
        select * into project from public.spending_projects where id=project_uuid;
      end if;
      canonical := payload_input || jsonb_build_object('projectId',project.id,'project',project.name);
    end if;
  end if;
  return public.submit_p7_proposal(target_household,canonical,request_key);
end;
$$;
revoke all on function public.submit_p7_proposal(uuid,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.submit_proposal(uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.submit_proposal(uuid,jsonb,uuid) to authenticated;
