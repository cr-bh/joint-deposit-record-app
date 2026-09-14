import { cashImpact, currencies, type CashAccountKind, type Currency, type LedgerEvent } from "./balance-calculations";
import { safeInteger } from "./integer-math";

export type CashTransfer = {
  id: string;
  amountMinor: number;
  currency: Currency;
  sourceAccountKind: CashAccountKind;
  destinationAccountKind: CashAccountKind;
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
    if (transfer.sourceAccountKind === transfer.destinationAccountKind) throw new Error("划转账户不能相同");
    if (!currencies.includes(transfer.currency)) throw new Error("划转币种无效");
    const amount = safeInteger(transfer.amountMinor, "划转金额");
    if (amount <= 0) throw new Error("划转金额必须大于零");
    result[transfer.sourceAccountKind][transfer.currency] = safeInteger(result[transfer.sourceAccountKind][transfer.currency] - amount, "来源账户余额");
    result[transfer.destinationAccountKind][transfer.currency] = safeInteger(result[transfer.destinationAccountKind][transfer.currency] + amount, "目标账户余额");
  }
  return result;
}

export function combinedCashBalances(balances: AccountBalances) {
  return Object.fromEntries(currencies.map((currency) => [currency, safeInteger(balances.bank[currency] + balances.brokerage[currency], "共同现金余额")])) as Record<Currency, number>;
}
