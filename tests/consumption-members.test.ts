import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect} from 'vitest';
import {filterLedgerActivity,normalizeLedgerFilters} from '@/lib/domain/ledger-filters';
import {ledgerEventFromRow} from '@/lib/domain/ledger-adapter';
import {proposalSchema} from '@/lib/validation/proposal';
import {buildSpendingReport} from '@/lib/domain/spending-report';
import {accountCashBalances} from '@/lib/domain/account-balances';
import {ConsumerSelect,Ledger} from '@/app/app/app-client';
const A='00000000-0000-4000-8000-000000000001', B='00000000-0000-4000-8000-000000000002';
const members=[{user_id:A,profiles:{display_name:'Ariel'}},{user_id:B,profiles:{display_name:'James'}}];
const base={id:A,entry_type:'reimbursement',status:'posted',amount_minor:1000,currency:'USD',occurred_at:'2026-09-02',created_at:'2026-09-02T00:00:00Z',title:'A pays for B',payer_member_id:A,consumer_scope:'member',consumer_member_id:B};
const proposal={householdId:A,idempotencyKey:B,type:'reimbursement',amountMinor:1000,currency:'USD',occurredAt:'2026-09-02',title:'A pays for B',payerMemberId:A,category:'餐饮',categoryId:A};
describe('付款人与消费人独立',()=>{
 it('个人筛选只包含明确个人消费；共同、未知和非消费各自隔离',()=>{
  const rows=[base,{...base,id:'shared',consumer_scope:'common',consumer_member_id:null},{...base,id:'legacy',consumer_scope:null,consumer_member_id:null,member_id:B},{...base,id:'deposit',entry_type:'deposit',consumer_scope:null,consumer_member_id:null}];
  expect(filterLedgerActivity(rows,normalizeLedgerFilters({payer:A,consumer:B}))).toEqual([base]);
  expect(filterLedgerActivity(rows,normalizeLedgerFilters({payer:B}))).toEqual([]);
  expect(filterLedgerActivity(rows,normalizeLedgerFilters({consumer:'common'})).map(x=>x.id)).toEqual(['shared']);
  expect(filterLedgerActivity(rows,normalizeLedgerFilters({consumer:'unrecorded'})).map(x=>x.id)).toEqual(['legacy']);
  expect(normalizeLedgerFilters({payer:'bad',consumer:['common']})).toMatchObject({payer:'',consumer:''});
 });
 it('共同账户、个人实际付款人和提交人不会混淆',()=>{
  const expense={...base,entry_type:'expense',payer_member_id:null,member_id:B};
  expect(filterLedgerActivity([expense],normalizeLedgerFilters({payer:B}))).toEqual([]);
  expect(filterLedgerActivity([expense],normalizeLedgerFilters({payer:'common'}))).toEqual([expense]);
 });
 it('新消费载荷校验成对字段，旧提案兼容；其他事件拒绝消费人',()=>{
  expect(proposalSchema.safeParse({...proposal,consumerScope:'member',consumerMemberId:B}).success).toBe(true);
  expect(proposalSchema.safeParse({...proposal,consumerScope:'common'}).success).toBe(true);
  expect(proposalSchema.safeParse(proposal).success).toBe(true);
  for(const extra of [{consumerScope:'member'},{consumerScope:'common',consumerMemberId:A},{consumerMemberId:A}]) expect(proposalSchema.safeParse({...proposal,...extra}).success).toBe(false);
  expect(proposalSchema.safeParse({...proposal,type:'deposit',category:undefined,categoryId:undefined,consumerScope:'common'}).success).toBe(false);
 });
 it('消费归属不改变账户余额；退款分析沿用原单，未知历史不推断',()=>{
  const original=ledgerEventFromRow({...base,entry_type:'expense',account_kind:'bank',payer_member_id:null});
  const legacy=ledgerEventFromRow({...base,consumer_scope:null,consumer_member_id:null});expect(legacy.consumerMemberId).toBeUndefined();
  expect(accountCashBalances([original],[])).toEqual(accountCashBalances([{...original,consumerScope:undefined,consumerMemberId:undefined}],[]));
  const refund={...original,id:B,type:'expense_refund' as const,amountMinor:200,refundSourceEntryId:A,consumerScope:undefined,consumerMemberId:undefined};
  const report=buildSpendingReport([original,refund],'USD',{},normalizeLedgerFilters({consumer:B}));
  expect(report.records).toHaveLength(2);expect(report.netMinor).toBe(800);
 });
 it('录入选择明确、记录同时显示两种归属、分页保留组合筛选',()=>{
  const form=renderToStaticMarkup(createElement(ConsumerSelect,{members,userId:A,value:'',onChange:()=>{}}));
  expect(form).toContain('Ariel（我）');expect(form).toContain('James（伴侣）');expect(form).toContain('共同消费');expect(form).toContain('required');
  const html=renderToStaticMarkup(createElement(Ledger,{members,entries:[base,{...base,id:B,consumer_scope:null,consumer_member_id:null}],currency:'USD',totalEntries:201,page:1,pageCount:3,filters:normalizeLedgerFilters({payer:A,consumer:B})}));
  expect(html).toContain('name="payer"');expect(html).toContain('name="consumer"');expect(html).toContain('实际付款人：Ariel');expect(html).toContain('消费人：James');expect(html).toContain('消费人：未记录');expect(html).toContain(`payer=${A}&amp;consumer=${B}`);
 });
});
