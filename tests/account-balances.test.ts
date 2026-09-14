import { describe, expect, it } from "vitest";
import { accountCashBalances, combinedCashBalances } from "@/lib/domain/account-balances";
import { cashTransferFromRow } from "@/lib/domain/account-adapter";
import type { LedgerEvent } from "@/lib/domain/balance-calculations";

const posted = "posted" as const;
const event = (overrides: Partial<LedgerEvent>): LedgerEvent => ({ id: crypto.randomUUID(), type: "deposit", amountMinor: 0, currency: "USD", status: posted, occurredAt: "2026-09-14", ...overrides });

describe("P2 共同银行与共同券商现金", () => {
  it("旧流水按业务类型适配默认账户且不会双计", () => {
    const balances = accountCashBalances([
      event({ type: "deposit", amountMinor: 60_000 }),
      event({ type: "investment_buy", amountMinor: 20_000 }),
    ]);
    expect(balances.bank.USD).toBe(60_000);
    expect(balances.brokerage.USD).toBe(-20_000);
    expect(combinedCashBalances(balances).USD).toBe(40_000);
  });

  it("银行转券商只改变资金位置并允许来源账户为负", () => {
    const balances = accountCashBalances(
      [event({ type: "deposit", amountMinor: 60_000, accountKind: "bank" })],
      [{ id: "t1", amountMinor: 70_000, currency: "USD", sourceAccountKind: "bank", destinationAccountKind: "brokerage", status: posted }],
    );
    expect(balances.bank.USD).toBe(-10_000);
    expect(balances.brokerage.USD).toBe(70_000);
    expect(combinedCashBalances(balances).USD).toBe(60_000);
  });

  it("券商现金不足买入时不会自动动用银行余额", () => {
    const balances = accountCashBalances([
      event({ type: "deposit", amountMinor: 60_000, accountKind: "bank" }),
      event({ type: "deposit", amountMinor: 2_000, accountKind: "brokerage" }),
      event({ type: "investment_buy", amountMinor: 20_000, accountKind: "brokerage" }),
    ]);
    expect(balances.bank.USD).toBe(60_000);
    expect(balances.brokerage.USD).toBe(-18_000);
  });

  it("银行现金不足消费时不会自动动用券商余额", () => {
    const balances = accountCashBalances([
      event({ type: "deposit", amountMinor: 2_000, accountKind: "bank" }),
      event({ type: "deposit", amountMinor: 60_000, accountKind: "brokerage" }),
      event({ type: "expense", amountMinor: 10_000, accountKind: "bank" }),
    ]);
    expect(balances.bank.USD).toBe(-8_000);
    expect(balances.brokerage.USD).toBe(60_000);
  });

  it("数据库划转行经过类型适配后精确落入两个账户", () => {
    const transfer = cashTransferFromRow({
      id: "00000000-0000-4000-8000-000000000011",
      amount_minor: "20000",
      currency: "USD",
      source_account_kind: "bank",
      destination_account_kind: "brokerage",
      status: "posted",
    });
    const balances = accountCashBalances([event({ amountMinor: 60_000 })], [transfer]);
    expect(balances.bank.USD).toBe(40_000);
    expect(balances.brokerage.USD).toBe(20_000);
    expect(combinedCashBalances(balances).USD).toBe(60_000);
    expect(() => cashTransferFromRow({ ...transfer, amount_minor: 1 })).toThrow();
  });

  it("真实换汇按两侧实际金额入账且不伪造等值", () => {
    const balances = accountCashBalances([], [{
      id: "fx1",
      amountMinor: 72_000,
      currency: "CNY",
      sourceAccountKind: "bank",
      destinationAccountKind: "bank",
      destinationAmountMinor: 9_500,
      destinationCurrency: "USD",
      movementType: "currency_exchange",
      status: posted,
    }]);
    expect(balances.bank.CNY).toBe(-72_000);
    expect(balances.bank.USD).toBe(9_500);
    expect(balances.brokerage.USD).toBe(0);
  });

  it("同账户仅允许跨币种换汇，不能伪装为同币种划转", () => {
    expect(() => accountCashBalances([], [{ id: "bad", amountMinor: 100, currency: "USD", sourceAccountKind: "bank", destinationAccountKind: "bank", destinationAmountMinor: 100, destinationCurrency: "USD", movementType: "same_currency", status: posted }])).toThrow("同币种划转数据无效");
  });
});
