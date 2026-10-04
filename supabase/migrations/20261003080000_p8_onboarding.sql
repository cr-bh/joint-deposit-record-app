-- Stable creation request keys avoid duplicate empty ledgers after a lost response.
create table public.household_creation_requests (
 user_id uuid not null references public.profiles(id), request_key uuid not null,
 household_id uuid not null references public.households(id), request_payload jsonb not null,
 created_at timestamptz not null default now(), primary key(user_id,request_key)
);
alter table public.household_creation_requests enable row level security;
revoke all on public.household_creation_requests from anon,authenticated;
grant select on public.household_creation_requests to authenticated;
create policy creation_request_self_read on public.household_creation_requests for select using(user_id=auth.uid());

create function public.create_household(household_name text,reporting_currency_input text,time_zone_input text,request_key uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare previous public.household_creation_requests; payload jsonb; result uuid;
begin
 if auth.uid() is null then raise exception 'not authenticated';end if;
 if request_key is null then raise exception 'invalid request key';end if;
 perform 1 from public.profiles where id=auth.uid() for update;
 payload:=jsonb_build_object('name',trim(household_name),'currency',reporting_currency_input,'timeZone',time_zone_input);
 select * into previous from public.household_creation_requests r where r.user_id=auth.uid() and r.request_key=create_household.request_key;
 if previous.household_id is not null then
  if previous.request_payload<>payload then raise exception '创建内容已变化，请刷新后重新创建';end if;
  return previous.household_id;
 end if;
 result:=public.create_household(trim(household_name),reporting_currency_input,time_zone_input);
 insert into public.household_creation_requests(user_id,request_key,household_id,request_payload) values(auth.uid(),request_key,result,payload);
 return result;
end;$$;
revoke all on function public.create_household(text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.create_household(text,text,text,uuid) to authenticated;

-- A lost acceptance response is retryable only by the same original recipient.
alter function public.accept_invitation(text) rename to accept_invitation_before_retry;
create function public.accept_invitation(raw_token text) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare target uuid; inv public.invitations;begin
 if auth.uid() is null then raise exception 'not authenticated';end if;
 select household_id into target from public.invitations where token_hash=encode(extensions.digest(raw_token,'sha256'),'hex');
 if target is not null then
  perform 1 from public.households where id=target for update;
  select * into inv from public.invitations where token_hash=encode(extensions.digest(raw_token,'sha256'),'hex') for update;
  if inv.status='accepted' and inv.accepted_by=auth.uid() and public.is_household_member(target) then
   if exists(select 1 from public.households where id=target and status<>'active') then raise exception 'household is archived';end if;
   return target;
  end if;
 end if;
 return public.accept_invitation_before_retry(raw_token);
end;$$;
revoke all on function public.accept_invitation_before_retry(text),public.accept_invitation(text) from public,anon,authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
