import { describe, expect, it } from "vitest";
import { buildLedgerRecordStates } from "../src/lib/domain/ledger-record-states";
import type { LedgerEvent } from "../src/lib/domain/balance-calculations";
import type { ReimbursementClaimView } from "../src/lib/domain/reimbursement-claims";

const source: LedgerEvent = { id: "dinner", type: "expense", amountMinor: 10000, currency: "USD", status: "posted", occurredAt: "2026-09-02" };
const refund = (id: string, amountMinor: number, extra: Partial<LedgerEvent> = {}): LedgerEvent => ({ ...source, id, type: "expense_refund", amountMinor, refundSourceEntryId: source.id, refundRecipient: "common", occurredAt: "2026-09-15", ...extra });
const pending = (status = "pending_approval") => ({ status, payload: { type: "expense_refund", sourceEntryId: source.id, amountMinor: 2500 } });

describe("流水记录状态：全量已入账事实和待审批申请分开", () => {
  it("共同晚餐100已退款25、另有待审25，净消费75；筛选原单仍显示关联退款", () => {
    const allStates = buildLedgerRecordStates([source, refund("refund", 2500)], [pending()]);
    const visibleRows = [source]; // refund is outside the selected date range/page
    expect(visibleRows.map(row => allStates[row.id])).toEqual([{ label: "部分退款", tone: "amber", notices: ["退款待审批"], refundedMinor: 2500, netMinor: 7500, refundIds: ["refund"] }]);
    expect(allStates.refund.label).toBe("退款已入账");
  });
  it("仅有待审或逾期待审申请不表示已经退款", () => {
    for (const status of ["pending_approval", "overdue_pending"]) {
      const state = buildLedgerRecordStates([source], [pending(status)])[source.id];
      expect(state.label).toBe("已入账");
      expect(state.refundedMinor).toBeUndefined();
      expect(state.notices).toEqual(["退款待审批"]);
    }
  });
  it("被拒绝、撤回和已批准的提案不再标记待审批；已批准提案必须以流水为准", () => {
    for (const status of ["rejected", "withdrawn", "approved"]) expect(buildLedgerRecordStates([source], [pending(status)])[source.id].notices).toEqual([]);
  });
  it("多笔有效退款合计等于原金额时全额退款，作废退款不参与", () => {
    const state = buildLedgerRecordStates([source, refund("a", 2500), refund("b", 7500), refund("void", 5000, { status: "voided" })], [])[source.id];
    expect(state).toMatchObject({ label: "已全额退款", netMinor: 0, refundedMinor: 10000, refundIds: ["a", "b"] });
  });
  it("退款作废后原单恢复已入账，作废原单优先显示已作废", () => {
    expect(buildLedgerRecordStates([source, refund("a", 10000, { status: "voided" })], [])[source.id].label).toBe("已入账");
    expect(buildLedgerRecordStates([{ ...source, status: "voided" }, refund("a", 10000)], [pending()])[source.id]).toMatchObject({ label: "已作废", notices: [], refundIds: [] });
  });
  it("退款币种不符、超额或负数显式提示核对，不能伪造净金额", () => {
    for (const invalid of [refund("a", 10001), refund("a", -1), refund("a", 100, { currency: "CNY" })]) {
      const state = buildLedgerRecordStates([source, invalid], [])[source.id];
      expect(state.label).toBe("退款数据待核对");
      expect(state.netMinor).toBeUndefined();
    }
  });
  it("成员退款和共同退款均影响消费净额；报销返还状态独立展示", () => {
    const reimbursement = { ...source, type: "reimbursement" as const };
    const claim = { sourceEntryId: source.id, state: "recovery_due" } as ReimbursementClaimView;
    const state = buildLedgerRecordStates([reimbursement, refund("member", 5000, { refundRecipient: "member" }), refund("common", 2500)], [], [claim])[source.id];
    expect(state).toMatchObject({ label: "部分退款", netMinor: 2500, notices: ["需返还共同款"] });
  });
  it("代付的未打款、部分打款、结清分别显示；缺少claim不能显示已报销", () => {
    const reimbursement = { ...source, type: "reimbursement" as const };
    for (const [state, label] of [["confirmed_unpaid", "已确认未打款"], ["partially_paid", "部分打款"], ["settled", "已结清"]] as const) {
      expect(buildLedgerRecordStates([reimbursement], [], [{ sourceEntryId: source.id, state } as ReimbursementClaimView])[source.id].notices).toEqual([label]);
    }
    expect(buildLedgerRecordStates([reimbursement], [])[source.id].notices).toEqual(["报销状态待核对"]);
  });
  it("作废申请仍保持原单入账，重复退款申请提示只显示一次", () => {
    const state = buildLedgerRecordStates([source], [pending(), pending(), { status: "pending_approval", payload: { type: "void_record", targetId: source.id } }])[source.id];
    expect(state.label).toBe("已入账");
    expect(state.notices).toEqual(["退款待审批", "作废申请待审批"]);
  });
  it("组合投资与划转共同显示作废待审批；单独划转也有状态", () => {
    const buy = { ...source, id: "buy", type: "investment_buy" as const };
    const states = buildLedgerRecordStates([buy], [{ status: "pending_approval", payload: { type: "void_record", targetId: "transfer" } }], [], [
      { id: "buy", status: "posted", proposalId: "combined" }, { id: "transfer", status: "posted", proposalId: "combined" },
      { id: "old-transfer", status: "voided" },
    ]);
    expect(states.buy.notices).toEqual(["作废申请待审批"]);
    expect(states.transfer).toMatchObject({ label: "已入账", notices: ["作废申请待审批"] });
    expect(states["old-transfer"]).toMatchObject({ label: "已作废", notices: [] });
  });
});
