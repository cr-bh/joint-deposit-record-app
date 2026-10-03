import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { projectReimbursements } from "@/lib/domain/settlement-batches";
import ReimbursementCenter, { SettlementAllocationDetails, SettlementModal } from "@/app/app/reimbursement-center";
import type { LedgerEvent } from "@/lib/domain/balance-calculations";
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const at = "2026-09-03T00:00:00Z";
const member = id(1), sourceId = id(2), claimId = id(3), batchId = id(4), proposalId = id(5);
const source: LedgerEvent = { id: sourceId, type: "reimbursement", status: "posted", currency: "CNY", amountMinor: 72000, payerMemberId: member, occurredAt: "2026-09-02", title: "旅行住宿" };
const claimRow = { id: claimId, source_entry_id: sourceId, claimant_id: member, currency: "CNY", claimed_minor: 72000, status: "open", created_at: at, version: 1 };
const batchRow = { id: batchId, proposal_id: proposalId, claimant_id: member, account_kind: "bank", currency: "USD", amount_minor: 5000, status: "reserved", fx_snapshot_id: id(6), ledger_entry_id: null, created_at: at };
const proposalRow = { id: proposalId, status: "pending_approval", submitter_id: member, payload: { title: "住宿部分报销", occurredAt: "2026-09-03" } };
const allocationRow = { id: id(7), household_id: id(8), batch_id: batchId, claim_id: claimId, settlement_entry_id: null, amount_minor: 36000, payment_minor: 5000, claim_version: 1, status: "reserved", created_at: at };
const project = () => projectReimbursements([claimRow], [allocationRow], [batchRow], [proposalRow], [source]);
describe("P4 claim/payment projection and UI", () => {
  it("reservation is a subset of unpaid, never another payable debt", () => {
    expect(project().claims[0]).toMatchObject({ originalMinor: 72000, remainingMinor: 72000, reservedMinor: 36000, availableMinor: 36000, settledMinor: 0 });
  });
  it("approval changes reservation to posted and subtracts exactly once", () => {
    const entry: LedgerEvent = { id: id(9), type: "settlement", status: "posted", currency: "USD", amountMinor: 5000, occurredAt: "2026-09-03", payeeMemberId: member, accountKind: "bank" };
    const result = projectReimbursements([claimRow], [{ ...allocationRow, status: "posted", settlement_entry_id: entry.id }], [{ ...batchRow, status: "posted", ledger_entry_id: entry.id }], [{ ...proposalRow, status: "approved" }], [source, entry]);
    expect(result.claims[0]).toMatchObject({ settledMinor: 36000, remainingMinor: 36000, reservedMinor: 0, availableMinor: 36000 });
    expect(result.batches[0]).toMatchObject({ amountMinor: 5000, currency: "USD" });
  });
  it("rejects corrupt totals, claim payee mismatches and missing source data", () => {
    expect(() => projectReimbursements([claimRow], [allocationRow], [{ ...batchRow, amount_minor: 4999 }], [proposalRow], [source])).toThrow("不守恒");
    expect(() => projectReimbursements([claimRow], [allocationRow], [{ ...batchRow, claimant_id: id(11) }], [proposalRow], [source])).toThrow("不一致");
    expect(() => projectReimbursements([claimRow], [allocationRow], [batchRow], [proposalRow], [])).toThrow("来源消费");
  });
  it("released allocations no longer reserve even for overdue/withdrawn history", () => {
    const result = projectReimbursements([claimRow], [{ ...allocationRow, status: "released" }], [{ ...batchRow, status: "released" }], [{ ...proposalRow, status: "withdrawn" }], [source]);
    expect(result.claims[0]).toMatchObject({ reservedMinor: 0, availableMinor: 72000 });
  });
  it("approval details show original amount, actual USD share and after-approval balance", () => {
    const { claims, batches } = project();
    const html = renderToStaticMarkup(createElement(SettlementAllocationDetails, { batch: batches[0], claims }));
    expect(html).toContain("原币核销 CNY CN¥360.00");
    expect(html).toContain("实付分摊 USD $50.00");
    expect(html).toContain("批准后未结清");
  });
  it("center keeps currency groups, paid vs unpaid bars and a separate payments subpage", () => {
    const { claims, batches } = project();
    const props = { householdId: id(8), userId: member, claims, batches, proposals: [], members: [{ user_id: member, profiles: { display_name: "顾言" } }], refresh: () => {}, notify: () => {} };
    const html = renderToStaticMarkup(createElement(ReimbursementCenter, props));
    expect(html).toContain("其中待审批打款预留"); expect(html).toContain("未结清原币");
    expect(html).toContain("打款明细"); expect(html).toContain("报销这笔"); expect(html).toContain("打款时间线");
    const payments = renderToStaticMarkup(createElement(ReimbursementCenter, { ...props, initialBatchId: batchId }));
    expect(payments).toContain("撤回并释放额度"); expect(payments).toContain("USD $50.00");
    expect(payments).toContain("住宿部分报销");
  });
  it("payment dialog blocks missing FX and filters out fully reserved or other-member claims", () => {
    const { claims } = project();
    const html = renderToStaticMarkup(createElement(SettlementModal, { householdId: id(8), members: [], claims: [...claims, { ...claims[0], id: id(12), claimantId: id(13), title: "另一人的原单" }, { ...claims[0], id: id(14), availableMinor: 0, title: "额度已占满" }], initialPayee: member, initialClaimId: claimId, close: () => {}, refresh: () => {}, notify: () => {} }));
    expect(html).toContain("跨币种报销需要已确认汇率"); expect(html).not.toContain("另一人的原单"); expect(html).not.toContain("额度已占满");
  });
  it("unlinked legacy payments show a migration warning instead of guessing payees", () => {
    const legacy: LedgerEvent = { id: id(21), type: "settlement", currency: "USD", amountMinor: 1000, status: "posted", occurredAt: "2026-09-01" };
    const result = projectReimbursements([], [], [], [], [legacy]);
    expect(result.unreviewedPaymentCount).toBe(1); expect(result.batches).toHaveLength(0);
    const html = renderToStaticMarkup(createElement(ReimbursementCenter, { householdId: id(8), userId: member, members: [], claims: [], batches: [], proposals: [], unreviewedPaymentCount: result.unreviewedPaymentCount, refresh: () => {}, notify: () => {} }));
    expect(html).toContain("历史打款缺少完整原单关联");
  });
});
