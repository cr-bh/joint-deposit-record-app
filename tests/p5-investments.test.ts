import { describe,it,expect } from 'vitest';
import {calculateInvestmentPosition,valuePosition} from '@/lib/domain/investment-calculations';
import {buildInvestmentSnapshot,investmentBasis,investmentAllocation,positionReturn,valuationDue} from '@/lib/domain/investment-snapshot';
import {proposalSchema} from '@/lib/validation/proposal';
import {parseFixedDecimal} from '@/lib/domain/fixed-decimal';
import type {LedgerEvent} from '@/lib/domain/balance-calculations';
import type {FxRateSnapshot} from '@/lib/domain/fx-rates';
const id='00000000-0000-4000-8000-000000000001';
const investment={id,opening_quantity_milli:0,opening_cost_minor:0};
const trade=(type:LedgerEvent['type'],q:number,amount:number,date='2026-09-01',seq='1'):LedgerEvent=>({id:`event-${seq}`,type,status:'posted',investmentId:id,currency:'USD',quantityMicro:q,amountMinor:amount,occurredAt:date,effectiveSequence:seq});
const fx={usdToCny:7.2,usdToHkd:7.8} as FxRateSnapshot;
const v=(events:LedgerEvent[],total:number,date='2026-09-01',seq='1')=>{const b=investmentBasis(events,id,date,seq);return {id:'value',investment_id:id,value_date:date,created_at:'2026-09-03T00:00:00Z',input_mode:'total_market',quantity_micro:b.quantityMicro,total_value_minor:total,basis_signature:b.signature,basis_through_sequence:seq,effective_sequence:'2',unit_value_1e4:0,unit_value_1e8:0};};
describe('P5 investment accounting',()=>{
 it('uses exact six-decimal shares and net receipts; moving cost survives partial disposal',()=>{
  const events=[trade('investment_buy',100000000,100000),trade('investment_buy',50000000,60000,'2026-09-02','2')];
  const b=v(events,180000,'2026-09-02','2');const before=buildInvestmentSnapshot(events,investment,[b]);
  expect(positionReturn(before.position,before.valuation).percent).toBe(12.5);
  events.push(trade('investment_sell',60000000,78000,'2026-09-04','3'));const after=buildInvestmentSnapshot(events,investment,[b]);
  expect(after.position).toMatchObject({quantityMicro:90000000,remainingCostMinor:96000,realizedGainMinor:14000});expect(after.valuation.marketMinor).toBe(108000);expect(positionReturn(after.position,after.valuation).percent).toBe(12.5);
 });
 it('retains the raw valuation ratio; rounds once at the final cent',()=>{
  const events=[trade('investment_buy',3000000,100)];const row=v(events,1);events.push(trade('investment_buy',3000000,100,'2026-09-04','3'));
  expect(buildInvestmentSnapshot(events,investment,[row]).valuation.marketMinor).toBe(2);
  expect(parseFixedDecimal('0.000001',6)).toBe(1);expect(parseFixedDecimal('0.00000001',8)).toBe(1);
  expect(calculateInvestmentPosition([trade('investment_buy',1,1),trade('investment_sell',1,0,'2026-09-02','2')],id)).toMatchObject({quantityMicro:0,remainingCostMinor:0,realizedGainMinor:-1});
 });
 it('zero manual valuation means -100%; closed and zero cost have no percentage',()=>{
  const events=[trade('investment_buy',1000000,500)];const snapshot=buildInvestmentSnapshot(events,investment,[v(events,0)]);expect(snapshot.valuation.marketMinor).toBe(0);expect(positionReturn(snapshot.position,snapshot.valuation).percent).toBe(-100);
  const closed=calculateInvestmentPosition([...events,trade('investment_sell',1000000,600,'2026-09-02','3')],id);expect(positionReturn(closed,valuePosition(closed)).label).toBe('已清仓');expect(positionReturn({...closed,quantityMilli:1000},valuePosition({...closed,quantityMilli:1000})).label).toBe('无成本基数');
 });
 it('full close and rebuy start a fresh valuation cycle; realized gain remains',()=>{
  const events=[trade('investment_buy',1000000,500)];const row=v(events,700);events.push(trade('investment_sell',1000000,600,'2026-09-02','3'),trade('investment_buy',2000000,800,'2026-09-03','4'));
  const snapshot=buildInvestmentSnapshot(events,investment,[row]);expect(snapshot.valuation).toMatchObject({marketMinor:800,source:'cost_estimate'});expect(snapshot.position.realizedGainMinor).toBe(100);expect(positionReturn(snapshot.position,snapshot.valuation).percent).toBeNull();
 });
 it('rejects stale valuation history and a backdated oversell that breaks later holdings',()=>{
  const events=[trade('investment_buy',1000000,500,'2026-09-02')];const row=v(events,600,'2026-09-02');events.push(trade('investment_buy',1000000,500,'2026-09-01','3'));
  expect(()=>buildInvestmentSnapshot(events,investment,[row])).toThrow('待核对');
  expect(()=>calculateInvestmentPosition([trade('investment_buy',1000000,500),trade('investment_sell',1000000,600,'2026-09-03','2'),trade('investment_sell',1,1,'2026-09-02','3')],id)).toThrow('超过当时持仓');
 });
 it('uses eight-decimal unit prices and clears cost tail across three full disposals',()=>{
  const position=calculateInvestmentPosition([trade('investment_buy',600000000,100)],id);expect(valuePosition(position,{id:'v',valueDate:'2026-09-01',createdAt:'2026-09-01T00:00:00Z',unitValueTenThousandths:0,inputMode:'unit_price',unitValueHundredMillionths:834}).marketMinor).toBe(1);
  const events=[trade('investment_buy',3000000,10000)],costs:number[]=[];for(let n=1;n<=3;n++){events.push(trade('investment_sell',1000000,4000,'2026-09-02',String(n+1)));costs.push(calculateInvestmentPosition(events,id).remainingCostMinor);}expect(costs).toEqual([6667,3333,0]);
 });
 it('excludes realized gains and dividends from the position return',()=>{const events=[trade('investment_buy',1000000,10000)];const row=v(events,12000);events.push(trade('dividend',0,3000,'2026-09-03','3'));const snapshot=buildInvestmentSnapshot(events,investment,[row]);expect(snapshot.position.dividendMinor).toBe(3000);expect(positionReturn(snapshot.position,snapshot.valuation).percent).toBe(20);});
 it('applies weekly Monday and calendar-month reminder boundaries',()=>{
  expect(valuationDue('weekly','2026-09-27','2026-09-28')).toBe(true);expect(valuationDue('weekly','2026-09-28','2026-10-03')).toBe(false);expect(valuationDue('monthly','2026-09-30','2026-10-03')).toBe(true);expect(valuationDue('monthly','2026-10-01','2026-10-03')).toBe(false);
 });
});
describe('P5 allocation and strict proposals',()=>{
 const items=[{id:'a',name:'ETF',assetType:'基金',currency:'USD',marketMinor:60000,estimated:false},{id:'b',name:'人民币基金',assetType:'基金',currency:'CNY',marketMinor:288000,estimated:false}];
 it('allocates 60/40 from one approved FX snapshot; FX changes configuration only',()=>{
  expect(investmentAllocation(items,'USD',fx).rows.map(r=>r.percentHundredths)).toEqual([6000,4000]);expect(investmentAllocation(items,'USD',{...fx,usdToCny:8}).rows[0].percentHundredths).toBe(6250);expect(investmentAllocation(items,'USD',fx,'asset').rows).toHaveLength(1);
 });
 it('uses stable largest remainders totaling 100.00; zero total is empty',()=>{
  const thirds=['c','b','a'].map(id=>({...items[0],id,marketMinor:1}));const result=investmentAllocation(thirds,'USD');expect(result.rows.map(r=>r.percentHundredths)).toEqual([3334,3333,3333]);expect(result.rows.reduce((s,r)=>s+r.percentHundredths,0)).toBe(10000);expect(investmentAllocation(items.map(i=>({...i,marketMinor:0})),'USD',fx).rows).toEqual([]);
 });
 it('preserves raw FX weights before cent rounding',()=>{const tiny=[{...items[0],marketMinor:1},{...items[1],marketMinor:3}];expect(investmentAllocation(tiny,'USD',{...fx,usdToCny:6}).rows.map(r=>r.percentHundredths)).toEqual([6667,3333]);});
 it('blocks incomplete cross-currency configuration and labels estimates',()=>{
  expect(()=>investmentAllocation(items,'USD')).toThrow('缺少已批准汇率');expect(investmentAllocation([{...items[0],estimated:true}],'USD').estimated).toBe(true);
 });
 it('accepts fixed funding and zero total valuation; rejects ambiguous or invalid steps',()=>{
  const common={householdId:id,investmentId:id,idempotencyKey:id,title:'buy',occurredAt:'2026-09-02',currency:'USD'};
  const buy={...common,type:'investment_buy',amountMinor:8000,quantityMicro:1,funding:{currency:'CNY',amountMinor:72000,destinationAmountMinor:9500,occurredAt:'2026-09-01'}};
  expect(proposalSchema.safeParse(buy).success).toBe(true);expect(proposalSchema.safeParse({...buy,quantityMilli:1}).success).toBe(false);expect(proposalSchema.safeParse({...buy,funding:{...buy.funding,occurredAt:'2026-09-03'}}).success).toBe(false);
  expect(proposalSchema.safeParse({...common,type:'investment_valuation',amountMinor:0,valuationMode:'total_market',totalValueMinor:0,basis:{quantityMicro:1,throughSequence:'1',revision:0,signature:'test'}}).success).toBe(true);
 });
});
