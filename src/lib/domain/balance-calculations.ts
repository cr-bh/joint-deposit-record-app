import { calculateInvestmentPosition } from "./investment-calculations";
import { safeInteger } from "./integer-math";
export type Currency = "USD" | "CNY" | "HKD";
export type CashAccountKind = "bank" | "brokerage";
// Online identifiers are auth.users UUIDs, never a fixed pair of demo names.
export type MemberId = string;
export type LedgerEventType = "opening_balance" | "deposit" | "expense" | "expense_refund" | "reimbursement" | "settlement" | "investment_buy" | "investment_sell" | "dividend";
export type FxRates = Record<Currency, number>;
export interface LedgerEvent { id: string; type: LedgerEventType; amountMinor: number; currency: Currency; status: "posted" | "voided"; occurredAt: string; createdAt?: string; effectiveSequence?: string; submitterId?: MemberId; payerMemberId?: MemberId; payeeMemberId?: MemberId; memberId?: MemberId; category?: string; title?: string; investmentId?: string; quantityMilli?: number; unitPriceTenThousandths?: number; accountKind?: CashAccountKind; }
export interface ProposalLike { status: string; payload: Pick<LedgerEvent, "type" | "amountMinor" | "currency" | "memberId" | "payerMemberId" | "payeeMemberId">; }
export type ReimbursementSummary = { memberId: MemberId; paidMinor: number; reimbursedMinor: number; pendingMinor: number; availableMinor: number; currency: Currency };

export const currencies: Currency[] = ["USD", "CNY", "HKD"];
export const minorUnit = 100;
export const formatMoney = (amountMinor: number, currency: Currency) => new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(amountMinor / minorUnit);
export const postedEvents = (events: LedgerEvent[]) => events.filter((event) => event.status === "posted");
export function toReportingMinor(amountMinor: number, currency: Currency, reportingCurrency: Currency, rates: FxRates) {
  const result = reportBalances({ USD: 0, CNY: 0, HKD: 0, [currency]: amountMinor }, reportingCurrency, rates);
  if (result.amountMinor == null) throw new Error(`缺少汇率：${result.missingCurrencies.join(" / ")}`);
  return result.amountMinor;
}
export function cashImpact(event: LedgerEvent) { if (event.status !== "posted") return 0; return ["opening_balance", "deposit", "expense_refund", "investment_sell", "dividend"].includes(event.type) ? event.amountMinor : ["expense", "settlement", "investment_buy"].includes(event.type) ? -event.amountMinor : 0; }
export function cashBalance(events: LedgerEvent[], currency: Currency) { return events.filter((event) => event.currency === currency).reduce((sum, event) => safeInteger(sum + cashImpact(event), "现金余额"), 0); }
export function cashBalanceReporting(events: LedgerEvent[], reporting: Currency, rates: FxRates) {
  const result = reportBalances({ USD: cashBalance(events, "USD"), CNY: cashBalance(events, "CNY"), HKD: cashBalance(events, "HKD") }, reporting, rates);
  if (result.amountMinor == null) throw new Error(`缺少汇率：${result.missingCurrencies.join(" / ")}`);
  return result.amountMinor;
}
export function expenseTotalReporting(events: LedgerEvent[], reporting: Currency, rates: FxRates, prefix?: string) { return postedEvents(events).filter((event) => !prefix || event.occurredAt.startsWith(prefix)).reduce((sum, event) => sum + (["expense", "reimbursement"].includes(event.type) ? toReportingMinor(event.amountMinor, event.currency, reporting, rates) : event.type === "expense_refund" ? -toReportingMinor(event.amountMinor, event.currency, reporting, rates) : 0), 0); }
/** Pre-claims summary for explicitly identified members; legacy submitters are not payers. */
export function reimbursementSummary(events: LedgerEvent[], proposals: ProposalLike[] = []) {
  const memberIds = new Set([...events.flatMap((event) => [event.payerMemberId, event.payeeMemberId]), ...proposals.map((proposal) => proposal.payload.payeeMemberId)].filter((id): id is string => Boolean(id)));
  return [...memberIds].flatMap((memberId) => currencies.map((currency) => {
    const rows = postedEvents(events).filter((event) => event.currency === currency);
    const paidMinor = rows.filter((event) => event.type === "reimbursement" && event.payerMemberId === memberId).reduce((sum, event) => sum + event.amountMinor, 0);
    const reimbursedMinor = rows.filter((event) => event.type === "settlement" && event.payeeMemberId === memberId).reduce((sum, event) => sum + event.amountMinor, 0);
    const pendingMinor = proposals.filter((proposal) => ["pending_approval", "overdue_pending"].includes(proposal.status) && proposal.payload.type === "settlement" && proposal.payload.payeeMemberId === memberId && proposal.payload.currency === currency).reduce((sum, proposal) => sum + proposal.payload.amountMinor, 0);
    const availableMinor = paidMinor - reimbursedMinor - pendingMinor;
    if (availableMinor < 0) throw new Error("报销超过已确认垫款，需核对原单");
    return { memberId, currency, paidMinor, reimbursedMinor, pendingMinor, availableMinor };
  }).filter((item) => item.paidMinor || item.pendingMinor));
}
export function holdingMilli(events: LedgerEvent[], investmentId: string, openingQuantityMilli: number) {
  return calculateInvestmentPosition(events, investmentId, openingQuantityMilli, 0).quantityMilli;
}

export const eventLabel = (type: LedgerEventType) => ({ opening_balance: "期初余额", deposit: "共同存入", expense: "共同账户消费", expense_refund: "共同消费退款", reimbursement: "成员代付共同消费", settlement: "报销付款", investment_buy: "投资买入", investment_sell: "投资卖出", dividend: "投资分红" })[type];
export function sumByCategory(events: LedgerEvent[], reporting: Currency, rates: FxRates, prefix?: string) { return postedEvents(events).reduce<Record<string, number>>((result, event) => { if (!(["expense", "reimbursement", "expense_refund"].includes(event.type)) || (prefix && !event.occurredAt.startsWith(prefix))) return result; const key = event.category || "其他"; result[key] = (result[key] || 0) + (event.type === "expense_refund" ? -1 : 1) * toReportingMinor(event.amountMinor, event.currency, reporting, rates); return result; }, {}); }

export type ReportingTotal = { amountMinor: number | null; missingCurrencies: Currency[] };

export function reportBalances(balances: Record<Currency, number>, reporting: Currency, rates: Partial<FxRates> = {}): ReportingTotal {
  const missingCurrencies = new Set<Currency>();
  const rate = (currency: Currency) => currency === "USD" ? 1 : rates[currency];
  let total = 0;
  for (const currency of currencies) {
    const amount = safeInteger(balances[currency], "原币余额");
    if (!amount) continue;
    if (currency === reporting) { total += amount; continue; }
    const from = rate(currency), to = rate(reporting);
    if (from == null || !Number.isFinite(from) || from <= 0) missingCurrencies.add(currency);
    if (to == null || !Number.isFinite(to) || to <= 0) missingCurrencies.add(reporting);
    if (from != null && to != null && from > 0 && to > 0) total += amount / from * to;
  }
  return { amountMinor: missingCurrencies.size ? null : safeInteger(Math.round(total), "折算合计"), missingCurrencies: [...missingCurrencies] };
}
