import { calculateInvestmentPosition, latestValuation, valuePosition, type UnitValuation } from './investment-calculations';
import type { LedgerEvent } from './balance-calculations';
import { compareEvents } from './event-order';
import { safeInteger } from './integer-math';
import type { FxRateSnapshot } from './fx-rates';

type Row = Record<string, unknown>;
export function valuationFromRow(r: Row): UnitValuation {
  const number = (key: string) => r[key] == null ? undefined : safeInteger(Number(r[key]), key);
  return { id: String(r.id), valueDate: String(r.value_date), createdAt: String(r.created_at), unitValueTenThousandths: number('unit_value_1e4') ?? Number(r.unit_value_minor) * 100, inputMode: String(r.input_mode ?? 'legacy'), quantityMicro: number('quantity_micro'), totalValueMinor: number('total_value_minor'), unitValueHundredMillionths: number('unit_value_1e8'), basisThroughSequence: r.basis_through_sequence == null ? undefined : String(r.basis_through_sequence), basisSignature: r.basis_signature == null ? undefined : String(r.basis_signature), effectiveSequence: r.effective_sequence == null ? undefined : String(r.effective_sequence) };
}
export function investmentBasis(events: LedgerEvent[], id: string, date: string, throughSequence: string, openingMilli = 0, openingCost = 0) {
  const eligible = events.filter(e => e.status === 'posted' && e.investmentId === id && ['investment_buy','investment_sell'].includes(e.type) && (e.occurredAt < date || (e.occurredAt === date && BigInt(e.effectiveSequence ?? '0') <= BigInt(throughSequence)))).sort(compareEvents);
  const position = calculateInvestmentPosition(eligible, id, openingMilli, openingCost);
  const signature = `${openingMilli * 1000}:${openingCost}|${eligible.map(e => `${e.id}:${e.occurredAt}:${e.effectiveSequence ?? '0'}:${e.type}:${e.quantityMicro ?? e.quantityMilli! * 1000}:${e.amountMinor}`).join('|')}`;
  return { quantityMicro: position.quantityMicro ?? position.quantityMilli * 1000, signature, throughSequence, revision: 0 };
}
export function buildInvestmentSnapshot(events: LedgerEvent[], investment: Row, rows: Row[]) {
  const id = String(investment.id), opening = Number(investment.opening_quantity_milli ?? 0), cost = Number(investment.opening_cost_minor ?? 0);
  const position = calculateInvestmentPosition(events, id, opening, cost);
  let latest = latestValuation(rows.filter(r => r.investment_id === id).map(valuationFromRow));
  let held = opening * 1000;
  let lastClose: LedgerEvent | undefined;
  for (const event of events.filter(e => e.investmentId === id && e.status === 'posted').sort(compareEvents)) {
    const quantity = event.quantityMicro ?? (event.quantityMilli ?? 0) * 1000;
    if (event.type === 'investment_buy') held += quantity;
    if (event.type === 'investment_sell') { held -= quantity; if (held === 0) lastClose = event; }
  }
  if (latest && lastClose && (latest.valueDate < lastClose.occurredAt || (latest.valueDate === lastClose.occurredAt && (!latest.effectiveSequence || BigInt(latest.effectiveSequence) <= BigInt(lastClose.effectiveSequence ?? '0'))))) latest = undefined;
  if (latest?.basisSignature) {
    const basis = investmentBasis(events,id,latest.valueDate,latest.basisThroughSequence!,opening,cost);
    if (basis.signature !== latest.basisSignature || basis.quantityMicro !== latest.quantityMicro) throw new Error('估值所依赖的历史持仓已变化，待核对并重新估值');
  }
  if (latest?.inputMode === 'total_market' && (!latest.quantityMicro || latest.totalValueMinor == null || latest.totalValueMinor < 0)) throw new Error('估值基准缺失，待核对');
  const valuation = valuePosition(position, latest);
  return { position, valuation, latestValueDate: latest?.valueDate };
}
export function positionReturn(position: ReturnType<typeof calculateInvestmentPosition>, valuation: ReturnType<typeof valuePosition>) {
  if (!position.quantityMilli) return { label: '已清仓', percent: null };
  if (!position.remainingCostMinor) return { label: '无成本基数', percent: null };
  if (valuation.source !== 'manual') return { label: '待估值', percent: null };
  return { label: '持仓涨跌幅', percent: (valuation.marketMinor - position.remainingCostMinor) / position.remainingCostMinor * 100 };
}
export function valuationDue(cadence: string, lastDate: string | undefined, today: string) {
  const date = new Date(`${today}T00:00:00Z`);
  if (cadence === 'monthly') date.setUTCDate(1);
  else date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return !lastDate || lastDate < date.toISOString().slice(0,10);
}
export type AllocationItem = { id: string; name: string; assetType: string; currency: string; marketMinor: number; estimated: boolean };
export function investmentAllocation(items: AllocationItem[], reporting: string, snapshot?: FxRateSnapshot, grouping: 'instrument' | 'asset' = 'instrument') {
  const rate = (currency: string) => {
    if (currency === 'USD') return 10_000_000_000n;
    if (!snapshot) throw new Error('缺少已批准汇率，配置待核对');
    const text = String(currency === 'CNY' ? snapshot.usdToCnyExact ?? snapshot.usdToCny : snapshot.usdToHkdExact ?? snapshot.usdToHkd);
    if (!/^\d+(\.\d{1,10})?$/.test(text)) throw new Error('汇率无效');
    const [integer,fraction=''] = text.split('.'); const result = BigInt(integer + fraction.padEnd(10,'0'));
    if (!result) throw new Error('汇率无效'); return result;
  };
  // A common rational denominator preserves sub-cent FX weights for the chart.
  const needed = [...new Set(items.filter(i => i.currency !== reporting).map(i => i.currency))];
  const denominator = needed.reduce((product,c) => product * rate(c),1n);
  const groups = new Map<string,{id:string;name:string;weight:bigint;estimated:boolean}>();
  for (const item of items) {
    safeInteger(item.marketMinor, '市值'); if (item.marketMinor < 0) throw new Error('市值无效');
    const weight = item.currency === reporting ? BigInt(item.marketMinor) * denominator : BigInt(item.marketMinor) * rate(reporting) * (denominator / rate(item.currency));
    const key = grouping === 'asset' ? item.assetType : item.id;
    const current = groups.get(key) ?? { id: key, name: grouping === 'asset' ? item.assetType : item.name, weight: 0n, estimated: false };
    current.weight += weight; current.estimated ||= item.estimated; groups.set(key,current);
  }
  const rows = [...groups.values()].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), totalWeight = rows.reduce((s,r) => s + r.weight,0n);
  const total = safeInteger(Number((2n * totalWeight + denominator) / (2n * denominator)), '总市值');
  if (!totalWeight) return { total: 0, rows: [], estimated: items.some(i => i.estimated) };
  const shares = rows.map(r => ({ id:r.id, name:r.name, estimated:r.estimated, rawMinor:Number(r.weight)/Number(denominator), minor:safeInteger(Number((2n * r.weight + denominator) / (2n * denominator)), '折算市值'), percentHundredths: Number(r.weight * 10000n / totalWeight), remainder: r.weight * 10000n % totalWeight }));
  let missing = 10000 - shares.reduce((s,r) => s + r.percentHundredths,0);
  for (const r of [...shares].sort((a,b) => a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 : a.id < b.id ? -1 : 1)) { if (missing-- <= 0) break; r.percentHundredths++; }
  return { total, rows: shares.map(r => ({id:r.id,name:r.name,minor:r.minor,rawMinor:r.rawMinor,estimated:r.estimated,percentHundredths:r.percentHundredths})), estimated: items.some(i => i.estimated) };
}
