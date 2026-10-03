import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect} from 'vitest';
import {cashImpact,expenseTotalReporting,type LedgerEvent} from '@/lib/domain/balance-calculations';
import {accountCashBalances} from '@/lib/domain/account-balances';
import {reimbursementClaimFromRows} from '@/lib/domain/reimbursement-claims';
import {projectReimbursements} from '@/lib/domain/settlement-batches';
import {filterLedgerActivity,emptyLedgerFilters} from '@/lib/domain/ledger-filters';
import {correctionSchema} from '@/lib/validation/correction';
import {CorrectionDetails} from '@/app/app/correction-modal';
import ReimbursementCenter from '@/app/app/reimbursement-center';
import {buildInvestmentSnapshot} from '@/lib/domain/investment-snapshot';
import {Ledger} from '@/app/app/app-client';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const source:LedgerEvent={id:id(1),type:'reimbursement',currency:'USD',amountMinor:30000,status:'posted',occurredAt:'2026-09-01',payerMemberId:id(2),title:'旅行代付',category:'交通'};
const row={id:id(3),source_entry_id:source.id,claimant_id:id(2),currency:'USD',claimed_minor:30000,status:'settled',created_at:'2026-09-01T00:00:00Z',version:2};
const refund:LedgerEvent={...source,id:id(4),type:'expense_refund',amountMinor:10000,refundSourceEntryId:source.id,refundRecipient:'member'};
const returned:LedgerEvent={...source,id:id(5),type:'member_return',amountMinor:10000,recoveryClaimId:row.id,recoveryOriginalMinor:10000,accountKind:'bank'};
describe('P6 source corrections and audited void projection',()=>{
 it('voided payment retains approved history and restores every original amount',()=>{
  const payment:LedgerEvent={...source,id:id(6),type:'settlement',status:'voided',payeeMemberId:id(2),accountKind:'bank'};
  const allocation={id:id(7),household_id:id(8),claim_id:row.id,batch_id:id(9),settlement_entry_id:payment.id,amount_minor:30000,payment_minor:30000,claim_version:1,status:'voided',created_at:row.created_at};
  const batch={id:id(9),proposal_id:id(10),claimant_id:id(2),account_kind:'bank',currency:'USD',amount_minor:30000,ledger_entry_id:payment.id,fx_snapshot_id:null,status:'voided',created_at:row.created_at};
  const p={id:id(10),submitter_id:id(2),status:'approved',payload:{title:'original payment',occurredAt:'2026-09-01'}};
  const result=projectReimbursements([row],[allocation],[batch],[p],[source,payment]);expect(result.claims[0]).toMatchObject({settledMinor:0,remainingMinor:30000});expect(result.batches[0].status).toBe('voided');
 });
 it('voiding the latest valuation falls back to an earlier valid valuation or cost',()=>{
  const investment={id:id(11),opening_quantity_milli:0,opening_cost_minor:0};const buy:LedgerEvent={...source,type:'investment_buy',investmentId:id(11),quantityMicro:1000000};const v={id:id(12),investment_id:id(11),value_date:'2026-09-02',created_at:row.created_at,unit_value_minor:40000,unit_value_1e4:4000000};
  expect(buildInvestmentSnapshot([buy],investment,[{...v,status:'voided'}]).valuation.marketMinor).toBe(30000);expect(buildInvestmentSnapshot([buy],investment,[{...v,id:id(13),value_date:'2026-09-01',unit_value_minor:35000,unit_value_1e4:3500000},{...v,status:'voided'}]).valuation.marketMinor).toBe(35000);
 });
 it('voiding a deposit can leave negative cash; never invents balancing funds',()=>{
  const events:LedgerEvent[]=[{...source,type:'deposit',status:'voided'}, {...source,id:id(14),type:'expense',amountMinor:5000,accountKind:'bank'}];expect(accountCashBalances(events).bank.USD).toBe(-5000);
 });
 it('refund source and void approval remain navigable after ledger pagination',()=>{
  const entry={id:id(4),entry_type:'expense_refund',status:'voided',amount_minor:10000,currency:'USD',occurred_at:'2026-09-02',title:'refund',refund_source_entry_id:source.id,void_proposal_id:id(15)};
  const html=renderToStaticMarkup(createElement(Ledger,{entries:[entry],totalEntries:1,currency:'USD',members:[],householdId:id(8)}));expect(html).toContain(`entry=${source.id}`);expect(html).toContain(`#approval-${id(15)}`);expect(html).toContain('全部流水');
 });
 it('personal refund reduces consumption, leaves common cash unchanged; return only restores cash',()=>{
  expect(cashImpact(refund)).toBe(0);expect(cashImpact(returned)).toBe(10000);expect(expenseTotalReporting([source,refund,returned],'USD',{USD:1,CNY:7.2,HKD:7.8})).toBe(20000);expect(accountCashBalances([source,refund,returned]).bank.USD).toBe(10000);
 });
 it('common refund increases cash and keeps original member eligibility unchanged',()=>{
  const events=[source,{...refund,refundRecipient:'common' as const,accountKind:'bank' as const}];expect(accountCashBalances(events).bank.USD).toBe(10000);expect(projectReimbursements([row],[],[],[],events).claims[0]).toMatchObject({refundedMemberMinor:0,effectiveMinor:30000,remainingMinor:30000});
 });
 it('G300/S300/F100 creates 100 recovery; returned100 extinguishes it',()=>{
  expect(reimbursementClaimFromRows(row,source,30000,0,{refundedMemberMinor:10000})).toMatchObject({effectiveMinor:20000,remainingMinor:0,recoveryMinor:10000});expect(reimbursementClaimFromRows(row,source,30000,0,{refundedMemberMinor:10000,returnedMinor:10000})).toMatchObject({recoveryMinor:0});
 });
 it('AC63 paid100/refunded250/original300 has recovery50, zero payable',()=>{
  expect(reimbursementClaimFromRows(row,source,10000,0,{refundedMemberMinor:25000})).toMatchObject({effectiveMinor:5000,remainingMinor:0,recoveryMinor:5000});
 });
 it('return reservation is a subset of recovery, overdue retained, withdrawn released',()=>{
  const payment:LedgerEvent={...source,id:id(6),type:'settlement',amountMinor:30000};const allocation={id:id(7),household_id:id(8),claim_id:row.id,batch_id:null,settlement_entry_id:payment.id,amount_minor:30000,payment_minor:null,claim_version:null,status:'posted',created_at:row.created_at};const p={id:id(9),status:'overdue_pending',payload:{type:'member_return',claimId:row.id,originalAmountMinor:6000}};
  const project=(status:string)=>projectReimbursements([row],[allocation],[],[{...p,status}],[source,payment,refund]).claims[0];expect(project('overdue_pending')).toMatchObject({recoveryMinor:10000,returnReservedMinor:6000,returnAvailableMinor:4000});expect(project('withdrawn').returnAvailableMinor).toBe(10000);
 });
 it('refund conflicts with ordinary reservations; returns never exceed formed debt',()=>{
  expect(()=>reimbursementClaimFromRows(row,source,0,24000,{refundedMemberMinor:10000})).toThrow('预留');expect(()=>reimbursementClaimFromRows(row,source,30000,0,{refundedMemberMinor:10000,returnedMinor:10001})).toThrow('退款返还');expect(()=>reimbursementClaimFromRows(row,source,30000,0,{refundedMemberMinor:10000,returnReservedMinor:10001})).toThrow('退款返还');
 });
 it('fully refunded original has no unpaid debt; no division by zero on claim UI',()=>{
  const claim=reimbursementClaimFromRows(row,source,0,0,{refundedMemberMinor:30000});expect(claim.state).toBe('fully_refunded');const html=renderToStaticMarkup(createElement(ReimbursementCenter,{householdId:id(8),userId:id(2),claims:[claim],batches:[],proposals:[],members:[],refresh:()=>{},notify:()=>{}}));expect(html).toContain('已全额退款');expect(html).not.toContain('NaN');expect(html).not.toContain('报销这笔');
 });
 it('void refunds and returns retain history but cease affecting cash or consumption',()=>{
  const events=[source,{...refund,status:'voided' as const},{...returned,status:'voided' as const}];expect(expenseTotalReporting(events,'USD',{USD:1,CNY:7.2,HKD:7.8})).toBe(30000);expect(accountCashBalances(events).bank.USD).toBe(0);expect(projectReimbursements([row],[],[],[],events).claims[0]).toMatchObject({refundedMemberMinor:0,returnedMinor:0,financialHistory:expect.arrayContaining([expect.objectContaining({status:'voided'})])});
 });
 it('refund filter follows original payment source regardless of refund recipient',()=>{
  const rows=[{id:'a',entry_type:'expense_refund',payer_member_id:id(2),refund_recipient:'common'},{id:'b',entry_type:'expense_refund',payer_member_id:null}];expect(filterLedgerActivity(rows,{...emptyLedgerFilters,payment:'member'}).map(r=>r.id)).toEqual(['a']);expect(filterLedgerActivity(rows,{...emptyLedgerFilters,payment:'joint'}).map(r=>r.id)).toEqual(['b']);
 });
 it('API input forbids currency/use spoofing, personal account and missing source/reason',()=>{
  const p={type:'expense_refund',sourceEntryId:id(1),amountMinor:1,recipient:'member',title:'refund',occurredAt:'2026-09-01'};expect(correctionSchema.safeParse(p).success).toBe(true);for(const extra of [{currency:'CNY'},{category:'伪造'},{accountKind:'bank'}])expect(correctionSchema.safeParse({...p,...extra}).success).toBe(false);expect(correctionSchema.safeParse({...p,sourceEntryId:undefined}).success).toBe(false);expect(correctionSchema.safeParse({type:'void_record',targetKind:'entry',targetId:id(1),reason:' '} ).success).toBe(false);
 });
 it('correction approval explains personal cash, original vs received return and separate replacement',()=>{
  const html=renderToStaticMarkup(createElement(CorrectionDetails,{payload:{type:'member_return',claimId:row.id,originalAmountMinor:36000,originalCurrency:'CNY',amountMinor:5000,currency:'USD',accountKind:'bank'}}));expect(html).toContain('CNY 360.00');expect(html).toContain('USD 50.00');expect(html).toContain('不增加贡献');const voidHtml=renderToStaticMarkup(createElement(CorrectionDetails,{payload:{type:'void_record',reason:'录错',replacementPayload:{},impact:{entries:[],transfers:[],valuations:[],cashEffects:[{account:'bank',currency:'USD',deltaMinor:10000}],claimEffects:[{id:row.id,currency:'USD',beforeOutstanding:0,afterOutstanding:30000,beforeRecovery:0,afterRecovery:0}]}}}));expect(voidHtml).toContain('+USD 100.00');expect(voidHtml).toContain('0 → 300');expect(voidHtml).toContain('独立审批');
 });
});
