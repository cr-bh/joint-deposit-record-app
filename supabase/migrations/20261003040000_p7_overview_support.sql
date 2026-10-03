-- P7 full-chain acceptance exposed a P2 compatibility gap: the original
-- same-currency approval writer predates the mandatory destination fields.
-- Fill only omitted values; existing mismatch/check constraints still reject bad transfers.
create function public.complete_same_currency_transfer() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
  if new.movement_type='same_currency' then
    new.destination_amount_minor := coalesce(new.destination_amount_minor,new.amount_minor);
    new.destination_currency := coalesce(new.destination_currency,new.currency);
  end if;
  return new;
end;
$$;
revoke all on function public.complete_same_currency_transfer() from public,anon,authenticated;
create trigger complete_same_currency_transfer_before_insert
before insert on public.cash_transfers for each row
execute function public.complete_same_currency_transfer();

-- Reporting configuration belongs to the same consistent snapshot as assets.
create function public.bump_reporting_configuration_version() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
  if new.reporting_currency is distinct from old.reporting_currency or new.name is distinct from old.name then
    new.ledger_version := greatest(new.ledger_version,old.ledger_version+1);
  end if;
  return new;
end;
$$;
revoke all on function public.bump_reporting_configuration_version() from public,anon,authenticated;
create trigger bump_reporting_configuration_version_before_update
before update of reporting_currency,name on public.households for each row
execute function public.bump_reporting_configuration_version();
