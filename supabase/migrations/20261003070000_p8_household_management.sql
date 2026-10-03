create table public.household_archives (
 id uuid primary key default gen_random_uuid(), household_id uuid not null references public.households(id),
 proposal_id uuid not null unique references public.proposals(id), archived_at timestamptz not null default now(),
 archived_by uuid not null references public.profiles(id), snapshot jsonb not null
);
alter table public.household_archives enable row level security;
create policy archives_read on public.household_archives for select using(public.is_household_member(household_id));
alter table public.households add column archive_snapshot_id uuid references public.household_archives(id);

create function public.household_migration_issues(h uuid) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'type',e.entry_type,'title',e.title,'currency',e.currency,'amountMinor',e.amount_minor,'reason',
 case when e.entry_type='deposit' then '存入记录缺实际出资成员' when e.entry_type='reimbursement' then '代付缺实际垫付成员或原单'
 when e.entry_type='settlement' then '历史报销缺核销批次和原单分配' else '历史退款缺关联消费原单' end)),'[]'::jsonb)
 from public.ledger_entries e where e.household_id=h and e.status='posted' and (
 (e.entry_type='deposit' and e.payer_member_id is null) or
 (e.entry_type='reimbursement' and (e.payer_member_id is null or not exists(select 1 from public.reimbursement_claims c where c.source_entry_id=e.id))) or
 (e.entry_type='settlement' and not exists(select 1 from public.settlement_batches b where b.ledger_entry_id=e.id and b.status='posted')) or
 (e.entry_type='expense_refund' and e.refund_source_entry_id is null));
$$;

-- Frozen authoritative rows are consumed by the same domain calculators as a live ledger.
create function public.capture_household_snapshot(h uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare data jsonb; item record; rows jsonb; configuration jsonb;
begin
 select to_jsonb(hh) into configuration from public.households hh where id=h;
 data:=jsonb_build_object('configuration',configuration,'capturedAt',now(),'currentFxId',(select id from public.fx_rate_snapshots where household_id=h and status='approved' and effective_at<=now() order by effective_at desc,approved_at desc,id desc limit 1));
 for item in select * from (values
 ('entries','ledger_entries'),('proposals','proposals'),('investments','investments'),('valuations','investment_valuations'),
 ('accounts','cash_accounts'),('transfers','cash_transfers'),('fxSnapshots','fx_rate_snapshots_exact'),('spendingCategories','spending_categories'),
 ('spendingProjects','spending_projects'),('reimbursementClaims','reimbursement_claims'),('settlementAllocations','settlement_allocations'),
 ('settlementBatches','settlement_batches'),('voidRequests','void_requests')) as tables(key,name) loop
   if item.name='proposals' then
     select coalesce(jsonb_agg(to_jsonb(p) order by submitted_at desc,id),'[]'::jsonb) into rows from public.proposals p where household_id=h and payload->>'type' not in ('household_archive','household_restore');
   elsif item.name='fx_rate_snapshots_exact' then
     select coalesce(jsonb_agg(to_jsonb(f)),'[]'::jsonb) into rows from public.fx_rate_snapshots_exact f where household_id=h and status='approved';
   else
     execute format('select coalesce(jsonb_agg(to_jsonb(t)),''[]''::jsonb) from public.%I t where household_id=$1',item.name) into rows using h;
   end if;
   data:=data||jsonb_build_object(item.key,rows);
 end loop;
 select coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('profiles',jsonb_build_object('display_name',p.display_name)) order by m.user_id),'[]'::jsonb)
 into rows from public.household_members m join public.profiles p on p.id=m.user_id where m.household_id=h and m.active;
 return data||jsonb_build_object('members',rows);
end;$$;

create function public.household_management_plan_internal(h uuid,excluded_proposal uuid default null) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare hh public.households; snapshot jsonb; pending_count int; reservation_count int; issues jsonb; blockers jsonb:='[]';
begin
 select * into hh from public.households where id=h;
 if hh.status='archived' and hh.archive_snapshot_id is not null then select a.snapshot into snapshot from public.household_archives a where a.id=hh.archive_snapshot_id and a.household_id=h;
 else snapshot:=public.capture_household_snapshot(h); end if;
 select count(*) into pending_count from public.proposals where household_id=h and status in ('pending_approval','overdue_pending') and (excluded_proposal is null or id<>excluded_proposal);
 select (select count(*) from public.settlement_allocations where household_id=h and status='reserved')+(select count(*) from public.proposals where household_id=h and status in ('pending_approval','overdue_pending') and payload->>'type'='member_return') into reservation_count;
 issues:=public.household_migration_issues(h);
 if exists(select 1 from public.proposals where household_id=h and status in ('pending_approval','overdue_pending') and payload->>'type' in ('household_archive','household_restore') and (excluded_proposal is null or id<>excluded_proposal)) then blockers:=blockers||jsonb_build_array('已有归档或恢复申请待审批');end if;
 if (select count(*) from public.household_members where household_id=h and active)<>2 then blockers:=blockers||jsonb_build_array('需要两位活跃成员');end if;
 if hh.status='active' and not hh.time_zone_confirmed then blockers:=blockers||jsonb_build_array('请先在账本设置确认账本时区');end if;
 if hh.status='active' then
  if pending_count>0 then blockers:=blockers||jsonb_build_array(format('还有 %s 笔待审批事项',pending_count));end if;
  if reservation_count>0 then blockers:=blockers||jsonb_build_array(format('还有 %s 项有效预留',reservation_count));end if;
  if jsonb_array_length(issues)>0 then blockers:=blockers||jsonb_build_array(format('还有 %s 项历史数据待核对',jsonb_array_length(issues)));end if;
 end if;
 return jsonb_build_object('status',hh.status,'version',hh.ledger_version,'snapshot',snapshot,'blockers',blockers,'migrationIssues',issues,'pendingCount',pending_count,'reservationCount',reservation_count,'archivedAt',hh.archived_at);
end;$$;

create function public.get_household_management_plan(target_household uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$begin
 if not public.is_household_member(target_household) then raise exception 'not authorized';end if;
 perform 1 from public.households where id=target_household for update;
 return public.household_management_plan_internal(target_household);
end;$$;

create function public.submit_household_management(target_household uuid,action_input text,reason_input text,expected_version bigint,request_key uuid) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare hh public.households; previous public.proposals; plan jsonb; result uuid; kind text;
begin
 if not public.is_household_member(target_household) then raise exception 'not authorized';end if;
 select * into hh from public.households where id=target_household for update;
 if action_input is null or action_input not in ('archive','restore') or request_key is null or coalesce(char_length(trim(reason_input)),0) not between 1 and 500 then raise exception 'invalid management request';end if;
 kind:='household_'||action_input;
 select * into previous from public.proposals where household_id=target_household and submitter_id=auth.uid() and idempotency_key=request_key;
 if previous.id is not null then
  if previous.payload->>'type'<>kind or previous.payload->>'reason'<>trim(reason_input) or (previous.payload->>'requestedVersion')::bigint is distinct from expected_version then raise exception '幂等键已用于不同内容';end if;
  return previous.id;
 end if;
 if (action_input='archive' and hh.status<>'active') or (action_input='restore' and hh.status<>'archived') then raise exception '账本状态已变化，请刷新';end if;
 if expected_version is distinct from hh.ledger_version then raise exception '账本版本已变化，请重新核对';end if;
 if exists(select 1 from public.proposals where household_id=hh.id and status in ('pending_approval','overdue_pending') and payload->>'type' in ('household_archive','household_restore')) then raise exception '已有归档或恢复申请待审批';end if;
 plan:=public.household_management_plan_internal(hh.id);
 if jsonb_array_length(plan->'blockers')>0 then raise exception '%',plan->'blockers';end if;
 insert into public.proposals(household_id,submitter_id,idempotency_key,payload) values(hh.id,auth.uid(),request_key,jsonb_build_object(
 'type',kind,'title',case when action_input='archive' then '归档共同账本' else '恢复共同账本' end,'reason',trim(reason_input),
 'amountMinor',0,'currency',hh.reporting_currency,'occurredAt',(now() at time zone hh.time_zone)::date,'requestedVersion',expected_version,'basisVersion',hh.ledger_version+1,'reviewSnapshot',plan->'snapshot')) returning id into result;
 insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail) values(hh.id,auth.uid(),'submit','proposal',result,jsonb_build_object('type',kind));
 return result;
end;$$;

alter function public.decide_proposal(uuid,boolean,text) rename to decide_before_household_management;
create function public.decide_proposal(proposal_uuid uuid,approve boolean,note text default null) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.proposals; hh public.households; plan jsonb; result uuid; fx uuid;
begin
 select * into p from public.proposals where id=proposal_uuid;
 if p.id is null or not public.is_household_member(p.household_id) then raise exception 'not authorized';end if;
 select * into hh from public.households where id=p.household_id for update;
 if p.payload->>'type' not in ('household_archive','household_restore') then
  perform public.require_active_household(p.household_id);
  return public.decide_before_household_management(proposal_uuid,approve,note);
 end if;
 select * into p from public.proposals where id=proposal_uuid for update;
 if p.submitter_id=auth.uid() then raise exception 'submitter cannot decide own proposal';end if;
 if approve is null or (note is not null and char_length(note)>500) then raise exception 'invalid decision';end if;
 if p.status='approved' and approve then
  select id into result from public.household_archives where proposal_id=p.id;
  return coalesce(result,hh.id);
 end if;
 if p.status='rejected' and not approve then return null;end if;
 if p.status not in ('pending_approval','overdue_pending') then raise exception 'proposal is not reviewable';end if;
 if not approve then
  update public.proposals set status='rejected',decided_at=now(),decided_by=auth.uid(),decision_note=note where id=p.id;
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id) values(hh.id,auth.uid(),'reject','proposal',p.id);
  return null;
 end if;
 if (p.payload->>'type'='household_archive' and hh.status<>'active') or (p.payload->>'type'='household_restore' and hh.status<>'archived') then raise exception '账本状态已变化，请刷新';end if;
 if hh.ledger_version<>(p.payload->>'basisVersion')::bigint then raise exception '账本版本已变化，请撤回后重新核对并申请';end if;
 plan:=public.household_management_plan_internal(hh.id,p.id);
 if jsonb_array_length(plan->'blockers')>0 then raise exception '%',plan->'blockers';end if;
 if p.payload->>'type'='household_archive' then
  select id into fx from public.fx_rate_snapshots where household_id=hh.id and status='approved' and effective_at<=now() order by effective_at desc,approved_at desc,id desc limit 1;
  if fx::text is distinct from p.payload->'reviewSnapshot'->>'currentFxId' then raise exception '汇率生效时点已变化，请重新核对并申请';end if;
  insert into public.household_archives(household_id,proposal_id,archived_by,snapshot) values(hh.id,p.id,auth.uid(),p.payload->'reviewSnapshot') returning id into result;
  update public.households set status='archived',archived_at=now(),archived_by=auth.uid(),archive_reason=p.payload->>'reason',archive_snapshot_id=result,ledger_version=ledger_version+1 where id=hh.id;
  update public.invitations set status='revoked',revoked_at=now() where household_id=hh.id and status='pending';
 else
  update public.households set status='active',archived_at=null,archived_by=null,archive_reason=null,archive_snapshot_id=null,ledger_version=ledger_version+1 where id=hh.id;
  result:=hh.id;
 end if;
 update public.proposals set status='approved',decided_at=now(),decided_by=auth.uid(),decision_note=note where id=p.id;
 insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail) values(hh.id,auth.uid(),case when p.payload->>'type'='household_archive' then 'archive' else 'restore' end,'household',hh.id,jsonb_build_object('proposalId',p.id,'snapshotId',case when p.payload->>'type'='household_archive' then result else null end));
 return result;
end;$$;

alter function public.withdraw_proposal(uuid) rename to withdraw_before_household_management;
create function public.withdraw_proposal(proposal_uuid uuid) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.proposals;begin
 select * into p from public.proposals where id=proposal_uuid;
 if p.id is null or not public.is_household_member(p.household_id) then raise exception 'not authorized';end if;
 perform 1 from public.households where id=p.household_id for update;
 if p.payload->>'type' not in ('household_archive','household_restore') then perform public.require_active_household(p.household_id);end if;
 perform public.withdraw_before_household_management(proposal_uuid);
end;$$;

create or replace function public.archive_household(target_household uuid,reason text) returns void language plpgsql security definer set search_path=pg_catalog,public as $$begin raise exception '请通过双人归档申请操作';end;$$;
revoke all on function public.archive_household(uuid,text),public.capture_household_snapshot(uuid),public.household_migration_issues(uuid),public.household_management_plan_internal(uuid,uuid),public.decide_before_household_management(uuid,boolean,text),public.withdraw_before_household_management(uuid) from public,anon,authenticated;
revoke all on function public.get_household_management_plan(uuid),public.submit_household_management(uuid,text,text,bigint,uuid),public.decide_proposal(uuid,boolean,text),public.withdraw_proposal(uuid) from public,anon,authenticated;
grant execute on function public.get_household_management_plan(uuid),public.submit_household_management(uuid,text,text,bigint,uuid),public.decide_proposal(uuid,boolean,text),public.withdraw_proposal(uuid) to authenticated;
alter publication supabase_realtime add table public.household_archives;
