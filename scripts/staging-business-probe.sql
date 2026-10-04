-- gongzhu-staging ONLY. No credentials, emails or permanent fixture records.
-- Requires a reference ledger with exactly two existing active members.
-- Executes actual PostgreSQL RPC/RLS under their identity claims, then ROLLBACK.
-- This is not a replacement for two independent browser/Auth sessions.
begin;
set local gongzhu.probe_reference_name = 'NewNiu';
do $probe$
declare
 reference_h uuid; a uuid; b uuid; h uuid; i uuid; p uuid; entry uuid;
 cross_h uuid; category_id uuid; category_name text; source uuid; probe_claim_id uuid; batch uuid;
 claim_version bigint; basis jsonb; ledger_version_input bigint; archive_id uuid;
 bank bigint; broker bigint; q bigint; common_cash bigint; debt bigint;
begin
 if (select count(*) from supabase_migrations.schema_migrations where version='20261004100000')<>1 then raise exception '19th migration required'; end if;
 if (select count(*) from public.households where name=current_setting('gongzhu.probe_reference_name'))<>1 then raise exception 'Reference ledger must be unique'; end if;
 select id,created_by into reference_h,a from public.households where name=current_setting('gongzhu.probe_reference_name');
 if (select count(*) from public.household_members where household_id=reference_h and active)<>2 then raise exception 'Two existing active members required'; end if;
 select user_id into b from public.household_members where household_id=reference_h and active and user_id<>a;
 if a is null or b is null then raise exception 'Two distinct actors required'; end if;
 perform set_config('request.jwt.claim.sub',a::text,true);
 set local role authenticated;
 h:=public.create_household('GongZhu rollback-only acceptance probe','USD','America/New_York');
 reset role;
 insert into public.household_members(household_id,user_id,role) values(h,b,'member');
 set local role authenticated;
 select id,name into category_id,category_name from public.spending_categories where household_id=h and name='旅行';
 i:=public.create_investment_direct(h,'Rollback-only ETF','PROBE','ETF','USD','份','disposable validation','weekly');
 -- Both actors contribute 300. Approval always belongs to the peer.
 p:=public.submit_proposal(h,jsonb_build_object('type','deposit','amountMinor',30000,'currency','USD','occurredAt','2026-09-01','title','Probe A deposit','accountKind','bank','payerMemberId',a),gen_random_uuid());
 begin perform public.decide_proposal(p,true,null); raise exception 'Self-approval unexpectedly succeeded'; exception when others then if position('submitter cannot' in sqlerrm)=0 then raise; end if; end;
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.decide_proposal(p,true,null);
 p:=public.submit_proposal(h,jsonb_build_object('type','deposit','amountMinor',30000,'currency','USD','occurredAt','2026-09-01','title','Probe B deposit','accountKind','bank','payerMemberId',b),gen_random_uuid());
 perform set_config('request.jwt.claim.sub',a::text,true); perform public.decide_proposal(p,true,null);
 p:=public.submit_proposal(h,jsonb_build_object('type','expense','amountMinor',10000,'currency','USD','occurredAt','2026-09-02','title','Probe expense','accountKind','bank','categoryId',category_id,'category',category_name),gen_random_uuid());
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.decide_proposal(p,true,null);
 -- B records A's personal advance. The debt must belong to A.
 p:=public.submit_proposal(h,jsonb_build_object('type','reimbursement','amountMinor',12000,'currency','USD','occurredAt','2026-09-03','title','Probe personal advance','payerMemberId',a,'categoryId',category_id,'category',category_name),gen_random_uuid());
 perform set_config('request.jwt.claim.sub',a::text,true); source:=public.decide_proposal(p,true,null);
 select id,version into probe_claim_id,claim_version from public.reimbursement_claims where source_entry_id=source and claimant_id=a;
 if probe_claim_id is null then raise exception 'Actual payer was lost'; end if;
 batch:=public.submit_settlement_batch(h,jsonb_build_object('payeeMemberId',a,'accountKind','bank','currency','USD','occurredAt','2026-09-04','title','Probe partial reimbursement','allocations',jsonb_build_array(jsonb_build_object('claimId',probe_claim_id,'amountMinor',5000,'expectedVersion',claim_version))),gen_random_uuid());
 select proposal_id into p from public.settlement_batches where id=batch;
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.decide_proposal(p,true,null);
 perform set_config('request.jwt.claim.sub',a::text,true);
 p:=public.submit_proposal(h,jsonb_build_object('type','investment_buy','amountMinor',20000,'currency','USD','occurredAt','2026-09-05','title','Probe funding and buy','investmentId',i,'quantityMicro',20000000,'funding',jsonb_build_object('currency','USD','amountMinor',20000,'destinationAmountMinor',20000,'occurredAt','2026-09-05')),gen_random_uuid());
 perform set_config('request.jwt.claim.sub',b::text,true); entry:=public.decide_proposal(p,true,null);
 if public.decide_proposal(p,true,null)<>entry then raise exception 'Repeated decision is not idempotent'; end if;
 if (select count(*) from public.cash_transfers where proposal_id=p)<>1 or (select count(*) from public.ledger_entries where proposal_id=p)<>1 then raise exception 'Funding/buy duplicated'; end if;
 perform set_config('request.jwt.claim.sub',a::text,true);
 basis:=public.get_investment_basis(i,'2026-09-06');
 p:=public.submit_proposal(h,jsonb_build_object('type','investment_valuation','amountMinor',0,'currency','USD','occurredAt','2026-09-06','title','Probe valuation','investmentId',i,'valuationMode','unit_price','unitValueHundredMillionths',1200000000,'basis',basis),gen_random_uuid());
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.decide_proposal(p,true,null);
 perform set_config('request.jwt.claim.sub',a::text,true);
 p:=public.submit_proposal(h,jsonb_build_object('type','investment_sell','amountMinor',7000,'currency','USD','occurredAt','2026-09-07','title','Probe sell','investmentId',i,'quantityMicro',5000000),gen_random_uuid());
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.decide_proposal(p,true,null);
 perform set_config('request.jwt.claim.sub',a::text,true);
 p:=public.submit_proposal(h,jsonb_build_object('type','dividend','amountMinor',500,'currency','USD','occurredAt','2026-09-08','title','Probe dividend','investmentId',i),gen_random_uuid());
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.decide_proposal(p,true,null);
 perform set_config('request.jwt.claim.sub',a::text,true);
 select version into claim_version from public.reimbursement_claims where id=probe_claim_id;
 batch:=public.submit_settlement_batch(h,jsonb_build_object('payeeMemberId',a,'accountKind','bank','currency','USD','occurredAt','2026-09-09','title','Probe final reimbursement','allocations',jsonb_build_array(jsonb_build_object('claimId',probe_claim_id,'amountMinor',7000,'expectedVersion',claim_version))),gen_random_uuid());
 select proposal_id into p from public.settlement_batches where id=batch;
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.decide_proposal(p,true,null);
 select sum(case when entry_type in ('deposit','investment_sell','dividend') then amount_minor when entry_type in ('expense','settlement','investment_buy') then -amount_minor else 0 end) into common_cash from public.ledger_entries where household_id=h and status='posted';
 select sum(case entry_type when 'investment_buy' then quantity_micro when 'investment_sell' then -quantity_micro else 0 end) into q from public.ledger_entries where investment_id=i and status='posted';
 select c.claimed_minor-coalesce(sum(s.amount_minor) filter(where s.status='posted'),0) into debt from public.reimbursement_claims c left join public.settlement_allocations s on s.claim_id=c.id where c.id=probe_claim_id group by c.claimed_minor;
 select sum(case when entry_type='deposit' then amount_minor when entry_type in ('expense','settlement') then -amount_minor else 0 end)-(select sum(amount_minor) from public.cash_transfers where household_id=h and status='posted') into bank from public.ledger_entries where household_id=h and status='posted';
 broker:=common_cash-bank;
 if bank<>18000 or broker<>7500 or common_cash<>25500 or q<>15000000 or debt<>0 or common_cash+(q*1200/1000000)-debt<>43500 then raise exception 'PRD 15.1 final reconciliation failed'; end if;
 if (select sum(amount_minor) from public.ledger_entries where household_id=h and entry_type in ('expense','reimbursement') and status='posted')<>22000 then raise exception 'Repayments incorrectly counted as consumption'; end if;
 -- Cross-currency partial repayment, personal refund and return use a second
 -- disposable ledger. USD cash/payment and CNY original debt remain separate.
 perform set_config('request.jwt.claim.sub',a::text,true);
 cross_h:=public.create_household('GongZhu rollback-only FX probe','USD','America/New_York');
 reset role;
 insert into public.household_members(household_id,user_id,role) values(cross_h,b,'member');
 set local role authenticated;
 select id,name into category_id,category_name from public.spending_categories where household_id=cross_h and name='旅行';
 p:=public.submit_proposal(cross_h,jsonb_build_object('type','fx_rate_update','amountMinor',0,'currency','USD','occurredAt','2026-09-01','title','Probe FX','effectiveAt','2026-09-01T00:00:00Z','usdToCny','7.2','usdToHkd','7.8','sourceNote','Isolated staging validation'),gen_random_uuid());
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.decide_proposal(p,true,null);
 p:=public.submit_proposal(cross_h,jsonb_build_object('type','reimbursement','amountMinor',72000,'currency','CNY','occurredAt','2026-09-01','title','Probe CNY advance','payerMemberId',a,'categoryId',category_id,'category',category_name),gen_random_uuid());
 perform set_config('request.jwt.claim.sub',a::text,true); source:=public.decide_proposal(p,true,null);
 select id,version into probe_claim_id,claim_version from public.reimbursement_claims where source_entry_id=source;
 batch:=public.submit_settlement_batch(cross_h,jsonb_build_object('payeeMemberId',a,'accountKind','bank','currency','USD','occurredAt','2026-09-02','title','Probe USD payment','allocations',jsonb_build_array(jsonb_build_object('claimId',probe_claim_id,'amountMinor',36000,'expectedVersion',claim_version))),gen_random_uuid());
 select proposal_id into p from public.settlement_batches where id=batch;
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.decide_proposal(p,true,null);
 if not exists(select 1 from public.settlement_batches where id=batch and amount_minor=5000 and currency='USD' and status='posted') then raise exception 'Cross-currency payment incorrect'; end if;
 if (select sum(amount_minor) from public.settlement_allocations where claim_id=probe_claim_id and status='posted')<>36000 then raise exception 'Original CNY allocation lost'; end if;
 perform set_config('request.jwt.claim.sub',a::text,true);
 p:=public.submit_correction(cross_h,jsonb_build_object('type','expense_refund','sourceEntryId',source,'amountMinor',50000,'recipient','member','occurredAt','2026-09-03','title','Probe personal refund'),gen_random_uuid());
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.decide_proposal(p,true,null);
 perform set_config('request.jwt.claim.sub',a::text,true);
 select version into claim_version from public.reimbursement_claims where id=probe_claim_id;
 p:=public.submit_correction(cross_h,jsonb_build_object('type','member_return','claimId',probe_claim_id,'originalAmountMinor',14000,'expectedVersion',claim_version,'currency','CNY','accountKind','bank','occurredAt','2026-09-04','title','Probe return'),gen_random_uuid());
 perform set_config('request.jwt.claim.sub',b::text,true); entry:=public.decide_proposal(p,true,null);
 if not exists(select 1 from public.ledger_entries where id=entry and entry_type='member_return' and amount_minor=14000 and currency='CNY' and recovery_original_minor=14000) then raise exception 'Return currency or amount incorrect'; end if;
 if not exists(select 1 from public.reimbursement_claims where id=probe_claim_id and refunded_member_minor=50000 and returned_minor=14000 and status='settled') then raise exception 'Refund/return claim did not converge'; end if;
 -- A separate fresh deposit is approved and voided. It must disappear from
 -- posted cash exactly once while the audit trail and raw row remain.
 perform set_config('request.jwt.claim.sub',a::text,true);
 p:=public.submit_proposal(h,jsonb_build_object('type','deposit','amountMinor',100,'currency','USD','occurredAt','2026-09-10','title','Probe void candidate','payerMemberId',a,'accountKind','bank'),gen_random_uuid());
 perform set_config('request.jwt.claim.sub',b::text,true); entry:=public.decide_proposal(p,true,null);
 perform set_config('request.jwt.claim.sub',a::text,true);
 p:=public.submit_correction(h,jsonb_build_object('type','void_record','targetKind','entry','targetId',entry,'reason','Rollback-only void validation'),gen_random_uuid());
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.decide_proposal(p,true,null);
 if not exists(select 1 from public.ledger_entries where id=entry and status='voided' and void_proposal_id=p) then raise exception 'Void did not preserve raw trace'; end if;
 -- RLS outsider cannot read the fixture and cannot access member RPCs.
 perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
 if exists(select 1 from public.ledger_entries where household_id=h) then raise exception 'Outsider read leaked'; end if;
 begin perform public.get_household_management_plan(h); raise exception 'Outsider RPC unexpectedly succeeded'; exception when others then if position('not authorized' in sqlerrm)=0 then raise; end if; end;
 perform set_config('request.jwt.claim.sub',a::text,true);
 select ledger_version into ledger_version_input from public.households where id=h;
 p:=public.submit_household_management(h,'archive','Rollback-only acceptance',ledger_version_input,gen_random_uuid());
 perform set_config('request.jwt.claim.sub',b::text,true); archive_id:=public.decide_proposal(p,true,null);
 if not exists(select 1 from public.household_archives where id=archive_id and household_id=h) then raise exception 'Frozen snapshot missing'; end if;
 perform set_config('request.jwt.claim.sub',a::text,true);
 begin perform public.submit_proposal(h,jsonb_build_object('type','deposit','amountMinor',1,'currency','USD','occurredAt','2026-09-09','title','Archived write','payerMemberId',a,'accountKind','bank'),gen_random_uuid()); raise exception 'Archived write unexpectedly succeeded'; exception when others then if position('archived' in sqlerrm)=0 then raise; end if; end;
 select ledger_version into ledger_version_input from public.households where id=h;
 p:=public.submit_household_management(h,'restore','Rollback-only recovery',ledger_version_input,gen_random_uuid());
 perform set_config('request.jwt.claim.sub',b::text,true); perform public.decide_proposal(p,true,null);
 if not exists(select 1 from public.households where id=h and status='active') then raise exception 'Restore did not activate'; end if;
 if not exists(select 1 from public.household_archives where id=archive_id) then raise exception 'Restore erased snapshot'; end if;
 reset role;
 raise notice 'PASS real staging RPC/RLS: peer approval, idempotent funding/buy, actual payer debt, PRD435/consumption220, cross-currency settlement/refund/return, void, outsider isolation, archive/restore';
end $probe$;
rollback;
select not exists(select 1 from public.households where name in ('GongZhu rollback-only acceptance probe','GongZhu rollback-only FX probe')) as probe_records_rolled_back,
 (select count(*) from supabase_migrations.schema_migrations) as installed_migrations,
 'RPC/RLS probe completed; Auth/browser E2E is a separate check' as evidence_scope;
