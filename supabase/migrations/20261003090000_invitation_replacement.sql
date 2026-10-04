-- Only hashes are stored, so a lost invitation must be replaced, not recovered.
-- Lock in the same order as create/accept/archive; failure rolls back revocation.
create function public.replace_invitation(target_household uuid, invited_email_input text)
returns text language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  normalized text := lower(trim(invited_email_input));
  new_token text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  perform 1 from public.households where id=target_household for update;
  if not public.is_household_owner(target_household) then raise exception 'owner permission required'; end if;

  with revoked as (
    update public.invitations set status='revoked',revoked_at=now()
    where household_id=target_household and lower(email)=normalized and status='pending'
    returning id
  )
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail)
  select target_household,auth.uid(),'revoke','invitation',id,
    jsonb_build_object('reason','replacement','email',normalized) from revoked;

  -- Retains all existing email, active-household and two-member capacity checks.
  new_token := public.create_invitation(target_household,normalized);
  return new_token;
end;$$;
revoke all on function public.replace_invitation(uuid,text) from public,anon,authenticated;
grant execute on function public.replace_invitation(uuid,text) to authenticated;
