import { describe,expect,it } from "vitest";
import { reimbursementClaimFromRows } from "@/lib/domain/reimbursement-claims";
import type { LedgerEvent } from "@/lib/domain/balance-calculations";

const A = "00000000-0000-4000-8000-000000000001";
const claimId = "00000000-0000-4000-8000-000000000002";
const source: LedgerEvent = { id: A, type: "reimbursement", amountMinor: 10000, currency: "USD", status: "posted", occurredAt: "2026-09-01", payerMemberId: A, submitterId: claimId, category: "交通", project: "2026 香港旅行", title: "A 代付交通" };
const row = { id: claimId, source_entry_id: A, claimant_id: A, currency: "USD", claimed_minor: 10000, status: "open", created_at: "2026-09-01T00:00:00Z" };

describe("P3 逐笔代付原单", () => {
  it("代录仍归实际垫付人，保留用途事项并派生未付状态", () => {
    expect(reimbursementClaimFromRows(row,source)).toMatchObject({ claimantId: A, originalMinor: 10000, remainingMinor: 10000, state: "confirmed_unpaid", category: "交通", project: "2026 香港旅行" });
  });
  it("部分与全部打款状态由有效分配金额派生", () => {
    expect(reimbursementClaimFromRows(row,source,4000)).toMatchObject({ settledMinor: 4000, remainingMinor: 6000, state: "partially_paid" });
    expect(reimbursementClaimFromRows(row,source,10000)).toMatchObject({ remainingMinor: 0, state: "settled" });
  });
  it("拒绝欠给提交者、金额不一致和超额核销", () => {
    expect(() => reimbursementClaimFromRows(row,{ ...source,payerMemberId: claimId })).toThrow("实际垫付人");
    expect(() => reimbursementClaimFromRows(row,{ ...source,amountMinor: 9999 })).toThrow("金额");
    expect(() => reimbursementClaimFromRows(row,source,10001)).toThrow("核销金额");
  });
});
