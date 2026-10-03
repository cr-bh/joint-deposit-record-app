import type { Currency } from "./balance-calculations";
import { safeInteger } from "./integer-math";

export type SettlementInput = { claimId: string; currency: Currency; amountMinor: number };
export type ExactRates = Record<Currency, string>;
export type SettlementAmount = SettlementInput & { paymentMinor: number };
const SCALE = 10_000_000_000n;
function rateInteger(value: string) {
  if (!/^\d+(?:\.\d{1,10})?$/.test(value)) throw new Error("汇率必须为至多十位小数的正数");
  const [whole, fraction = ""] = value.split(".");
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(10, "0"));
  if (result <= 0n) throw new Error("汇率必须大于零");
  return result;
}

/** Sum exact rational amounts once, then distribute cents by remainder and stable claim key. */
export function calculateSettlement(inputs: SettlementInput[], paymentCurrency: Currency, rates?: ExactRates) {
  if (!inputs.length) throw new Error("请选择至少一笔代付原单");
  const merged = new Map<string, SettlementInput>();
  for (const item of inputs) {
    safeInteger(item.amountMinor, "原币核销额");
    if (item.amountMinor <= 0) throw new Error("原币核销额必须大于零");
    const previous = merged.get(item.claimId);
    if (previous && previous.currency !== item.currency) throw new Error("同一原单币种不一致");
    merged.set(item.claimId, { ...item, amountMinor: safeInteger(item.amountMinor + (previous?.amountMinor ?? 0), "原币核销额") });
  }
  const values = [...merged.values()];
  const crossCurrency = values.some((item) => item.currency !== paymentCurrency);
  if (crossCurrency && !rates) throw new Error("跨币种报销需要已确认汇率");
  const scaled = crossCurrency ? { USD: SCALE, CNY: rateInteger(rates!.CNY), HKD: rateInteger(rates!.HKD) } : { USD: SCALE, CNY: SCALE, HKD: SCALE };
  const denominator = scaled.USD * scaled.CNY * scaled.HKD;
  const rows = values.map((item) => {
    const numerator = BigInt(item.amountMinor) * scaled[paymentCurrency] * (denominator / scaled[item.currency]);
    return { ...item, floor: numerator / denominator, remainder: numerator % denominator, numerator };
  });
  const totalNumerator = rows.reduce((sum, row) => sum + row.numerator, 0n);
  const total = (2n * totalNumerator + denominator) / (2n * denominator);
  if (total < 1n) throw new Error("折算打款总额不足一分，请增加核销额或使用原币打款");
  const extra = total - rows.reduce((sum, row) => sum + row.floor, 0n);
  rows.sort((a, b) => a.remainder === b.remainder ? a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0 : a.remainder > b.remainder ? -1 : 1);
  const allocations: SettlementAmount[] = rows.map((row, index) => {
    const paymentMinor = safeInteger(Number(row.floor + (BigInt(index) < extra ? 1n : 0n)), "打款额");
    if (paymentMinor < 1) throw new Error("单笔折算打款不足一分，不能核销该原单");
    return { claimId: row.claimId, currency: row.currency, amountMinor: row.amountMinor, paymentMinor };
  }).sort((a, b) => a.claimId < b.claimId ? -1 : 1);
  return { amountMinor: safeInteger(Number(total), "批次打款额"), allocations };
}
