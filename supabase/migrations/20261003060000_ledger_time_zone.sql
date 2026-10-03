alter table public.households add column time_zone text not null default 'UTC', add column time_zone_confirmed boolean not null default false;

create function public.valid_ledger_time_zone(zone text) returns boolean language sql stable set search_path=pg_catalog,public as $$
 select zone is not null and (zone='UTC' or zone ~ '^[A-Z][A-Za-z_]*/[A-Za-z0-9_+/-]+$') and exists(select 1 from pg_catalog.pg_timezone_names where name=zone);
$$;
alter table public.households add constraint valid_household_zone check(public.valid_ledger_time_zone(time_zone));

-- Every existing date check uses CURRENT_DATE: establish the household zone, not the caller's session zone.
create or replace function public.require_active_household(target_household uuid) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare h public.households;
begin
 if not public.is_household_member(target_household) then raise exception 'not authorized'; end if;
 select * into h from public.households where id=target_household for update;
 if h.status is distinct from 'active' then raise exception 'household is archived'; end if;
 perform pg_catalog.set_config('TimeZone',h.time_zone,true);
end;$$;
-- A SET clause would restore TimeZone when this helper returns. All identifiers above are qualified.
alter function public.require_active_household(uuid) reset all;

create function public.create_household(household_name text,reporting_currency_input text,time_zone_input text) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare result uuid;
begin
 if not public.valid_ledger_time_zone(time_zone_input) then raise exception 'invalid ledger time zone'; end if;
 result:=public.create_household(household_name,reporting_currency_input);
 update public.households set time_zone=time_zone_input,time_zone_confirmed=true where id=result;
 return result;
end;$$;
create function public.set_household_time_zone(target_household uuid,time_zone_input text) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare h public.households;
begin
 perform public.require_active_household(target_household);
 if not public.valid_ledger_time_zone(time_zone_input) then raise exception 'invalid ledger time zone'; end if;
 select * into h from public.households where id=target_household;
 if h.time_zone_confirmed and h.time_zone<>time_zone_input and (exists(select 1 from public.ledger_entries where household_id=h.id) or exists(select 1 from public.cash_transfers where household_id=h.id) or exists(select 1 from public.proposals where household_id=h.id)) then
   raise exception '账本已有记录，已确认时区不能直接修改，请通过历史核对流程处理';
 end if;
 update public.households set time_zone=time_zone_input,time_zone_confirmed=true,ledger_version=ledger_version+1 where id=h.id;
 insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail) values(h.id,auth.uid(),'update','household',h.id,jsonb_build_object('oldTimeZone',h.time_zone,'timeZone',time_zone_input,'historicalDatesUnchanged',true));
end;$$;

alter function public.validate_proposal_payload(uuid,jsonb) rename to validate_before_time_zone;
create function public.validate_proposal_payload(target_household uuid,payload_input jsonb) returns void language plpgsql security definer set search_path=pg_catalog,public as $$begin
 perform public.require_active_household(target_household);
 perform public.validate_before_time_zone(target_household,payload_input);
 if (payload_input->>'occurredAt')::date>current_date then raise exception 'future entries cannot be posted'; end if;
end;$$;
revoke all on function public.validate_before_time_zone(uuid,jsonb),public.valid_ledger_time_zone(text) from public,anon,authenticated;
revoke all on function public.create_household(text,text,text),public.set_household_time_zone(uuid,text) from public,anon,authenticated;
grant execute on function public.create_household(text,text,text),public.set_household_time_zone(uuid,text) to authenticated;

revoke all on function public.validate_proposal_payload(uuid,jsonb) from public,anon,authenticated;
