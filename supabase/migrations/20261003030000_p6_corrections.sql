-- P6: source-linked refunds, member recoveries, and audited whole-event voids.
alter table public.ledger_entries drop constraint ledger_entries_entry_type_check;
alter table public.ledger_entries add constraint ledger_entries_entry_type_check check(entry_type in ('opening_balance','deposit','expense','expense_refund','reimbursement','settlement','investment_buy','investment_sell','dividend','member_return'));
alter table public.ledger_entries add column refund_source_entry_id uuid references public.ledger_entries(id);
alter table public.ledger_entries add column refund_recipient text check(refund_recipient in ('member','common'));
alter table public.ledger_entries add column recovery_claim_id uuid references public.reimbursement_claims(id);
alter table public.ledger_entries add column recovery_original_minor bigint check(recovery_original_minor>0);
alter table public.ledger_entries add column void_proposal_id uuid references public.proposals(id);
alter table public.cash_transfers add column void_proposal_id uuid references public.proposals(id);
alter table public.investment_valuations add column status text not null default 'posted' check(status in ('posted','voided'));
alter table public.investment_valuations add column void_proposal_id uuid references public.proposals(id);
alter table public.reimbursement_claims add column refunded_member_minor bigint not null default 0 check(refunded_member_minor>=0);
alter table public.reimbursement_claims add column returned_minor bigint not null default 0 check(returned_minor>=0);
alter table public.settlement_batches drop constraint settlement_batches_status_check;
alter table public.settlement_batches add constraint settlement_batches_status_check check(status in ('reserved','posted','released','voided'));
alter table public.settlement_batches drop constraint settlement_batches_check;
alter table public.settlement_batches add constraint settlement_batches_check check((status in ('posted','voided'))=(ledger_entry_id is not null));
alter table public.settlement_allocations drop constraint settlement_allocations_status_check;
alter table public.settlement_allocations add constraint settlement_allocations_status_check check(status in ('reserved','posted','released','voided'));
alter table public.settlement_allocations drop constraint settlement_allocation_lifecycle_check;
alter table public.settlement_allocations add constraint settlement_allocation_lifecycle_check check((status in ('posted','voided') and settlement_entry_id is not null) or(status in ('reserved','released') and settlement_entry_id is null and batch_id is not null));
create table public.void_requests(
 id uuid primary key default extensions.gen_random_uuid(),household_id uuid not null references public.households(id),proposal_id uuid not null unique references public.proposals(id),
 target_kind text not null check(target_kind in ('entry','transfer','valuation')),target_id uuid not null,reason text not null check(char_length(trim(reason)) between 1 and 500),
 impact jsonb not null,replacement_payload jsonb,replacement_proposal_id uuid references public.proposals(id),created_at timestamptz not null default now()
);
alter table public.void_requests enable row level security;
create policy void_requests_read on public.void_requests for select using(public.is_household_member(household_id));
grant select on public.void_requests to authenticated;
create trigger bump_version_on_void_request after insert or update or delete on public.void_requests for each row execute function public.bump_household_ledger_version();
alter publication supabase_realtime add table public.void_requests;
create index refunds_source_idx on public.ledger_entries(refund_source_entry_id,status);
create index recoveries_claim_idx on public.ledger_entries(recovery_claim_id,status);

create function public.claim_financials_internal(c uuid) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('original',v.claimed_minor,'refunded',coalesce((select sum(amount_minor) from public.ledger_entries where refund_source_entry_id=v.source_entry_id and refund_recipient='member' and status='posted'),0),
 'paid',coalesce((select sum(a.amount_minor) from public.settlement_allocations a join public.ledger_entries e on e.id=a.settlement_entry_id where a.claim_id=v.id and a.status='posted' and e.status='posted'),0),
 'reserved',coalesce((select sum(amount_minor) from public.settlement_allocations where claim_id=v.id and status='reserved'),0),
 'returned',coalesce((select sum(recovery_original_minor) from public.ledger_entries where recovery_claim_id=v.id and status='posted'),0),
 'returnReserved',coalesce((select sum((p.payload->>'originalAmountMinor')::bigint) from public.proposals p where p.household_id=v.household_id and p.payload->>'type'='member_return' and p.payload->>'claimId'=v.id::text and p.status in ('pending_approval','overdue_pending') and not exists(select 1 from public.ledger_entries e where e.proposal_id=p.id and e.status='posted')),0)) from public.reimbursement_claims v where id=c;
$$;
create function public.refresh_claims_internal(h uuid) returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.reimbursement_claims;f jsonb;a bigint;s bigint;r bigint;t bigint;u bigint;begin
 for c in select * from public.reimbursement_claims where household_id=h order by id for update loop
  f:=public.claim_financials_internal(c.id);a:=c.claimed_minor-(f->>'refunded')::bigint;s:=(f->>'paid')::bigint;r:=(f->>'reserved')::bigint;t:=(f->>'returned')::bigint;u:=greatest(s-a,0)-t;
  if a<0 or r>greatest(a-s,0) then raise exception '退款或作废与有效报销预留冲突，请先撤回相关打款';end if;
  if u<0 or (f->>'returnReserved')::bigint>u then raise exception '存在后续返还或待审批返还，请先处理依赖';end if;
  if not exists(select 1 from public.ledger_entries where id=c.source_entry_id and status='posted') and ((f->>'refunded')::bigint>0 or s>0 or r>0 or t>0) then raise exception '原代付存在退款或打款依赖';end if;
  update public.reimbursement_claims set refunded_member_minor=(f->>'refunded')::bigint,returned_minor=t,
   version=version+case when refunded_member_minor<>(f->>'refunded')::bigint then 1 else 0 end,
   status=case when not exists(select 1 from public.ledger_entries where id=c.source_entry_id and status='posted') then 'voided' when s>=a then 'settled' when s>0 then 'partially_settled' else 'open' end
  where id=c.id and (refunded_member_minor<>(f->>'refunded')::bigint or returned_minor<>t or status is distinct from case when not exists(select 1 from public.ledger_entries where id=c.source_entry_id and status='posted') then 'voided' when s>=a then 'settled' when s>0 then 'partially_settled' else 'open' end);
 end loop;
end;$$;
create function public.refresh_claims_after_event() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$begin perform public.refresh_claims_internal(case when tg_op='DELETE' then old.household_id else new.household_id end);return null;end;$$;
create trigger z_refresh_claims_after_event after insert or update or delete on public.ledger_entries for each row execute function public.refresh_claims_after_event();

create function public.investment_position_internal(i uuid,excluded uuid[]) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare v public.investments;e public.ledger_entries;q numeric;cost numeric;gain numeric:=0;dividends numeric:=0;disposed numeric;begin
 select * into v from public.investments where id=i;q:=v.opening_quantity_milli*1000;cost:=v.opening_cost_minor;
 for e in select * from public.ledger_entries where investment_id=i and status='posted' and not id=any(excluded) order by occurred_at,effective_sequence,id loop
  if e.entry_type='investment_buy' then q:=q+e.quantity_micro;cost:=cost+e.amount_minor;
  elsif e.entry_type='investment_sell' then if e.quantity_micro>q then raise exception '作废会使后续持仓为负，请先处理卖出依赖';end if;disposed:=round(cost*e.quantity_micro/q);cost:=cost-disposed;q:=q-e.quantity_micro;gain:=gain+e.amount_minor-disposed;elsif e.entry_type='dividend' then dividends:=dividends+e.amount_minor;end if;
 end loop;
 return jsonb_build_object('quantityMicro',q,'costMinor',cost,'realizedMinor',gain,'dividendMinor',dividends);
end;$$;
-- A void plan is a frozen, inspectable set of original records, never a new cash movement.
create function public.cash_balance_internal(h uuid,a text,c text) returns bigint language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce((select sum(case when entry_type in ('opening_balance','deposit','investment_sell','dividend','member_return') or(entry_type='expense_refund' and coalesce(refund_recipient,'common')='common') then amount_minor when entry_type in ('expense','settlement','investment_buy') then -amount_minor else 0 end) from public.ledger_entries where household_id=h and status='posted' and currency=c and coalesce(account_kind,case when entry_type in ('investment_buy','investment_sell','dividend') then 'brokerage' else 'bank' end)=a),0)
 +coalesce((select sum(destination_amount_minor) from public.cash_transfers where household_id=h and status='posted' and destination_account_kind=a and destination_currency=c),0)
 -coalesce((select sum(amount_minor) from public.cash_transfers where household_id=h and status='posted' and source_account_kind=a and currency=c),0);
$$;
create function public.void_plan_internal(h uuid,k text,i uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare p uuid;es jsonb:='[]';ts jsonb:='[]';vs jsonb:='[]';ids uuid[];c uuid;cash jsonb;investments jsonb:='[]';claims jsonb:='[]';item record;f jsonb;g bigint;bf bigint;af bigint;bs bigint;as_ bigint;bt bigint;at_ bigint;begin
 if k='entry' then select proposal_id into p from public.ledger_entries where id=i and household_id=h and status='posted';
 elsif k='transfer' then select proposal_id into p from public.cash_transfers where id=i and household_id=h and status='posted';
 elsif k='valuation' then select proposal_id into p from public.investment_valuations where id=i and household_id=h and status='posted';
 else raise exception 'invalid void target';end if;
 if p is null then raise exception '记录不存在或已作废';end if;
  select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]') into es from public.ledger_entries e where proposal_id=p and status='posted';
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]') into ts from public.cash_transfers t where proposal_id=p and status='posted';
  select coalesce(jsonb_agg(to_jsonb(v) order by v.id),'[]') into vs from public.investment_valuations v where proposal_id=p and status='posted';
 select array_agg((v->>'id')::uuid) into ids from jsonb_array_elements(es) v;
 if exists(select 1 from public.ledger_entries e where e.status='posted' and e.refund_source_entry_id=any(ids) and not e.id=any(ids)) then raise exception '存在有效关联退款，请先作废退款';end if;
 if exists(select 1 from public.settlement_allocations a join public.reimbursement_claims c on c.id=a.claim_id where c.source_entry_id=any(ids) and a.status in ('posted','reserved')) then raise exception '原代付存在有效打款或预留，请先处理依赖';end if;
 if exists(select 1 from public.ledger_entries e where e.status='posted' and e.funding_transfer_id in(select (v->>'id')::uuid from jsonb_array_elements(ts) v) and not e.id=any(coalesce(ids,'{}'::uuid[]))) then raise exception '转入被其他买入引用，请先作废关联买入';end if;
 select coalesce(jsonb_agg(jsonb_build_object('account',account,'currency',currency,'deltaMinor',delta,'beforeMinor',public.cash_balance_internal(h,account,currency),'afterMinor',public.cash_balance_internal(h,account,currency)+delta) order by account,currency),'[]') into cash from(
 select account,currency,sum(delta) delta from(
  select coalesce(x->>'account_kind',case when x->>'entry_type' in ('investment_buy','investment_sell','dividend') then 'brokerage' else 'bank' end) account,x->>'currency' currency,case when x->>'entry_type' in ('deposit','opening_balance','investment_sell','dividend','member_return') or(x->>'entry_type'='expense_refund' and coalesce(x->>'refund_recipient','common')='common') then -(x->>'amount_minor')::bigint when x->>'entry_type' in ('expense','investment_buy','settlement') then (x->>'amount_minor')::bigint else 0 end delta from jsonb_array_elements(es) x
  union all select x->>'source_account_kind',x->>'currency',(x->>'amount_minor')::bigint from jsonb_array_elements(ts) x
  union all select x->>'destination_account_kind',x->>'destination_currency',-(x->>'destination_amount_minor')::bigint from jsonb_array_elements(ts) x
 ) effects where account is not null group by account,currency having sum(delta)<>0) grouped;
 for item in select distinct (x->>'investment_id')::uuid id from jsonb_array_elements(es) x where x->>'entry_type' in ('investment_buy','investment_sell','dividend') order by id loop
  investments:=investments||jsonb_build_array(jsonb_build_object('id',item.id,'before',public.investment_position_internal(item.id,'{}'),'after',public.investment_position_internal(item.id,coalesce(ids,'{}'))));
 end loop;
 for item in select rc.* from public.reimbursement_claims rc where rc.household_id=h and (rc.source_entry_id=any(ids) or rc.id in(select claim_id from public.settlement_allocations where settlement_entry_id=any(ids)) or rc.source_entry_id in(select (x->>'refund_source_entry_id')::uuid from jsonb_array_elements(es) x) or rc.id in(select (x->>'recovery_claim_id')::uuid from jsonb_array_elements(es) x)) order by rc.id loop
  f:=public.claim_financials_internal(item.id);g:=item.claimed_minor;bf:=(f->>'refunded')::bigint;bs:=(f->>'paid')::bigint;bt:=(f->>'returned')::bigint;
  af:=bf-coalesce((select sum((x->>'amount_minor')::bigint) from jsonb_array_elements(es) x where x->>'refund_source_entry_id'=item.source_entry_id::text and x->>'refund_recipient'='member'),0);
  as_:=bs-coalesce((select sum(amount_minor) from public.settlement_allocations where claim_id=item.id and settlement_entry_id=any(ids) and status='posted'),0);
  at_:=bt-coalesce((select sum((x->>'recovery_original_minor')::bigint) from jsonb_array_elements(es) x where x->>'recovery_claim_id'=item.id::text),0);
  if greatest(as_-(g-af),0)-at_<0 or (f->>'returnReserved')::bigint>greatest(as_-(g-af),0)-at_ then raise exception '作废会破坏后续返还，请先处理返还依赖';end if;
  if (f->>'reserved')::bigint>greatest(g-af-as_,0) then raise exception '作废与有效付款预留冲突';end if;
  claims:=claims||jsonb_build_array(jsonb_build_object('id',item.id,'currency',item.currency,'beforeOutstanding',greatest(g-bf-bs,0),'afterOutstanding',case when item.source_entry_id=any(ids) then 0 else greatest(g-af-as_,0) end,'beforeRecovery',greatest(bs-(g-bf),0)-bt,'afterRecovery',greatest(as_-(g-af),0)-at_));
 end loop;
 return jsonb_build_object('entries',es,'transfers',ts,'valuations',vs,'cashEffects',cash,'investmentEffects',investments,'claimEffects',claims,'originalProposalId',p,'rule','同组全部作废；原汇率不修改；批准时重新检查依赖');
end;$$;
create function public.get_void_plan(target_household uuid,target_kind text,target_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$begin perform public.require_active_household(target_household);return public.void_plan_internal(target_household,target_kind,target_id);end;$$;

create function public.submit_correction(target_household uuid,payload_input jsonb,request_key uuid) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare oldp public.proposals;e public.ledger_entries;c public.reimbursement_claims;f jsonb;p jsonb;result uuid;fx public.fx_rate_snapshots;amount numeric;available bigint;plan jsonb;t text:=payload_input->>'type';payment text;begin
 perform 1 from public.households where id=target_household for update;perform public.require_active_household(target_household);
 if request_key is null then raise exception 'idempotency key required';end if;
 select * into oldp from public.proposals where household_id=target_household and submitter_id=auth.uid() and idempotency_key=request_key;
 if oldp.id is not null then if oldp.payload->'request' is distinct from payload_input then raise exception '幂等键已用于不同内容';end if;return oldp.id;end if;
 if payload_input is null or jsonb_typeof(payload_input)<>'object' or t not in ('expense_refund','member_return','void_record') then raise exception 'invalid correction';end if;
 if exists(select 1 from jsonb_object_keys(payload_input) key where key not in ('type','sourceEntryId','recipient','amountMinor','accountKind','occurredAt','title','claimId','originalAmountMinor','expectedVersion','currency','targetKind','targetId','reason','replacementPayload')) then raise exception 'unexpected correction field';end if;
 if t='void_record' then
  if exists(select 1 from jsonb_object_keys(payload_input) key where key not in ('type','targetKind','targetId','reason','replacementPayload')) then raise exception 'unexpected void field';end if;
  if jsonb_typeof(payload_input->'reason') is distinct from 'string' or coalesce(char_length(trim(payload_input->>'reason')),0) not between 1 and 500 then raise exception '必须填写作废原因';end if;
  plan:=public.void_plan_internal(target_household,payload_input->>'targetKind',(payload_input->>'targetId')::uuid);
  if payload_input?'replacementPayload' then
   if jsonb_typeof(payload_input->'replacementPayload') is distinct from 'object' or payload_input->'replacementPayload'->>'type' in ('void_record','member_return','expense_refund','settlement','fx_rate_update','investment_valuation') then raise exception '此记录需从相应原单重新发起，不能生成替代草稿';end if;
   perform public.validate_proposal_payload(target_household,payload_input->'replacementPayload');
  end if;
  p:=jsonb_build_object('type',t,'currency',(select reporting_currency from public.households where id=target_household),'amountMinor',0,'occurredAt',current_date,'title','作废：'||left(payload_input->>'reason',140),'reason',payload_input->>'reason','targetKind',payload_input->>'targetKind','targetId',payload_input->>'targetId','impact',plan,'request',payload_input);
 else
  if jsonb_typeof(payload_input->'title') is distinct from 'string' or coalesce(char_length(trim(payload_input->>'title')),0) not between 1 and 160 or coalesce(payload_input->>'occurredAt','')!~'^\d{4}-\d{2}-\d{2}$' or (payload_input->>'occurredAt')::date>current_date then raise exception 'invalid date or title';end if;
  if t='expense_refund' then
   if exists(select 1 from jsonb_object_keys(payload_input) key where key not in ('type','sourceEntryId','recipient','amountMinor','accountKind','occurredAt','title')) then raise exception 'unexpected refund field';end if;
   select * into e from public.ledger_entries where id=(payload_input->>'sourceEntryId')::uuid and household_id=target_household and status='posted' and entry_type in ('expense','reimbursement') for update;
   if e.id is null then raise exception '退款必须关联有效消费原单';end if;
   if (payload_input->>'occurredAt')::date<e.occurred_at then raise exception '退款日期不能早于原消费';end if;
   if coalesce(payload_input->>'recipient','') not in ('member','common') or(e.entry_type='expense' and payload_input->>'recipient'<>'common') then raise exception 'invalid refund recipient';end if;
   if jsonb_typeof(payload_input->'amountMinor') is distinct from 'number' then raise exception 'invalid refund amount';end if;
   amount:=(payload_input->>'amountMinor')::numeric;
   if amount<>trunc(amount) or amount not between 1 and 9999999999 then raise exception 'invalid refund amount';end if;
   if amount>e.amount_minor-coalesce((select sum(amount_minor) from public.ledger_entries where refund_source_entry_id=e.id and status='posted'),0) then raise exception '超过原单可退款额';end if;
   if payload_input->>'recipient'='common' and not exists(select 1 from public.cash_accounts where household_id=target_household and kind=payload_input->>'accountKind') then raise exception '共同退款必须选择收款账户';end if;
   if payload_input->>'recipient'='member' and payload_input?'accountKind' then raise exception '个人退款不进入共同账户';end if;
   p:=payload_input||jsonb_build_object('currency',e.currency,'categoryId',e.category_id,'category',e.category,'projectId',e.project_id,'project',e.project_name,'payerMemberId',e.payer_member_id);
  else
   if exists(select 1 from jsonb_object_keys(payload_input) key where key not in ('type','claimId','originalAmountMinor','expectedVersion','currency','accountKind','occurredAt','title')) then raise exception 'unexpected return field';end if;
   select * into c from public.reimbursement_claims where id=(payload_input->>'claimId')::uuid and household_id=target_household and status<>'voided' for update;
   if c.id is null or jsonb_typeof(payload_input->'expectedVersion') is distinct from 'number' or c.version::text is distinct from payload_input->>'expectedVersion' then raise exception '应返款原单已变化';end if;
   if jsonb_typeof(payload_input->'originalAmountMinor') is distinct from 'number' then raise exception 'invalid original return';end if;
   amount:=(payload_input->>'originalAmountMinor')::numeric;
   if amount<>trunc(amount) or amount not between 1 and 9999999999 then raise exception 'invalid original return';end if;
   f:=public.claim_financials_internal(c.id);available:=greatest((f->>'paid')::bigint-c.claimed_minor+(f->>'refunded')::bigint,0)-(f->>'returned')::bigint-(f->>'returnReserved')::bigint;
   if amount>available then raise exception '超过应返共同款或已有待审批返还';end if;
   if (payload_input->>'occurredAt')::date<coalesce((select max(occurred_at) from public.ledger_entries where status='posted' and (refund_source_entry_id=c.source_entry_id and refund_recipient='member' or id in(select settlement_entry_id from public.settlement_allocations where claim_id=c.id and status='posted'))),current_date) then raise exception '返还日期不能早于形成应返款的退款或打款';end if;
   if coalesce(payload_input->>'currency','') not in ('USD','CNY','HKD') or not exists(select 1 from public.cash_accounts where household_id=target_household and kind=payload_input->>'accountKind') then raise exception 'invalid return currency or account';end if;
   p:=payload_input||jsonb_build_object('payerMemberId',c.claimant_id,'originalCurrency',c.currency);
  end if;
  payment:=p->>'currency';
  if payment<>(select reporting_currency from public.households where id=target_household) or(t='member_return' and payment<>c.currency) then
   select * into fx from public.fx_rate_snapshots where household_id=target_household and status='approved' and effective_at<=now() order by effective_at desc,approved_at desc,id desc limit 1;
   if fx.id is null then raise exception '需要已批准汇率';end if;
  end if;
  if t='member_return' then
   amount:=round(amount*(case payment when 'USD' then 1 when 'CNY' then fx.usd_to_cny else fx.usd_to_hkd end)/(case c.currency when 'USD' then 1 when 'CNY' then fx.usd_to_cny else fx.usd_to_hkd end));
   if payment=c.currency then amount:=(payload_input->>'originalAmountMinor')::bigint;end if;
   if amount not between 1 and 9999999999 then raise exception '折算返还不足一分或超限';end if;
  end if;
  p:=p||jsonb_build_object('amountMinor',amount,'request',payload_input);
 end if;
 insert into public.proposals(household_id,submitter_id,payload,idempotency_key,fx_snapshot_id) values(target_household,auth.uid(),p,request_key,fx.id) returning id into result;
 if t='void_record' then insert into public.void_requests(household_id,proposal_id,target_kind,target_id,reason,impact,replacement_payload) values(target_household,result,payload_input->>'targetKind',(payload_input->>'targetId')::uuid,payload_input->>'reason',plan,payload_input->'replacementPayload');end if;
 insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail) values(target_household,auth.uid(),'submit','correction',result,p);return result;
end;$$;

-- Force all new refunds through the source-linked path; existing unlinked history stays visible for migration review.
alter function public.submit_proposal(uuid,jsonb,uuid) rename to submit_p5_proposal;
create function public.submit_proposal(target_household uuid,payload_input jsonb,request_key uuid) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$begin
 if payload_input->>'type' in ('expense_refund','member_return','void_record') then raise exception '请从原单发起退款、返还或作废';end if;return public.submit_p5_proposal(target_household,payload_input,request_key);end;$$;

alter function public.decide_proposal(uuid,boolean,text) rename to decide_p5_proposal;
create function public.decide_proposal(proposal_uuid uuid,approve boolean,note text default null) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.proposals;v public.void_requests;e public.ledger_entries;c public.reimbursement_claims;f jsonb;result uuid;plan jsonb;inv record;item record;replacement uuid;replacement_fx uuid;begin
 select * into p from public.proposals where id=proposal_uuid;
 if p.id is null or not public.is_household_member(p.household_id) then raise exception 'not authorized';end if;
 perform 1 from public.households where id=p.household_id for update;
 select * into p from public.proposals where id=proposal_uuid for update;
 if p.payload->>'type' not in ('expense_refund','member_return','void_record') then return public.decide_p5_proposal(proposal_uuid,approve,note);end if;
 if p.submitter_id=auth.uid() then raise exception 'submitter cannot decide own proposal';end if;
 if approve is null or(note is not null and char_length(note)>500) then raise exception 'invalid decision';end if;
 if p.status='approved' and approve then if p.payload->>'type'='void_record' then return p.id;end if;select id into result from public.ledger_entries where proposal_id=p.id;return result;end if;
 if p.status='rejected' and not approve then return null;end if;
 if p.status not in ('pending_approval','overdue_pending') then raise exception 'proposal is not reviewable';end if;
 perform public.require_active_household(p.household_id);
 if approve then
  if p.payload->>'type'='expense_refund' then
   select * into e from public.ledger_entries where id=(p.payload->>'sourceEntryId')::uuid and status='posted' and household_id=p.household_id for update;
   if e.id is null or (p.payload->>'amountMinor')::bigint>e.amount_minor-coalesce((select sum(amount_minor) from public.ledger_entries where refund_source_entry_id=e.id and status='posted'),0) then raise exception '原单失效或超过可退额';end if;
   insert into public.ledger_entries(household_id,proposal_id,entry_type,amount_minor,currency,occurred_at,effective_sequence,title,member_id,payer_member_id,account_kind,category_id,category,project_id,project_name,refund_source_entry_id,refund_recipient)
   values(p.household_id,p.id,'expense_refund',(p.payload->>'amountMinor')::bigint,e.currency,(p.payload->>'occurredAt')::date,public.next_investment_sequence(p.household_id),p.payload->>'title',p.submitter_id,e.payer_member_id,case when p.payload->>'recipient'='common' then p.payload->>'accountKind' else null end,e.category_id,e.category,e.project_id,e.project_name,e.id,p.payload->>'recipient') returning id into result;
  elsif p.payload->>'type'='member_return' then
   select * into c from public.reimbursement_claims where id=(p.payload->>'claimId')::uuid and household_id=p.household_id and status<>'voided' for update;
   if c.id is null or c.version::text is distinct from p.payload->>'expectedVersion' then raise exception '应返款依赖已变化，请撤回重提';end if;
   f:=public.claim_financials_internal(c.id);
   if (f->>'returnReserved')::bigint>greatest((f->>'paid')::bigint-c.claimed_minor+(f->>'refunded')::bigint,0)-(f->>'returned')::bigint then raise exception '返还额度不足';end if;
   insert into public.ledger_entries(household_id,proposal_id,entry_type,amount_minor,currency,occurred_at,effective_sequence,title,member_id,payer_member_id,account_kind,recovery_claim_id,recovery_original_minor,fx_snapshot_id)
   values(p.household_id,p.id,'member_return',(p.payload->>'amountMinor')::bigint,p.payload->>'currency',(p.payload->>'occurredAt')::date,public.next_investment_sequence(p.household_id),p.payload->>'title',p.submitter_id,c.claimant_id,p.payload->>'accountKind',c.id,(p.payload->>'originalAmountMinor')::bigint,p.fx_snapshot_id) returning id into result;
  else
   select * into v from public.void_requests where proposal_id=p.id for update;
   plan:=public.void_plan_internal(p.household_id,v.target_kind,v.target_id);
   if plan<>v.impact then raise exception '作废影响已变化，请撤回并重新确认';end if;
   update public.settlement_allocations set status='voided' where settlement_entry_id in(select (x->>'id')::uuid from jsonb_array_elements(plan->'entries') x) and status='posted';
   update public.settlement_batches set status='voided' where ledger_entry_id in(select (x->>'id')::uuid from jsonb_array_elements(plan->'entries') x) and status='posted';
   update public.ledger_entries set status='voided',void_proposal_id=p.id where id in(select (x->>'id')::uuid from jsonb_array_elements(plan->'entries') x);
   update public.cash_transfers set status='voided',void_proposal_id=p.id where id in(select (x->>'id')::uuid from jsonb_array_elements(plan->'transfers') x);
   update public.investment_valuations set status='voided',void_proposal_id=p.id where id in(select (x->>'id')::uuid from jsonb_array_elements(plan->'valuations') x);
   for inv in select distinct (x->>'investment_id')::uuid id from jsonb_array_elements(plan->'entries') x where x->>'entry_type' in ('investment_buy','investment_sell') loop
    if exists(select 1 from public.investment_valuations iv where iv.investment_id=inv.id and iv.status='posted' and (iv.basis_signature is null or iv.basis_signature is distinct from public.investment_basis_internal(inv.id,iv.value_date,iv.basis_through_sequence)->>'signature')) then raise exception '作废将使已批准估值依据失效，请先作废对应估值';end if;
    if exists(select 1 from public.proposals q where q.household_id=p.household_id and q.status in ('pending_approval','overdue_pending') and q.payload->>'type'='investment_valuation' and q.payload->>'investmentId'=inv.id::text and q.payload->'basis'->>'signature' is distinct from public.investment_basis_internal(inv.id,(q.payload->>'occurredAt')::date,(q.payload->'basis'->>'throughSequence')::bigint)->>'signature') then raise exception '存在依赖该交易的待审估值，请先撤回';end if;
   end loop;
   perform public.refresh_claims_internal(p.household_id);
   if v.replacement_payload is not null then
    -- Replacement is independently pending; never silently approved with the void.
    perform public.validate_proposal_payload(p.household_id,v.replacement_payload);
    if v.replacement_payload->>'currency'<>(select reporting_currency from public.households where id=p.household_id) or v.replacement_payload->>'type'='currency_exchange' or(v.replacement_payload?'funding' and v.replacement_payload->'funding'->>'currency'<>v.replacement_payload->>'currency') then
     select id into replacement_fx from public.fx_rate_snapshots where household_id=p.household_id and status='approved' and effective_at<=now() order by effective_at desc,approved_at desc,id desc limit 1;
     if replacement_fx is null then raise exception '替代记录需要已批准汇率';end if;
    end if;
    insert into public.proposals(household_id,submitter_id,payload,idempotency_key,fx_snapshot_id)
    values(p.household_id,p.submitter_id,v.replacement_payload,extensions.gen_random_uuid(),replacement_fx) returning id into replacement;
    update public.void_requests set replacement_proposal_id=replacement where id=v.id;
   end if;
   result:=p.id;
  end if;
 end if;
 update public.proposals set status=case when approve then 'approved'::public.proposal_status else 'rejected'::public.proposal_status end,decided_by=auth.uid(),decided_at=now(),decision_note=note where id=p.id;
 insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail) values(p.household_id,auth.uid(),case when approve then 'approve' else 'reject' end,'correction',p.id,jsonb_build_object('impact',plan,'request',p.payload,'replacementProposalId',replacement));return result;
end;$$;
revoke all on function public.cash_balance_internal(uuid,text,text),public.investment_position_internal(uuid,uuid[]),public.claim_financials_internal(uuid),public.refresh_claims_internal(uuid),public.refresh_claims_after_event(),public.void_plan_internal(uuid,text,uuid),public.submit_p5_proposal(uuid,jsonb,uuid),public.decide_p5_proposal(uuid,boolean,text) from public,authenticated;
revoke all on function public.get_void_plan(uuid,text,uuid),public.submit_correction(uuid,jsonb,uuid),public.submit_proposal(uuid,jsonb,uuid),public.decide_proposal(uuid,boolean,text) from public;
grant execute on function public.get_void_plan(uuid,text,uuid),public.submit_correction(uuid,jsonb,uuid),public.submit_proposal(uuid,jsonb,uuid),public.decide_proposal(uuid,boolean,text) to authenticated;

-- Reuse P4 fixed FX allocation; subtract member refunds from original eligibility.
create or replace function public.submit_settlement_batch(target_household uuid,payload_input jsonb,request_key uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  existing public.proposals; proposal_uuid uuid; batch_uuid uuid; recipient uuid;
  claim public.reimbursement_claims; item record; item_json jsonb; snapshot public.fx_rate_snapshots;
  original_sum numeric; reserved_sum numeric; paid_sum numeric;
  allocations_json jsonb:='[]'::jsonb; calculated jsonb; total bigint;
  payment_rate numeric; claim_rate numeric; denominator numeric; numerator numeric;
  cny numeric:=10000000000; hkd numeric:=10000000000;
begin
  perform public.require_active_household(target_household);
  -- The household lock is the common serialization point for cash/claim mutations.
  perform 1 from public.households where id=target_household and status='active' for update;
  if not found then raise exception 'household is archived'; end if;
  if request_key is null then raise exception 'idempotency key is required'; end if;
  select * into existing from public.proposals where household_id=target_household and submitter_id=auth.uid() and idempotency_key=request_key;
  if existing.id is not null then
    select id into batch_uuid from public.settlement_batches where proposal_id=existing.id;
    if batch_uuid is null or existing.payload->'request' is distinct from payload_input then raise exception '幂等键已被其他草稿使用'; end if;
    return batch_uuid;
  end if;
  if payload_input is null or jsonb_typeof(payload_input)<>'object' or exists(
    select 1 from jsonb_object_keys(payload_input) as keys(key)
    where key not in ('payeeMemberId','accountKind','currency','occurredAt','title','allocations')
  ) then raise exception 'invalid settlement payload'; end if;
  if jsonb_typeof(payload_input->'payeeMemberId') is distinct from 'string' then raise exception 'payee is required'; end if;
  recipient:=(payload_input->>'payeeMemberId')::uuid;
  if not exists(select 1 from public.household_members where household_id=target_household and user_id=recipient and active) then raise exception '收款人必须为活跃账本成员'; end if;
  if jsonb_typeof(payload_input->'currency') is distinct from 'string' or payload_input->>'currency' not in ('USD','CNY','HKD') then raise exception 'invalid currency'; end if;
  if jsonb_typeof(payload_input->'accountKind') is distinct from 'string' or not exists(select 1 from public.cash_accounts where household_id=target_household and kind=payload_input->>'accountKind') then raise exception 'cash account not found'; end if;
  if jsonb_typeof(payload_input->'title') is distinct from 'string' or coalesce(char_length(trim(payload_input->>'title')),0) not between 1 and 160 then raise exception 'invalid title'; end if;
  if jsonb_typeof(payload_input->'occurredAt') is distinct from 'string' or coalesce(payload_input->>'occurredAt','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid occurrence date'; end if;
  if (payload_input->>'occurredAt')::date>current_date then raise exception 'future entries cannot be posted'; end if;
  if jsonb_typeof(payload_input->'allocations') is distinct from 'array' then raise exception 'allocations are required'; end if;
  if jsonb_array_length(payload_input->'allocations') not between 1 and 100 then raise exception 'select 1 to 100 allocations'; end if;
  for item_json in select value from jsonb_array_elements(payload_input->'allocations') loop
    if jsonb_typeof(item_json)<>'object' or exists(select 1 from jsonb_object_keys(item_json) as keys(key) where key not in ('claimId','amountMinor','expectedVersion')) then raise exception 'invalid allocation fields'; end if;
    if jsonb_typeof(item_json->'claimId') is distinct from 'string' or jsonb_typeof(item_json->'amountMinor') is distinct from 'number' or
      jsonb_typeof(item_json->'expectedVersion') is distinct from 'number' then raise exception 'invalid allocation'; end if;
    perform (item_json->>'claimId')::uuid;
    if (item_json->>'amountMinor')::numeric<>trunc((item_json->>'amountMinor')::numeric) or (item_json->>'amountMinor')::numeric not between 1 and 9999999999 then raise exception 'invalid original amount'; end if;
    if (item_json->>'expectedVersion')::numeric<>trunc((item_json->>'expectedVersion')::numeric) or (item_json->>'expectedVersion')::numeric not between 1 and 9007199254740991 then raise exception 'invalid claim version'; end if;
  end loop;
  -- Lock once, merge repeated claims and validate against posted amounts + every live reservation.
  for item in
    select (value->>'claimId')::uuid as claim_id,sum((value->>'amountMinor')::numeric) as amount,
      min((value->>'expectedVersion')::bigint) as revision,max((value->>'expectedVersion')::bigint) as max_revision
    from jsonb_array_elements(payload_input->'allocations') group by 1 order by 1
  loop
    select * into claim from public.reimbursement_claims where id=item.claim_id and household_id=target_household for update;
    if claim.id is null or claim.claimant_id<>recipient then raise exception '不可报销无来源或其他成员的原单'; end if;
    if claim.status='voided' or not exists(select 1 from public.ledger_entries where id=claim.source_entry_id and status='posted' and entry_type='reimbursement' and payer_member_id=recipient) then raise exception '原单已失效'; end if;
    if claim.version<>item.revision or item.revision<>item.max_revision then raise exception '原单已变更，请刷新后重提'; end if;
    select coalesce(sum(a.amount_minor) filter(where a.status='posted' and e.status='posted'),0),
      coalesce(sum(a.amount_minor) filter(where a.status='reserved'),0)
    into paid_sum,reserved_sum from public.settlement_allocations a left join public.ledger_entries e on e.id=a.settlement_entry_id where a.claim_id=claim.id;
    if item.amount>claim.claimed_minor-claim.refunded_member_minor-paid_sum-reserved_sum then raise exception '原单可报销额度不足，可能已有待审批预留'; end if;
    allocations_json:=allocations_json||jsonb_build_array(jsonb_build_object('claimId',claim.id,'amountMinor',item.amount,'currency',claim.currency,'expectedVersion',claim.version));
  end loop;
  -- Foreign report/payment currencies need an approved snapshot; never use pending/manual legacy rates.
  if exists(select 1 from jsonb_array_elements(allocations_json) a where a->>'currency'<>payload_input->>'currency') or
    payload_input->>'currency'<>(select reporting_currency from public.households where id=target_household) then
    select * into snapshot from public.fx_rate_snapshots where household_id=target_household and status='approved' and effective_at<=now()
      order by effective_at desc,approved_at desc,id desc limit 1;
    if snapshot.id is null then raise exception '跨币种报销需要已确认汇率'; end if;
    cny:=snapshot.usd_to_cny*10000000000; hkd:=snapshot.usd_to_hkd*10000000000;
  end if;
  denominator:=10000000000*cny*hkd;
  payment_rate:=case payload_input->>'currency' when 'USD' then 10000000000 when 'CNY' then cny else hkd end;
  calculated:='[]'::jsonb;
  original_sum:=0;
  for item_json in select value from jsonb_array_elements(allocations_json) loop
    claim_rate:=case item_json->>'currency' when 'USD' then 10000000000 when 'CNY' then cny else hkd end;
    numerator:=(item_json->>'amountMinor')::numeric*payment_rate*div(denominator,claim_rate);
    original_sum:=original_sum+numerator;
    calculated:=calculated||jsonb_build_array(item_json||jsonb_build_object('floor',div(numerator,denominator),'remainder',mod(numerator,denominator)));
  end loop;
  total:=div(2*original_sum+denominator,2*denominator)::bigint;
  if total not between 1 and 9999999999 then raise exception '折算打款总额不足一分或超出限额'; end if;
  select jsonb_agg(value-'floor'-'remainder'||jsonb_build_object('paymentMinor',
    (value->>'floor')::numeric+case when rank<=(total-floors) then 1 else 0 end) order by value->>'claimId') into allocations_json
  from (select value,row_number() over(order by (value->>'remainder')::numeric desc,value->>'claimId') as rank,
    sum((value->>'floor')::numeric) over() as floors from jsonb_array_elements(calculated)) ranked;
  if exists(select 1 from jsonb_array_elements(allocations_json) a where (a->>'paymentMinor')::bigint<1) then raise exception '单笔折算打款不足一分，不能核销该原单'; end if;
  insert into public.proposals(household_id,submitter_id,idempotency_key,fx_snapshot_id,payload)
  values(target_household,auth.uid(),request_key,snapshot.id,jsonb_build_object('type','settlement','amountMinor',total,'currency',payload_input->>'currency',
    'accountKind',payload_input->>'accountKind','occurredAt',payload_input->>'occurredAt','title',trim(payload_input->>'title'),'payeeMemberId',recipient,'allocations',allocations_json,'request',payload_input)) returning id into proposal_uuid;
  insert into public.settlement_batches(household_id,proposal_id,claimant_id,account_kind,currency,amount_minor,fx_snapshot_id)
  values(target_household,proposal_uuid,recipient,payload_input->>'accountKind',payload_input->>'currency',total,snapshot.id) returning id into batch_uuid;
  insert into public.settlement_allocations(household_id,batch_id,claim_id,amount_minor,payment_minor,claim_version,status)
  select target_household,batch_uuid,(a->>'claimId')::uuid,(a->>'amountMinor')::bigint,(a->>'paymentMinor')::bigint,(a->>'expectedVersion')::bigint,'reserved'
  from jsonb_array_elements(allocations_json) a;
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail)
  values(target_household,auth.uid(),'reserve','settlement_batch',batch_uuid,jsonb_build_object('proposalId',proposal_uuid,'allocations',allocations_json));
  return batch_uuid;
end;
$$;

create or replace function public.decide_p4_proposal(proposal_uuid uuid,approve boolean,note text default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.proposals; batch public.settlement_batches; claim public.reimbursement_claims; allocation record;
  result_uuid uuid; next_sequence bigint; paid numeric; reserved numeric;
begin
  -- Same lock order as submitting and withdrawing: household, proposal, claims.
  select * into p from public.proposals where id=proposal_uuid;
  if p.id is null or not public.is_household_member(p.household_id) then raise exception 'not authorized'; end if;
  perform 1 from public.households where id=p.household_id for update;
  select * into p from public.proposals where id=proposal_uuid for update;
  if p.payload->>'type'<>'settlement' then return public.decide_p3_proposal(proposal_uuid,approve,note); end if;
  if p.submitter_id=auth.uid() then raise exception 'submitter cannot decide own proposal'; end if;
  if approve is null then raise exception 'decision is required'; end if;
  if note is not null and char_length(note)>500 then raise exception 'decision note is too long'; end if;
  select * into batch from public.settlement_batches where proposal_id=p.id for update;
  if batch.id is null then raise exception '旧报销缺少原单，请撤回后重新关联原单'; end if;
  if p.status='approved' and approve then return batch.ledger_entry_id; end if;
  if p.status='rejected' and not approve then return null; end if;
  if p.status not in ('pending_approval','overdue_pending') or batch.status<>'reserved' then raise exception 'proposal is not reviewable'; end if;
  if not approve then
    update public.settlement_allocations set status='released' where batch_id=batch.id and status='reserved';
    update public.settlement_batches set status='released' where id=batch.id;
    update public.proposals set status='rejected',decided_at=now(),decided_by=auth.uid(),decision_note=note where id=p.id;
    insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail) values(p.household_id,auth.uid(),'reject','settlement_batch',batch.id,jsonb_build_object('note',note));
    return null;
  end if;
  perform public.require_active_household(p.household_id);
  if (p.payload->>'occurredAt')::date>current_date then raise exception 'future entries cannot be posted'; end if;
  if not exists(select 1 from public.household_members where household_id=p.household_id and user_id=batch.claimant_id and active) then raise exception 'payee is no longer active'; end if;
  if not exists(select 1 from public.settlement_allocations where batch_id=batch.id and status='reserved') or
    batch.amount_minor<>(select sum(payment_minor) from public.settlement_allocations where batch_id=batch.id and status='reserved') then raise exception '批次核销明细不完整'; end if;
  for allocation in select * from public.settlement_allocations where batch_id=batch.id order by claim_id loop
    select * into claim from public.reimbursement_claims where id=allocation.claim_id and household_id=p.household_id for update;
    if claim.id is null or claim.status='voided' or claim.claimant_id<>batch.claimant_id or claim.version<>allocation.claim_version or allocation.status<>'reserved' then raise exception '原单已变更，请撤回后重提'; end if;
    if not exists(select 1 from public.ledger_entries where id=claim.source_entry_id and status='posted' and entry_type='reimbursement' and payer_member_id=batch.claimant_id) then raise exception '原单来源已失效'; end if;
    select coalesce(sum(a.amount_minor) filter(where a.status='posted' and e.status='posted'),0),coalesce(sum(a.amount_minor) filter(where a.status='reserved'),0)
    into paid,reserved from public.settlement_allocations a left join public.ledger_entries e on e.id=a.settlement_entry_id where a.claim_id=claim.id;
    if reserved>greatest(claim.claimed_minor-claim.refunded_member_minor-paid,0) then raise exception '原单额度不足，请撤回后重提'; end if;
  end loop;
  select greatest(coalesce((select max(effective_sequence) from public.ledger_entries where household_id=p.household_id),0),coalesce((select max(effective_sequence) from public.cash_transfers where household_id=p.household_id),0))+1 into next_sequence;
  insert into public.ledger_entries(household_id,proposal_id,entry_type,amount_minor,currency,occurred_at,effective_sequence,title,member_id,payee_member_id,account_kind,fx_snapshot_id)
  values(p.household_id,p.id,'settlement',batch.amount_minor,batch.currency,(p.payload->>'occurredAt')::date,next_sequence,p.payload->>'title',p.submitter_id,batch.claimant_id,batch.account_kind,batch.fx_snapshot_id) returning id into result_uuid;
  update public.settlement_allocations set status='posted',settlement_entry_id=result_uuid where batch_id=batch.id;
  update public.settlement_batches set status='posted',ledger_entry_id=result_uuid where id=batch.id;
  update public.reimbursement_claims c set status=case when c.claimed_minor-c.refunded_member_minor<=(select sum(a.amount_minor) from public.settlement_allocations a join public.ledger_entries e on e.id=a.settlement_entry_id where a.claim_id=c.id and a.status='posted' and e.status='posted') then 'settled' else 'partially_settled' end
  where c.id in (select claim_id from public.settlement_allocations where batch_id=batch.id);
  update public.proposals set status='approved',decided_at=now(),decided_by=auth.uid(),decision_note=note where id=p.id;
  insert into public.audit_logs(household_id,actor_id,action,entity_type,entity_id,detail) values(p.household_id,auth.uid(),'approve','settlement_batch',batch.id,jsonb_build_object('ledgerEntryId',result_uuid));
  return result_uuid;
end;
$$;
