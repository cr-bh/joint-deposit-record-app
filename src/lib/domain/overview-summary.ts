import { combinedCashBalances, type AccountBalances } from "./account-balances";
import { currencies, reportBalances, type Currency } from "./balance-calculations";
import { ratesFromSnapshot, type FxRateSnapshot } from "./fx-rates";
import { investmentAllocation, type AllocationItem, type buildInvestmentSnapshot } from "./investment-snapshot";
import type { ReimbursementClaimView } from "./reimbursement-claims";
import { safeInteger } from "./integer-math";

type Row = Record<string, unknown>;
type Snapshot = Omit<ReturnType<typeof buildInvestmentSnapshot>, "latestValueDate"> & { latestValueDate?: string; error?: never } | { error: string };

/** Only full, consistently read ledger data belongs here; chart filters never enter this calculation. */
export function buildOverviewSummary(balances: AccountBalances, investments: Row[], snapshots: Record<string, Snapshot>, claims: ReimbursementClaimView[], reporting: Currency, fx?: FxRateSnapshot, unreviewedPaymentCount = 0, unreviewedClaimCount = 0) {
  const rates = ratesFromSnapshot(fx);
  const cash = reportBalances(combinedCashBalances(balances), reporting, rates);
  const issues: string[] = [];
  const items: AllocationItem[] = [];
  const prices: { id: string; name: string; currency: string; marketMinor: number | null; valueDate?: string; estimated: boolean; error?: string }[] = [];
  for (const investment of investments) {
    const id = String(investment.id), name = String(investment.name), snapshot = snapshots[id];
    if (!snapshot || snapshot.error !== undefined) {
      const error = snapshot && snapshot.error !== undefined ? snapshot.error : "持仓缺少同版本核算结果";
      issues.push(`${name}：${error}`);
      prices.push({ id, name, currency: String(investment.currency), marketMinor: null, estimated: false, error });
      continue;
    }
    if (!snapshot.position.quantityMilli && !snapshot.position.quantityMicro) continue;
    const estimated = snapshot.valuation.source !== "manual";
    items.push({ id, name, assetType: String(investment.asset_type), currency: String(investment.currency), marketMinor: snapshot.valuation.marketMinor, estimated });
    prices.push({ id, name, currency: String(investment.currency), marketMinor: snapshot.valuation.marketMinor, valueDate: snapshot.latestValueDate, estimated });
  }
  let investmentMinor: number | null = null;
  if (!issues.length) {
    try { investmentMinor = investmentAllocation(items, reporting, fx).total; }
    catch (error) { issues.push(error instanceof Error ? error.message : "投资汇率待核对"); }
  }
  const debtByCurrency = Object.fromEntries(currencies.map(c => [c, 0])) as Record<Currency, number>;
  const recoveryByCurrency = { ...debtByCurrency };
  for (const claim of claims) {
    if (claim.state === "voided") continue;
    debtByCurrency[claim.currency] = safeInteger(debtByCurrency[claim.currency] + claim.remainingMinor, "未报销垫款");
    recoveryByCurrency[claim.currency] = safeInteger(recoveryByCurrency[claim.currency] + (claim.recoveryMinor ?? 0), "成员应返款");
  }
  const payables = reportBalances(debtByCurrency, reporting, rates);
  const receivables = reportBalances(recoveryByCurrency, reporting, rates);
  if (unreviewedPaymentCount) { payables.amountMinor = null; issues.push(`${unreviewedPaymentCount} 笔历史报销缺少原单分配，往来与净额待核对`); }
  if (unreviewedClaimCount) { payables.amountMinor = null; issues.push(`${unreviewedClaimCount} 笔历史代付缺少已确认原单，往来与净额待核对`); }
  const assetsMinor = cash.amountMinor === null || investmentMinor === null ? null : safeInteger(cash.amountMinor + investmentMinor, "共同资产");
  const netMinor = assetsMinor === null || payables.amountMinor === null || receivables.amountMinor === null ? null : safeInteger(assetsMinor - payables.amountMinor + receivables.amountMinor, "共同净额");
  const missing = [...new Set([...cash.missingCurrencies, ...payables.missingCurrencies, ...receivables.missingCurrencies])];
  if (missing.length) issues.push(`缺少 ${missing.join(" / ")} 已确认汇率，暂不显示折算合计`);
  return { cashMinor: cash.amountMinor, investmentMinor, assetsMinor, payablesMinor: payables.amountMinor, receivablesMinor: receivables.amountMinor, netMinor, debtByCurrency, recoveryByCurrency, prices, estimated: items.some(i => i.estimated), issues };
}
export type OverviewSummary = ReturnType<typeof buildOverviewSummary>;
