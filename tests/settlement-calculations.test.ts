import { describe, expect, it } from "vitest";
import { calculateSettlement } from "@/lib/domain/settlement-calculations";
import { settlementSchema } from "@/lib/validation/settlement";
import { proposalSchema } from "@/lib/validation/proposal";
const rates = { USD: "1", CNY: "7.2", HKD: "7.8" };
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
describe("P4 exact settlement rounding", () => {
  it("T10 CNY360 + HKD780 pays USD150, preserving original allocations", () => {
    expect(calculateSettlement([{ claimId: id(1), currency: "CNY", amountMinor: 36000 }, { claimId: id(2), currency: "HKD", amountMinor: 78000 }], "USD", rates)).toEqual({ amountMinor: 15000, allocations: [
      { claimId: id(1), currency: "CNY", amountMinor: 36000, paymentMinor: 5000 }, { claimId: id(2), currency: "HKD", amountMinor: 78000, paymentMinor: 10000 },
    ] });
  });
  it("rounds a batch once: CNY1 x3 gives USD0.42, 14 cents each", () => {
    const result = calculateSettlement([3, 1, 2].map(index => ({ claimId: id(index), currency: "CNY", amountMinor: 100 })), "USD", rates);
    expect(result.amountMinor).toBe(42); expect(result.allocations.map(row => row.paymentMinor)).toEqual([14, 14, 14]);
  });
  it("stable ties award the cent to the same claim regardless of input order", () => {
    const inputs = [3, 2, 1].map(index => ({ claimId: id(index), currency: "CNY" as const, amountMinor: 10 }));
    const first = calculateSettlement(inputs, "USD", rates);
    expect(first).toEqual(calculateSettlement([...inputs].reverse(), "USD", rates));
    expect(first.amountMinor).toBe(4); expect(first.allocations.map(row => row.paymentMinor)).toEqual([2, 1, 1]);
  });
  it("rejects zero batch and zero line even when another line makes a positive batch", () => {
    const tiny = [1, 2, 3].map(index => ({ claimId: id(index), currency: "CNY" as const, amountMinor: 1 }));
    expect(() => calculateSettlement(tiny, "USD", rates)).toThrow("总额不足一分");
    expect(() => calculateSettlement([{ claimId: id(4), currency: "USD", amountMinor: 100 }, tiny[0]], "USD", rates)).toThrow("单笔");
  });
  it("merges a repeated claim before distributing cents", () => {
    const result = calculateSettlement([{ claimId: id(1), currency: "CNY", amountMinor: 5 }, { claimId: id(1), currency: "CNY", amountMinor: 5 }], "USD", rates);
    expect(result.allocations).toHaveLength(1); expect(result.allocations[0]).toMatchObject({ amountMinor: 10, paymentMinor: 1 });
  });
  it("same-currency payment needs no FX; cross-currency requires a confirmed snapshot", () => {
    expect(calculateSettlement([{ claimId: id(1), currency: "CNY", amountMinor: 123 }], "CNY").amountMinor).toBe(123);
    expect(() => calculateSettlement([{ claimId: id(1), currency: "CNY", amountMinor: 123 }], "USD")).toThrow("已确认汇率");
  });
  it("uses decimal strings without floating-point products at ten-digit FX precision", () => {
    expect(calculateSettlement([{ claimId: id(1), currency: "USD", amountMinor: 9999999999 }], "CNY", { ...rates, CNY: "0.0000000001" }).amountMinor).toBe(1);
    for (let count = 1; count <= 50; count++) {
      const result = calculateSettlement(Array.from({ length: count }, (_, index) => ({ claimId: id(index + 1), currency: index % 2 ? "CNY" : "HKD", amountMinor: 100 + index * 31 })), "USD", rates);
      expect(result.allocations.reduce((sum, row) => sum + row.paymentMinor, 0)).toBe(result.amountMinor);
      expect(result.allocations.every(row => row.paymentMinor > 0)).toBe(true);
    }
  });
  it("API requires claim links, member, account, revision and idempotency, rejects forged payment amounts", () => {
    const payload = { householdId: id(1), idempotencyKey: id(2), payeeMemberId: id(3), accountKind: "bank", currency: "USD", occurredAt: "2026-09-03", title: "payment", allocations: [{ claimId: id(4), amountMinor: 100, expectedVersion: 1 }] };
    expect(settlementSchema.safeParse(payload).success).toBe(true);
    for (const value of [{ ...payload, amountMinor: 10 }, { ...payload, allocations: [] }, { ...payload, allocations: [{ ...payload.allocations[0], paymentMinor: 1 }] }, { ...payload, allocations: [{ ...payload.allocations[0], amountMinor: 1.1 }] }]) expect(settlementSchema.safeParse(value).success).toBe(false);
    expect(proposalSchema.safeParse({ householdId: id(1), idempotencyKey: id(2), type: "settlement", amountMinor: 100, currency: "USD", occurredAt: "2026-09-03", title: "unlinked payment" }).success).toBe(false);
  });
});
