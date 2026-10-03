import type { LedgerEvent } from "./balance-calculations";
import type { ReimbursementClaimView } from "./reimbursement-claims";
import { claimStateLabel } from "./reimbursement-claims";
import { safeInteger } from "./integer-math";

export type LedgerRecordState = {
  label: string;
  tone: "green" | "amber" | "gray" | "red";
  notices: string[];
  refundedMinor?: number;
  netMinor?: number;
  refundIds: string[];
};

/** Pass the complete snapshot, before filtering or pagination. Pending requests are not financial facts. */
export function buildLedgerRecordStates(events: LedgerEvent[], proposals: Record<string, unknown>[], claims: ReimbursementClaimView[] = [], relatedRecords: { id: string; status: string; proposalId?: string }[] = []): Record<string, LedgerRecordState> {
  const refunds = new Map<string, LedgerEvent[]>();
  for (const event of events) {
    if (event.type !== "expense_refund" || event.status !== "posted" || !event.refundSourceEntryId) continue;
    const related = refunds.get(event.refundSourceEntryId) ?? [];
    related.push(event);
    refunds.set(event.refundSourceEntryId, related);
  }
  const pending = new Map<string, Set<string>>();
  const recordsById = new Map(relatedRecords.map(record => [record.id, record]));
  const groups = new Map<string, string[]>();
  for (const record of relatedRecords) {
    if (record.proposalId) groups.set(record.proposalId, [...(groups.get(record.proposalId) ?? []), record.id]);
  }
  for (const proposal of proposals) {
    if (!["pending_approval", "overdue_pending"].includes(String(proposal.status))) continue;
    const payload = proposal.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    const id = payload.type === "expense_refund" ? payload.sourceEntryId : payload.type === "void_record" ? payload.targetId : undefined;
    if (typeof id !== "string") continue;
    const groupId = payload.type === "void_record" ? recordsById.get(id)?.proposalId : undefined;
    for (const targetId of groupId ? groups.get(groupId) ?? [id] : [id]) {
      const labels = pending.get(targetId) ?? new Set<string>();
      labels.add(payload.type === "expense_refund" ? "退款待审批" : "作废申请待审批");
      pending.set(targetId, labels);
    }
  }
  const claimBySource = new Map(claims.map(claim => [claim.sourceEntryId, claim]));
  const states = Object.fromEntries(relatedRecords.map(record => [record.id, {
    label: record.status === "voided" ? "已作废" : "已入账", tone: record.status === "voided" ? "gray" : "green",
    notices: record.status === "voided" ? [] : [...(pending.get(record.id) ?? [])], refundIds: [],
  } as LedgerRecordState]));
  return { ...states, ...Object.fromEntries(events.map(event => {
    const state: LedgerRecordState = { label: "已入账", tone: "green", notices: [], refundIds: [] };
    if (event.status === "voided") return [event.id, { ...state, label: "已作废", tone: "gray" }];
    if (event.type === "expense_refund") state.label = "退款已入账";
    if (event.type === "settlement") state.label = "报销已入账";
    if (event.type === "member_return") state.label = "返还已入账";
    if (["expense", "reimbursement"].includes(event.type)) {
      const related = refunds.get(event.id) ?? [];
      const total = related.reduce((sum, refund) => safeInteger(sum + refund.amountMinor, "退款合计"), 0);
      if (total < 0 || total > event.amountMinor || related.some(refund => refund.currency !== event.currency || refund.amountMinor <= 0)) {
        state.label = "退款数据待核对";
        state.tone = "red";
      } else if (total > 0) {
        state.label = total === event.amountMinor ? "已全额退款" : "部分退款";
        state.tone = "amber";
        state.refundedMinor = total;
        state.netMinor = event.amountMinor - total;
        state.refundIds = related.map(refund => refund.id);
      }
      const claim = claimBySource.get(event.id);
      if (claim && claimStateLabel[claim.state] !== state.label) state.notices.push(claimStateLabel[claim.state]);
      if (event.type === "reimbursement" && !claim) state.notices.push("报销状态待核对");
    }
    state.notices.push(...(pending.get(event.id) ?? []));
    return [event.id, state];
  })) };
}
