import { cashImpact, currencies, type CashAccountKind, type Currency, type LedgerEvent } from "./balance-calculations";
import { safeInteger } from "./integer-math";

export type CashTransfer = {
  id: string;
  amountMinor: number;
  currency: Currency;
  sourceAccountKind: CashAccountKind;
  destinationAccountKind: CashAccountKind;
  destinationAmountMinor?: number;
  destinationCurrency?: Currency;
  movementType?: "same_currency" | "currency_exchange";
  status: "posted" | "voided";
};

export type AccountBalances = Record<CashAccountKind, Record<Currency, number>>;

export function defaultAccountKind(type: LedgerEvent["type"]): CashAccountKind | null {
  if (["investment_buy", "investment_sell", "dividend"].includes(type)) return "brokerage";
  if (type === "reimbursement") return null;
  return "bank";
}

export function accountCashBalances(events: LedgerEvent[], transfers: CashTransfer[] = []): AccountBalances {
  const result: AccountBalances = {
    bank: { USD: 0, CNY: 0, HKD: 0 },
    brokerage: { USD: 0, CNY: 0, HKD: 0 },
  };
  for (const event of events) {
    const impact = cashImpact(event);
    if (!impact) continue;
    const account = event.accountKind ?? defaultAccountKind(event.type);
    if (!account) throw new Error("现金流水缺少共同账户");
    result[account][event.currency] = safeInteger(result[account][event.currency] + impact, "账户现金余额");
  }
  for (const transfer of transfers) {
    if (transfer.status !== "posted") continue;
    if (!currencies.includes(transfer.currency)) throw new Error("划转币种无效");
    const amount = safeInteger(transfer.amountMinor, "划转金额");
    if (amount <= 0) throw new Error("划转金额必须大于零");
    const destinationCurrency = transfer.destinationCurrency ?? transfer.currency;
    const destinationAmount = safeInteger(transfer.destinationAmountMinor ?? amount, "目标到账金额");
    if (destinationAmount <= 0) throw new Error("目标到账金额必须大于零");
    const movementType = transfer.movementType ?? (destinationCurrency === transfer.currency ? "same_currency" : "currency_exchange");
    if (movementType === "same_currency" && (transfer.sourceAccountKind === transfer.destinationAccountKind || destinationCurrency !== transfer.currency || destinationAmount !== amount)) throw new Error("同币种划转数据无效");
    if (movementType === "currency_exchange" && destinationCurrency === transfer.currency) throw new Error("换汇币种不能相同");
    result[transfer.sourceAccountKind][transfer.currency] = safeInteger(result[transfer.sourceAccountKind][transfer.currency] - amount, "来源账户余额");
    result[transfer.destinationAccountKind][destinationCurrency] = safeInteger(result[transfer.destinationAccountKind][destinationCurrency] + destinationAmount, "目标账户余额");
  }
  return result;
}

export function combinedCashBalances(balances: AccountBalances) {
  return Object.fromEntries(currencies.map((currency) => [currency, safeInteger(balances.bank[currency] + balances.brokerage[currency], "共同现金余额")])) as Record<Currency, number>;
}
