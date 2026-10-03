import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { accountCashBalances, type CashTransfer } from "@/lib/domain/account-balances";
import type { LedgerEvent } from "@/lib/domain/balance-calculations";
import { buildOverviewSummary } from "@/lib/domain/overview-summary";
import { buildInvestmentSnapshot, investmentAllocation } from "@/lib/domain/investment-snapshot";
import { reimbursementClaimFromRows } from "@/lib/domain/reimbursement-claims";
import OverviewCards from "@/app/app/overview-cards";

const id = "00000000-0000-4000-8000-000000000001";
const member = "00000000-0000-4000-8000-000000000002";
const investment = { id, name: "ETF", asset_type: "基金", currency: "USD", opening_quantity_milli: 0, opening_cost_minor: 0 };
const fx = { id, usdToCny: 7.2, usdToHkd: 7.8, effectiveAt: "2026-09-01T00:00:00Z", approvedAt: "2026-09-01T00:00:00Z", createdBy: id, approvedBy: member, sourceNote: "test" };
const event = (type: LedgerEvent["type"], amountMinor: number, extra: Partial<LedgerEvent> = {}): LedgerEvent => ({ id, type, amountMinor, currency: "USD", status: "posted", occurredAt: "2026-09-01", ...extra });
const original = event("reimbursement", 12000, { payerMemberId: member });
const claim = (paid = 0, refunded = 0, returned = 0) => reimbursementClaimFromRows({ id, source_entry_id: id, claimant_id: member, currency: "USD", claimed_minor: 12000, status: "open", created_at: "2026-09-01T00:00:00Z" }, original, paid, 0, { refundedMemberMinor: refunded, returnedMinor: returned });

describe("P7 PRD 15.1 complete chain", () => {
  it("matches all ten rows, including idle brokerage cash and final USD435", () => {
    const events: LedgerEvent[] = [], transfers: CashTransfer[] = [];
    let paid = 0, hasClaim = false;
    const valuations: Record<string, unknown>[] = [];
    const stages = [
      { run: () => events.push(event("deposit", 30000), event("deposit", 30000)), expected: [600, 0, 600, 0, 0, 600, 600] },
      { run: () => events.push(event("expense", 10000)), expected: [500, 0, 500, 0, 0, 500, 500] },
      { run: () => { events.push(original); hasClaim = true; }, expected: [500, 0, 500, 0, 120, 500, 380] },
      { run: () => { events.push(event("settlement", 5000)); paid = 5000; }, expected: [450, 0, 450, 0, 70, 450, 380] },
      { run: () => transfers.push({ id, currency: "USD", amountMinor: 20000, sourceAccountKind: "bank", destinationAccountKind: "brokerage", status: "posted" }), expected: [250, 200, 450, 0, 70, 450, 380] },
      { run: () => events.push(event("investment_buy", 20000, { investmentId: id, quantityMicro: 20000000 })), expected: [250, 0, 250, 200, 70, 450, 380] },
      { run: () => valuations.push({ id, investment_id: id, value_date: "2026-09-01", created_at: "2026-09-01T12:00:00Z", unit_value_1e4: 120000 }), expected: [250, 0, 250, 240, 70, 490, 420] },
      { run: () => events.push(event("investment_sell", 7000, { investmentId: id, quantityMicro: 5000000 })), expected: [250, 70, 320, 180, 70, 500, 430] },
      { run: () => events.push(event("dividend", 500, { investmentId: id })), expected: [250, 75, 325, 180, 70, 505, 435] },
      { run: () => { events.push(event("settlement", 7000)); paid = 12000; }, expected: [180, 75, 255, 180, 0, 435, 435] },
    ];
    for (const stage of stages) {
      stage.run();
      const balances = accountCashBalances(events, transfers), snapshot = buildInvestmentSnapshot(events, investment, valuations);
      const result = buildOverviewSummary(balances, [investment], { [id]: snapshot }, hasClaim ? [claim(paid)] : [], "USD");
      expect([balances.bank.USD, balances.brokerage.USD, result.cashMinor, result.investmentMinor, result.payablesMinor, result.assetsMinor, result.netMinor].map(v => v! / 100)).toEqual(stage.expected);
    }
    const position = buildInvestmentSnapshot(events, investment, valuations).position;
    expect(position).toMatchObject({ remainingCostMinor: 15000, realizedGainMinor: 2000, dividendMinor: 500 });
  });
});

describe("P7 current assets and recoveries", () => {
  it("keeps negative cash signed and reserves do not reduce confirmed debt", () => {
    const balances = accountCashBalances([event("expense", 20000)]);
    const result = buildOverviewSummary(balances, [], {}, [{ ...claim(), reservedMinor: 5000, availableMinor: 7000 }], "USD");
    expect(result).toMatchObject({ cashMinor: -20000, assetsMinor: -20000, payablesMinor: 12000, netMinor: -32000 });
  });
  it("adds member recoveries without pretending they are common cash or contribution", () => {
    const balances = accountCashBalances([event("deposit", 60000), event("settlement", 12000)]);
    const before = buildOverviewSummary(balances, [], {}, [claim(12000, 10000)], "USD");
    expect(before).toMatchObject({ cashMinor: 48000, receivablesMinor: 10000, netMinor: 58000 });
    const after = buildOverviewSummary(accountCashBalances([event("deposit", 60000), event("settlement", 12000), event("member_return", 10000)]), [], {}, [claim(12000, 10000, 10000)], "USD");
    expect(after).toMatchObject({ cashMinor: 58000, receivablesMinor: 0, netMinor: 58000 });
  });
  it("matches P5 allocation total and labels cost estimates", () => {
    const foreign = { ...investment, currency: "CNY" };
    const snapshot = buildInvestmentSnapshot([event("investment_buy", 72000, { investmentId: id, currency: "CNY", quantityMicro: 1000000 })], foreign, []);
    const result = buildOverviewSummary(accountCashBalances([]), [foreign], { [id]: snapshot }, [], "USD", fx);
    expect(result.investmentMinor).toBe(investmentAllocation([{ id, name: "ETF", assetType: "基金", currency: "CNY", marketMinor: 72000, estimated: true }], "USD", fx).total);
    expect(result.estimated).toBe(true);
    expect(result.prices[0]).toMatchObject({ estimated: true, marketMinor: 72000 });
    expect(buildOverviewSummary(accountCashBalances([]), [foreign], { [id]: snapshot }, [], "USD").assetsMinor).toBeNull();
  });
  it("uses current FX for all asset and debt components, retaining original currencies", () => {
    const balances = accountCashBalances([event("deposit", 72000, { currency: "CNY" })]);
    const claims = [{ ...claim(), currency: "CNY" as const, remainingMinor: 36000, recoveryMinor: 7200 }];
    expect(buildOverviewSummary(balances, [], {}, claims, "USD", fx).netMinor).toBe(6000);
    const result = buildOverviewSummary(balances, [], {}, claims, "USD", { ...fx, usdToCny: 8 });
    expect(result.netMinor).toBe(5400); expect(result.debtByCurrency.CNY).toBe(36000);
    expect(buildOverviewSummary(balances, [], {}, claims, "CNY", fx).netMinor).toBe(43200);
  });
  it("does not show fabricated assets or net when investments or old payments need review", () => {
    expect(buildOverviewSummary(accountCashBalances([]), [investment], { [id]: { error: "历史持仓待核对" } }, [], "USD").assetsMinor).toBeNull();
    expect(buildOverviewSummary(accountCashBalances([]), [], {}, [], "USD", undefined, 0, 1).netMinor).toBeNull();
    expect(buildOverviewSummary(accountCashBalances([]), [], {}, [], "USD", undefined, 1)).toMatchObject({ payablesMinor: null, netMinor: null });
  });
  it("renders all current cards, version, estimate date and independent pending count", () => {
    const summary = buildOverviewSummary(accountCashBalances([event("expense", 200)]), [], {}, [], "USD");
    const html = renderToStaticMarkup(createElement(OverviewCards, { summary, currency: "USD", version: 41, pendingCount: 2 }));
    for (const text of ["共同投资资产", "共同资产总额", "未报销垫款", "成员应返共同款", "扣除往来后的净额", "账本版本 41", "2 笔待审批", "-$2.00"]) expect(html).toContain(text);
    expect(html).not.toContain("PieChart");
  });
});
