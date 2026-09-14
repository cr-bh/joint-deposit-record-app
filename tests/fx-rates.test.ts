import { describe, expect, it } from "vitest";
import { fxRateSnapshotFromRow, isFxSnapshotStale, latestEffectiveFxSnapshot, ratesFromSnapshot } from "@/lib/domain/fx-rates";
import { reportBalances } from "@/lib/domain/balance-calculations";
import { summarizeLedger } from "@/lib/domain/ledger-summary";

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "00000000-0000-4000-8000-000000000011",
  usd_to_cny: "7.2000000000",
  usd_to_hkd: "7.8000000000",
  effective_at: "2026-09-14T12:00:00+00:00",
  source_note: "双方手动核对",
  created_by: "00000000-0000-4000-8000-000000000001",
  approved_by: "00000000-0000-4000-8000-000000000002",
  approved_at: "2026-09-14T12:05:00+00:00",
  ...overrides,
});

describe("P2 手动汇率快照", () => {
  it("按有效时间选择最新已批准的整组快照", () => {
    const first = fxRateSnapshotFromRow(row());
    const future = fxRateSnapshotFromRow(row({ id: "00000000-0000-4000-8000-000000000012", usd_to_cny: "7.5", effective_at: "2026-09-16T12:00:00+00:00", approved_at: "2026-09-15T12:00:00+00:00" }));
    expect(latestEffectiveFxSnapshot([future, first], "2026-09-15T00:00:00Z")).toEqual(first);
    expect(latestEffectiveFxSnapshot([first, future], "2026-09-17T00:00:00Z")).toEqual(future);
  });

  it("FX1精确支持USD/CNY/HKD互相折算", () => {
    const rates = ratesFromSnapshot(fxRateSnapshotFromRow(row()));
    expect(reportBalances({ USD: 10_000, CNY: 72_000, HKD: 78_000 }, "USD", rates).amountMinor).toBe(30_000);
    expect(reportBalances({ USD: 10_000, CNY: 72_000, HKD: 78_000 }, "CNY", rates).amountMinor).toBe(216_000);
  });

  it("超过24小时只标过期，不让快照失效", () => {
    const snapshot = fxRateSnapshotFromRow(row());
    expect(isFxSnapshotStale(snapshot, "2026-09-15T12:04:59Z")).toBe(false);
    expect(isFxSnapshotStale(snapshot, "2026-09-15T12:05:01Z")).toBe(true);
    expect(ratesFromSnapshot(snapshot).CNY).toBe(7.2);
  });

  it("实际换汇只改变原币现金构成，按两端实际金额各入账一次", () => {
    const summary = summarizeLedger([], "USD", { USD: 1, HKD: 7.8 }, [{ id: "fx", amountMinor: 10_000, currency: "USD", sourceAccountKind: "bank", destinationAccountKind: "bank", destinationAmountMinor: 78_000, destinationCurrency: "HKD", movementType: "currency_exchange", status: "posted" }]);
    expect(summary.cashByCurrency).toEqual({ USD: -10_000, CNY: 0, HKD: 78_000 });
    expect(summary.cash.amountMinor).toBe(0);
    expect(summary.trend).toEqual([]);
  });

  it("新汇率只更新当前资产折算，历史消费保持审批时快照", () => {
    const historicalId = "00000000-0000-4000-8000-000000000013";
    const expense = { id: "expense", type: "expense" as const, amountMinor: 7_200, currency: "CNY" as const, status: "posted" as const, occurredAt: "2026-09-10", fxSnapshotId: historicalId };
    const summary = summarizeLedger([expense], "USD", { USD: 1, CNY: 7.5 }, [], { [historicalId]: { USD: 1, CNY: 7.2 } });
    expect(summary.cash.amountMinor).toBe(-960);
    expect(summary.trend).toEqual([{ date: "2026-09-10", amountMinor: 1_000, missingCurrencies: [] }]);
  });
});
