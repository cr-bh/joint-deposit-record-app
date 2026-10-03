import { z } from "zod";
import type { LedgerEvent, Currency } from "./balance-calculations";
import { reimbursementClaimFromRows } from "./reimbursement-claims";
import { safeInteger } from "./integer-math";

const uuid = z.string().uuid();
const minor = z.number().int().safe().positive();
const allocationRow = z.object({ id: uuid, household_id: uuid, claim_id: uuid, batch_id: uuid.nullable(),
  settlement_entry_id: uuid.nullable(), amount_minor: minor, payment_minor: minor.nullable(),
  claim_version: minor.nullable(), status: z.enum(["reserved", "posted", "released"]), created_at: z.string().datetime({ offset: true }) });
const batchRow = z.object({ id: uuid, proposal_id: uuid, claimant_id: uuid, account_kind: z.enum(["bank", "brokerage"]),
  currency: z.enum(["USD", "CNY", "HKD"]), amount_minor: minor, fx_snapshot_id: uuid.nullable(),
  ledger_entry_id: uuid.nullable(), status: z.enum(["reserved", "posted", "released"]), created_at: z.string().datetime({ offset: true }) });
const proposalRow = z.object({ id: uuid, submitter_id: uuid, status: z.enum(["pending_approval", "overdue_pending", "approved", "rejected", "withdrawn"]),
  decided_at: z.string().datetime({ offset: true }).nullable().optional(), payload: z.object({ title: z.string(), occurredAt: z.string().date() }).passthrough() });
export type SettlementBatchView = {
  id: string; proposalId: string; claimantId: string; accountKind: "bank" | "brokerage"; currency: Currency;
  amountMinor: number; fxSnapshotId?: string; ledgerEntryId?: string; status: z.infer<typeof proposalRow>["status"];
  submitterId: string; createdAt: string; decidedAt?: string; occurredAt: string; title: string;
  allocations: { id: string; claimId: string; currency: Currency; amountMinor: number; paymentMinor: number; title: string }[];
};
type Row = Record<string, unknown>;

/** One projection supplies claim cards, balances, payment history and approval details. */
export function projectReimbursements(claimRows: Row[], allocationRows: Row[], batchRows: Row[], proposalRows: Row[], events: LedgerEvent[]) {
  const allocations = allocationRows.map((row) => allocationRow.parse(row));
  const eventById = new Map(events.map(event => [event.id, event]));
  const claims = claimRows.map((claim) => {
    const source = eventById.get(String(claim.source_entry_id));
    if (!source) throw new Error("代付原单缺少来源消费");
    const related = allocations.filter(allocation => allocation.claim_id === claim.id);
    const settled = related.filter(allocation => allocation.status === "posted" && eventById.get(allocation.settlement_entry_id ?? "")?.status === "posted")
      .reduce((sum, allocation) => safeInteger(sum + allocation.amount_minor, "已核销额"), 0);
    const reserved = related.filter(allocation => allocation.status === "reserved").reduce((sum, allocation) => safeInteger(sum + allocation.amount_minor, "预留额"), 0);
    return reimbursementClaimFromRows(claim, source, settled, reserved);
  });
  const claimById = new Map(claims.map(claim => [claim.id, claim]));
  const batches: SettlementBatchView[] = batchRows.map((input) => {
    const row = batchRow.parse(input);
    const p = proposalRow.parse(proposalRows.find(proposal => proposal.id === row.proposal_id));
    const expectedStatus = p.status === "approved" ? "posted" : ["pending_approval", "overdue_pending"].includes(p.status) ? "reserved" : "released";
    if (row.status !== expectedStatus) throw new Error("批次与审批状态不一致");
    if (row.status === "posted") {
      const entry = eventById.get(row.ledger_entry_id ?? "");
      if (!entry || entry.type !== "settlement" || entry.status !== "posted" || entry.amountMinor !== row.amount_minor || entry.currency !== row.currency || entry.payeeMemberId !== row.claimant_id || entry.accountKind !== row.account_kind) throw new Error("打款现金流水与批次不一致");
    }
    const related = allocations.filter(allocation => allocation.batch_id === row.id);
    const details = related.map(allocation => {
      const claim = claimById.get(allocation.claim_id);
      if (!claim || claim.claimantId !== row.claimant_id || allocation.payment_minor === null || allocation.status !== row.status) throw new Error("批次核销明细不一致");
      if (row.status === "posted" && (allocation.settlement_entry_id !== row.ledger_entry_id || eventById.get(row.ledger_entry_id ?? "")?.status !== "posted")) throw new Error("打款批次缺少已入账现金流水");
      return { id: allocation.id, claimId: claim.id, currency: claim.currency, amountMinor: allocation.amount_minor, paymentMinor: allocation.payment_minor, title: claim.title };
    });
    if (!details.length || details.reduce((sum, detail) => safeInteger(sum + detail.paymentMinor, "打款总额"), 0) !== row.amount_minor) throw new Error("打款总额与明细不守恒");
    return { id: row.id, proposalId: p.id, claimantId: row.claimant_id, accountKind: row.account_kind, currency: row.currency,
      amountMinor: row.amount_minor, fxSnapshotId: row.fx_snapshot_id ?? undefined, ledgerEntryId: row.ledger_entry_id ?? undefined,
      status: p.status, submitterId: p.submitter_id, createdAt: row.created_at, decidedAt: p.decided_at ?? undefined,
      occurredAt: p.payload.occurredAt, title: p.payload.title, allocations: details };
  });
  const tracedEntries = new Set(batches.flatMap(batch => batch.ledgerEntryId ? [batch.ledgerEntryId] : []));
  const unreviewedPaymentCount = events.filter(event => event.type === "settlement" && event.status === "posted" && !tracedEntries.has(event.id)).length;
  return { claims, batches, unreviewedPaymentCount };
}

export const paymentStatusLabel: Record<SettlementBatchView["status"], string> = {
  pending_approval: "待审批（已预留）", overdue_pending: "逾期待审批（保留预留）", approved: "已打款", rejected: "已驳回（已释放）", withdrawn: "已撤回（已释放）",
};
