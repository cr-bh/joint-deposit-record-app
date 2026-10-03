-- P5: exact six-decimal shares, atomic funding, immutable valuation dependencies.
alter table public.ledger_entries add column quantity_micro bigint;
alter table public.ledger_entries add column unit_price_1e8 bigint;
alter table public.ledger_entries add column funding_transfer_id uuid references public.cash_transfers(id);
update public.ledger_entries set quantity_micro=quantity_milli*1000,unit_price_1e8=unit_price_1e4*10000;
alter table public.ledger_entries drop constraint ledger_entries_trade_quantity_check;
alter table public.ledger_entries add constraint ledger_entries_trade_quantity_micro_check check(entry_type not in ('investment_buy','investment_sell') or (quantity_micro is not null and quantity_micro>0)) not valid;
alter table public.investments add column unit_name text not null default '份' check(char_length(trim(unit_name)) between 1 and 20);
alter table public.investments add column note text not null default '' check(char_length(note)<=500);
alter table public.investments add column valuation_cadence text not null default 'weekly' check(valuation_cadence in ('weekly','monthly'));
alter table public.investments add column position_version bigint not null default 0;
alter table public.investment_valuations drop constraint investment_valuations_unit_value_minor_check;
alter table public.investment_valuations drop constraint investment_valuations_value_1e4_check;
alter table public.investment_valuations add constraint valuation_nonnegative check(unit_value_minor>=0 and unit_value_1e4>=0);
alter table public.investment_valuations add column input_mode text not null default 'legacy' check(input_mode in ('legacy','unit_price','total_market'));
alter table public.investment_valuations add column quantity_micro bigint;
alter table public.investment_valuations add column total_value_minor bigint;
alter table public.investment_valuations add column unit_value_1e8 bigint;
alter table public.investment_valuations add column derived_unit_price numeric(40,8);
alter table public.investment_valuations add column basis_through_sequence bigint;
alter table public.investment_valuations add column basis_revision bigint;
alter table public.investment_valuations add column basis_signature text;
alter table public.investment_valuations add column effective_sequence bigint;
update public.investment_valuations set unit_value_1e8=unit_value_1e4*10000;

create function public.next_investment_sequence(h uuid) returns bigint language sql stable security definer set search_path=pg_catalog,public as $$
 select greatest(coalesce((select max(effective_sequence) from public.ledger_entries where household_id=h),0),coalesce((select max(effective_sequence) from public.cash_transfers where household_id=h),0),coalesce((select max(effective_sequence) from public.investment_valuations where household_id=h),0))+1;
$$;
create function public.investment_basis_internal(i uuid,d date,s bigint) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('quantityMicro',v.opening_quantity_milli*1000+coalesce(sum(case when e.entry_type='investment_buy' then e.quantity_micro else -e.quantity_micro end),0),
 'throughSequence',s::text,'revision',v.position_version,
 'signature',v.opening_quantity_milli*1000||':'||v.opening_cost_minor||'|'||coalesce(string_agg(e.id||':'||e.occurred_at||':'||e.effective_sequence||':'||e.entry_type||':'||e.quantity_micro||':'||e.amount_minor,'|' order by e.occurred_at,e.effective_sequence,e.id),''))
 from public.investments v left join public.ledger_entries e on e.investment_id=v.id and e.status='posted' and e.entry_type in ('investment_buy','investment_sell') and (e.occurred_at<d or (e.occurred_at=d and e.effective_sequence<=s)) where v.id=i group by v.id;
$$;
create function public.get_investment_basis(target_investment uuid,value_date_input date) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v public.investments;begin
 select * into v from public.investments where id=target_investment;
 if v.id is null then raise exception 'investment not found';end if;
 perform public.require_active_household(v.household_id);
 if v.archived_at is not null or value_date_input is null or value_date_input>current_date then raise exception 'invalid valuation date';end if;
 return public.investment_basis_internal(v.id,value_date_input,public.next_investment_sequence(v.household_id)-1);
end;$$;
-- All trades, including backdated trades and voids, replay the entire history.
create function public.check_investment_history() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare i uuid; minimum_quantity numeric;maximum_quantity numeric;begin
 i:=case when tg_op='DELETE' then old.investment_id else new.investment_id end;
 if i is not null then
  select min(q),max(q) into minimum_quantity,maximum_quantity from(select v.opening_quantity_milli*1000+sum(case e.entry_type when 'investment_buy' then e.quantity_micro when 'investment_sell' then -e.quantity_micro else 0 end) over(order by e.occurred_at,e.effective_sequence,e.id) q from public.investments v join public.ledger_entries e on e.investment_id=v.id and e.status='posted' where v.id=i) history;
  if minimum_quantity<0 then raise exception '卖出超过历史持仓，回填将使后续持仓为负';end if;
  if maximum_quantity>9007199254740991 then raise exception 'quantity exceeds safe range';end if;
  update public.investments set position_version=position_version+1 where id=i;
 end if;
 return null;
end;$$;
create trigger check_investment_history after insert or update or delete on public.ledger_entries for each row execute function public.check_investment_history();

alter function public.validate_proposal_payload(uuid,jsonb) rename to validate_p4_proposal_payload;
create function public.validate_proposal_payload(target_household uuid,payload_input jsonb) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare t text:=payload_input->>'type';v public.investments;q numeric;f jsonb;b jsonb;n numeric;k text;begin
 if t not in ('investment_buy','investment_sell','dividend','investment_valuation') or t is null then perform public.validate_p4_proposal_payload(target_household,payload_input);return;end if;
 if jsonb_typeof(payload_input)<>'object' then raise exception 'invalid payload';end if;
 if exists(select 1 from jsonb_object_keys(payload_input) key where key not in ('type','currency','occurredAt','title','amountMinor','investmentId','quantityMilli','quantityMicro','unitPriceTenThousandths','unitPriceHundredMillionths','unitPriceMinor','unitValueTenThousandths','unitValueMinor','valuationMode','totalValueMinor','unitValueHundredMillionths','basis','funding','linkedTransferId')) then raise exception 'unexpected payload field';end if;
 if jsonb_typeof(payload_input->'title') is distinct from 'string' or coalesce(char_length(trim(payload_input->>'title')),0) not between 1 and 160 then raise exception 'invalid title';end if;
 if jsonb_typeof(payload_input->'occurredAt') is distinct from 'string' or coalesce(payload_input->>'occurredAt','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid date';end if;
 if (payload_input->>'occurredAt')::date>current_date then raise exception 'future entries cannot be posted';end if;
 select * into v from public.investments iv where iv.id=(payload_input->>'investmentId')::uuid and household_id=target_household and archived_at is null;
 if v.id is null then raise exception 'investment not found';end if;
 if payload_input->>'currency' is distinct from v.currency then raise exception 'investment currency mismatch';end if;
 if jsonb_typeof(payload_input->'amountMinor') is distinct from 'number' then raise exception 'invalid amount';end if;
 n:=(payload_input->>'amountMinor')::numeric;
 if n<>trunc(n) or n<0 or n>9999999999 or (t in ('investment_buy','dividend') and n=0) or (t='investment_valuation' and n<>0) then raise exception 'invalid amount';end if;
 if t in ('investment_buy','investment_sell') then
  if (payload_input?'quantityMicro')=(payload_input?'quantityMilli') then raise exception 'exactly one quantity is required';end if;
  k:=case when payload_input?'quantityMicro' then 'quantityMicro' else 'quantityMilli' end;
  if jsonb_typeof(payload_input->k) is distinct from 'number' then raise exception 'invalid quantity';end if;
  q:=(payload_input->>k)::numeric;
  if q<>trunc(q) or q<=0 or q>9999999999999 then raise exception 'invalid quantity';end if;
  if k='quantityMilli' and q*1000>9007199254740991 then raise exception 'quantity exceeds safe range';end if;
  if (case when payload_input?'unitPriceHundredMillionths' then 1 else 0 end)+(case when payload_input?'unitPriceTenThousandths' then 1 else 0 end)+(case when payload_input?'unitPriceMinor' then 1 else 0 end)>1 then raise exception 'ambiguous reference price';end if;
 else
  if payload_input?'quantityMicro' or payload_input?'quantityMilli' or payload_input?'unitPriceHundredMillionths' or payload_input?'unitPriceTenThousandths' or payload_input?'unitPriceMinor' then raise exception 'trade fields not allowed';end if;
 end if;
 foreach k in array array['unitPriceHundredMillionths','unitPriceTenThousandths','unitPriceMinor','unitValueHundredMillionths','unitValueTenThousandths','unitValueMinor','totalValueMinor'] loop
  if payload_input?k then
   if jsonb_typeof(payload_input->k) is distinct from 'number' then raise exception 'invalid price';end if;
   n:=(payload_input->>k)::numeric;
   if n<>trunc(n) or n<0 or n>9999999999999 or (k='totalValueMinor' and n>9999999999) or (k like 'unitPrice%' and n=0) then raise exception 'invalid price';end if;
  end if;
 end loop;
 if t='investment_valuation' then
  if payload_input?'valuationMode' then
   if payload_input->>'valuationMode' not in ('unit_price','total_market') then raise exception 'invalid valuation mode';end if;
   if payload_input?'unitValueMinor' or payload_input?'unitValueTenThousandths' then raise exception 'ambiguous valuation';end if;
   if (payload_input->>'valuationMode'='total_market' and (not payload_input?'totalValueMinor' or payload_input?'unitValueHundredMillionths')) or (payload_input->>'valuationMode'='unit_price' and (not payload_input?'unitValueHundredMillionths' or payload_input?'totalValueMinor')) then raise exception 'valuation value is required';end if;
   b:=payload_input->'basis';
   if jsonb_typeof(b) is distinct from 'object' or exists(select 1 from jsonb_object_keys(b) key where key not in ('quantityMicro','throughSequence','revision','signature')) or jsonb_typeof(b->'quantityMicro') is distinct from 'number' or (b->>'quantityMicro')::numeric<>trunc((b->>'quantityMicro')::numeric) or (b->>'quantityMicro')::numeric<=0 or coalesce(b->>'throughSequence','')!~ '^\d+$' or coalesce(b->>'revision','')!~ '^\d+$' or jsonb_typeof(b->'signature') is distinct from 'string' then raise exception 'confirmed valuation basis required';end if;
  else
   -- Pending P1-P4 unit-price proposals remain reviewable after upgrade.
   if (payload_input?'unitValueMinor')=(payload_input?'unitValueTenThousandths') or payload_input?'basis' or payload_input?'totalValueMinor' or payload_input?'unitValueHundredMillionths' then raise exception 'invalid legacy valuation';end if;
  end if;
 else
  if payload_input?'basis' or payload_input?'valuationMode' or payload_input?'totalValueMinor' or payload_input?'unitValueHundredMillionths' or payload_input?'unitValueTenThousandths' or payload_input?'unitValueMinor' then raise exception 'valuation fields not allowed';end if;
 end if;
 if payload_input?'funding' then
  f:=payload_input->'funding';
  if t<>'investment_buy' or payload_input?'linkedTransferId' or jsonb_typeof(f) is distinct from 'object' or exists(select 1 from jsonb_object_keys(f) key where key not in ('currency','amountMinor','destinationAmountMinor','occurredAt')) then raise exception 'invalid funding';end if;
  if coalesce(f->>'currency','') not in ('USD','CNY','HKD') or coalesce(f->>'occurredAt','')!~'^\d{4}-\d{2}-\d{2}$' or (f->>'occurredAt')::date>(payload_input->>'occurredAt')::date then raise exception '转入日期不能晚于买入日期';end if;
  foreach k in array array['amountMinor','destinationAmountMinor'] loop
   if jsonb_typeof(f->k) is distinct from 'number' then raise exception 'invalid funding amount';end if;
   n:=(f->>k)::numeric;
   if n<>trunc(n) or n<=0 or n>9999999999 then raise exception 'invalid funding amount';end if;
  end loop;
  if f->>'currency'=v.currency and f->>'amountMinor'<>f->>'destinationAmountMinor' then raise exception '同币种转入和到账金额必须相同';end if;
 end if;
 if payload_input?'linkedTransferId' and (t<>'investment_buy' or not exists(select 1 from public.cash_transfers where id=(payload_input->>'linkedTransferId')::uuid and household_id=target_household and status='posted' and destination_account_kind='brokerage' and destination_currency=v.currency and occurred_at<=(payload_input->>'occurredAt')::date)) then raise exception 'invalid existing funding transfer';end if;
end;$$;

alter function public.submit_proposal(uuid,jsonb,uuid) rename to submit_p4_proposal;
create function public.submit_proposal(target_household uuid,payload_input jsonb,request_key uuid) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare submitted_id uuid;previous public.proposals;fx uuid;b jsonb;v public.investments;begin
 if payload_input->>'type' not in ('investment_buy','investment_sell','dividend','investment_valuation') then return public.submit_p4_proposal(target_household,payload_input,request_key);end if;
 perform public.require_active_household(target_household);
 if request_key is null then raise exception 'idempotency key required';end if;
 select * into previous from public.proposals where household_id=target_household and submitter_id=auth.uid() and idempotency_key=request_key;
 if previous.id is not null then if previous.payload<>payload_input then raise exception '幂等键已用于不同内容';end if;return previous.id;end if;
 perform 1 from public.households hh where hh.id=target_household for update;
 perform public.require_active_household(target_household);
 if payload_input->>'type'='investment_valuation' and not payload_input?'valuationMode' then raise exception '新估值必须确认持仓基准，请更新估值表单';end if;
 perform public.validate_proposal_payload(target_household,payload_input);
 select * into v from public.investments iv where iv.id=(payload_input->>'investmentId')::uuid for update;
 if payload_input?'basis' then
  b:=public.investment_basis_internal(v.id,(payload_input->>'occurredAt')::date,(payload_input->'basis'->>'throughSequence')::bigint);
  if b<>payload_input->'basis' or (payload_input->'basis'->>'throughSequence')::bigint>=public.next_investment_sequence(target_household) then raise exception '估值基准已变化，请重新确认持仓';end if;
 end if;
 if payload_input->>'currency'<>(select reporting_currency from public.households where id=target_household) or (payload_input?'funding' and payload_input->'funding'->>'currency'<>v.currency) then
  select s.id into fx from public.fx_rate_snapshots s where household_id=target_household and status='approved' and effective_at<=now() order by effective_at desc,approved_at desc,id desc limit 1;
  if fx is null then raise exception 'approved exchange rate snapshot is required';end if;
 end if;
 insert into public.proposals(household_id,submitter_id,payload,idempotency_key,fx_snapshot_id) values(target_household,auth.uid(),payload_input,request_key,fx) on conflict(household_id,submitter_id,idempotency_key) do nothing returning proposals.id into submitted_id;
 if submitted_id is null then
  select * into previous from public.proposals where household_id=target_household and submitter_id=auth.uid() and idempotency_key=request_key;
  if previous.payload<>payload_input then raise exception '幂等键已用于不同内容';end if;return previous.id;
 end if;
 insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id) values(target_household,auth.uid(),'submit','proposal',submitted_id);return submitted_id;
end;$$;

alter function public.decide_proposal(uuid,boolean,text) rename to decide_p4_proposal;
create function public.decide_proposal(proposal_uuid uuid,approve boolean,note text default null) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.proposals;v public.investments;t text;h uuid;result uuid;transfer uuid;q bigint;price bigint;s bigint;f jsonb;b jsonb;unit bigint;derived numeric;total bigint;begin
 select household_id,payload->>'type' into h,t from public.proposals where id=proposal_uuid;
 if note is not null and char_length(note)>500 then raise exception 'decision note is too long';end if;
 if h is null or not public.is_household_member(h) then raise exception 'not authorized';end if;
 if t not in ('investment_buy','investment_sell','dividend','investment_valuation') then return public.decide_p4_proposal(proposal_uuid,approve,note);end if;
 perform 1 from public.households where id=h for update;
 select * into p from public.proposals where id=proposal_uuid for update;
 if p.submitter_id=auth.uid() then raise exception 'submitter cannot decide own proposal';end if;
 if approve is null then raise exception 'decision required';end if;
 if p.status='approved' and approve then select id into result from public.ledger_entries where proposal_id=p.id;if result is null then select id into result from public.investment_valuations where proposal_id=p.id;end if;return result;end if;
 if p.status='rejected' and not approve then return null;end if;
 if p.status not in ('pending_approval','overdue_pending') then raise exception 'proposal is not reviewable';end if;
 if not approve then update public.proposals set status='rejected',decided_by=auth.uid(),decided_at=now(),decision_note=note where id=p.id;
 else
  perform public.require_active_household(h);
  perform public.validate_proposal_payload(h,p.payload);
  select * into v from public.investments where id=(p.payload->>'investmentId')::uuid for update;
  s:=public.next_investment_sequence(h);
  if t='investment_valuation' then
   if p.payload?'basis' then
    b:=public.investment_basis_internal(v.id,(p.payload->>'occurredAt')::date,(p.payload->'basis'->>'throughSequence')::bigint);
    if b->>'signature' is distinct from p.payload->'basis'->>'signature' or b->>'quantityMicro' is distinct from p.payload->'basis'->>'quantityMicro' then raise exception '估值依赖持仓已变化，请撤回并重新确认';end if;
    if p.payload->>'valuationMode'='total_market' then total:=(p.payload->>'totalValueMinor')::bigint;derived:=total::numeric*10000/(b->>'quantityMicro')::numeric;unit:=case when round(derived*100000000)<=9007199254740991 then round(derived*100000000)::bigint else null end;
    else unit:=(p.payload->>'unitValueHundredMillionths')::bigint;end if;
   else unit:=coalesce((p.payload->>'unitValueTenThousandths')::bigint*10000,(p.payload->>'unitValueMinor')::bigint*1000000);end if;
   if unit>9007199254740991 then raise exception 'derived unit value exceeds safe range';end if;
   insert into public.investment_valuations(household_id,investment_id,proposal_id,value_date,currency,note,created_by,unit_value_minor,unit_value_1e4,unit_value_1e8,derived_unit_price,input_mode,quantity_micro,total_value_minor,basis_through_sequence,basis_revision,basis_signature,effective_sequence)
   values(h,v.id,p.id,(p.payload->>'occurredAt')::date,v.currency,p.payload->>'title',p.submitter_id,coalesce(round(unit::numeric/1000000),0),coalesce(round(unit::numeric/10000),0),unit,coalesce(derived,unit::numeric/100000000),coalesce(p.payload->>'valuationMode','legacy'),(p.payload->'basis'->>'quantityMicro')::bigint,total,(p.payload->'basis'->>'throughSequence')::bigint,(p.payload->'basis'->>'revision')::bigint,p.payload->'basis'->>'signature',s) returning id into result;
  else
   f:=p.payload->'funding';
   if f is not null then
    if f->>'currency'<>v.currency and not exists(select 1 from public.fx_rate_snapshots where id=p.fx_snapshot_id and household_id=h and status='approved') then raise exception 'approved exchange rate snapshot is required';end if;
    insert into public.cash_transfers(household_id,proposal_id,source_account_kind,destination_account_kind,amount_minor,currency,destination_amount_minor,destination_currency,movement_type,fx_snapshot_id,occurred_at,effective_sequence,title)
    values(h,p.id,'bank','brokerage',(f->>'amountMinor')::bigint,f->>'currency',(f->>'destinationAmountMinor')::bigint,v.currency,case when f->>'currency'=v.currency then 'same_currency' else 'currency_exchange' end,case when f->>'currency'=v.currency then null else p.fx_snapshot_id end,(f->>'occurredAt')::date,s,p.payload->>'title'||' · 银行转入') returning id into transfer;s:=s+1;
   else transfer:=(p.payload->>'linkedTransferId')::uuid;end if;
   q:=coalesce((p.payload->>'quantityMicro')::bigint,(p.payload->>'quantityMilli')::bigint*1000);
   price:=coalesce((p.payload->>'unitPriceHundredMillionths')::bigint,(p.payload->>'unitPriceTenThousandths')::bigint*10000,(p.payload->>'unitPriceMinor')::bigint*1000000);
   insert into public.ledger_entries(household_id,proposal_id,entry_type,amount_minor,currency,occurred_at,effective_sequence,title,member_id,investment_id,quantity_milli,quantity_micro,unit_price_1e4,unit_price_1e8,account_kind,funding_transfer_id)
   values(h,p.id,t,(p.payload->>'amountMinor')::bigint,v.currency,(p.payload->>'occurredAt')::date,s,p.payload->>'title',p.submitter_id,v.id,round(q::numeric/1000),q,case when price is null then null else greatest(1,round(price::numeric/10000)) end,price,'brokerage',transfer) returning id into result;
  end if;
  update public.proposals set status='approved',decided_by=auth.uid(),decided_at=now(),decision_note=note where id=p.id;
 end if;
 insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail) values(h,auth.uid(),case when approve then 'approve' else 'reject' end,'proposal',p.id,jsonb_build_object('note',note,'fundingTransferId',transfer));return result;
end;$$;

-- Metadata cannot manufacture opening balances or change denomination.
drop function public.create_investment_proposal(uuid,jsonb,uuid);
drop function public.create_investment_direct(uuid,text,text,text,text);
create function public.create_investment_direct(target_household uuid,investment_name text,ticker_input text,asset_type_input text,investment_currency text,unit_name_input text default '份',note_input text default '',cadence_input text default 'weekly') returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare id uuid;begin
 perform 1 from public.households hh where hh.id=target_household for update;
 perform public.require_active_household(target_household);
 if coalesce(char_length(trim(investment_name)),0) not between 1 and 120 or coalesce(char_length(trim(asset_type_input)),0) not between 1 and 40 or char_length(coalesce(ticker_input,''))>30 or investment_currency is null then raise exception 'invalid investment metadata';end if;
 insert into public.investments(household_id,name,ticker,asset_type,currency,unit_name,note,valuation_cadence,created_by) values(target_household,trim(investment_name),nullif(trim(ticker_input),''),trim(asset_type_input),investment_currency,trim(unit_name_input),note_input,cadence_input,auth.uid()) returning investments.id into id;
 insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id) values(target_household,auth.uid(),'create','investment',id);return id;
end;$$;
create function public.update_investment_metadata(target_investment uuid,investment_name text,ticker_input text,asset_type_input text,unit_name_input text,note_input text,cadence_input text) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare h uuid;begin
 select household_id into h from public.investments where id=target_investment and archived_at is null;
 perform 1 from public.households where id=h for update;
 perform public.require_active_household(h);
 perform 1 from public.investments where id=target_investment and archived_at is null for update;
 if not found then raise exception 'investment not found';end if;
 if coalesce(char_length(trim(investment_name)),0) not between 1 and 120 or coalesce(char_length(trim(asset_type_input)),0) not between 1 and 40 or char_length(coalesce(ticker_input,''))>30 then raise exception 'invalid investment metadata';end if;
 update public.investments set name=trim(investment_name),ticker=nullif(trim(ticker_input),''),asset_type=trim(asset_type_input),unit_name=trim(unit_name_input),note=note_input,valuation_cadence=cadence_input where id=target_investment;
 insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id) values(h,auth.uid(),'update_metadata','investment',target_investment);
end;$$;
revoke all on function public.next_investment_sequence(uuid),public.investment_basis_internal(uuid,date,bigint),public.check_investment_history(),public.validate_proposal_payload(uuid,jsonb),public.validate_p4_proposal_payload(uuid,jsonb),public.submit_p4_proposal(uuid,jsonb,uuid),public.decide_p4_proposal(uuid,boolean,text),public.current_investment_quantity(uuid) from public,authenticated;
revoke all on function public.get_investment_basis(uuid,date),public.submit_proposal(uuid,jsonb,uuid),public.decide_proposal(uuid,boolean,text),public.create_investment_direct(uuid,text,text,text,text,text,text,text),public.update_investment_metadata(uuid,text,text,text,text,text,text) from public;
grant execute on function public.get_investment_basis(uuid,date),public.submit_proposal(uuid,jsonb,uuid),public.decide_proposal(uuid,boolean,text),public.create_investment_direct(uuid,text,text,text,text,text,text,text),public.update_investment_metadata(uuid,text,text,text,text,text,text) to authenticated;
