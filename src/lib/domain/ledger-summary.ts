import { cashBalance, currencies, reportBalances, type Currency, type FxRates, type LedgerEvent } from "./balance-calculations";
import { accountCashBalances, combinedCashBalances, type CashTransfer } from "./account-balances";
import { safeInteger } from "./integer-math";

export function summarizeLedger(events: LedgerEvent[], reporting: Currency, rates: Partial<FxRates> = {}, transfers: CashTransfer[] = [], historicalRatesBySnapshot?: Record<string, Partial<FxRates>>) {
  const cashByCurrency = transfers.length
    ? combinedCashBalances(accountCashBalances(events, transfers))
    : Object.fromEntries(currencies.map((currency) => [currency, cashBalance(events, currency)])) as Record<Currency, number>;
  const days = new Map<string, { amountMinor: number; missingCurrencies: Set<Currency> }>();
  for (const event of events) {
    if (event.status !== "posted" || !["expense", "reimbursement", "expense_refund"].includes(event.type)) continue;
    const day = days.get(event.occurredAt) ?? { amountMinor: 0, missingCurrencies: new Set<Currency>() };
    const historicalRates = historicalRatesBySnapshot === undefined ? rates : event.fxSnapshotId ? historicalRatesBySnapshot[event.fxSnapshotId] ?? {} : {};
    const converted = reportBalances({ USD: 0, CNY: 0, HKD: 0, [event.currency]: event.amountMinor }, reporting, historicalRates);
    converted.missingCurrencies.forEach((currency) => day.missingCurrencies.add(currency));
    if (converted.amountMinor !== null) day.amountMinor = safeInteger(day.amountMinor + converted.amountMinor * (event.type === "expense_refund" ? -1 : 1), "消费金额");
    days.set(event.occurredAt, day);
  }
  return {
    cashByCurrency,
    cash: reportBalances(cashByCurrency, reporting, rates),
    trend: [...days.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([date, day]) => ({ date, amountMinor: day.missingCurrencies.size ? null : day.amountMinor, missingCurrencies: [...day.missingCurrencies] })),
  };
}

export function recordCurrency(type: string, reporting: Currency, investment?: { currency: Currency }): Currency {
  if (["investment_buy", "investment_sell", "dividend", "investment_valuation"].includes(type)) {
    if (!investment) throw new Error("请选择投资标的");
    return investment.currency;
  }
  return reporting;
}

export { reportBalances } from "./balance-calculations";
