import { z } from "zod";
import { safeInteger } from "./integer-math";
import type { Currency, LedgerEvent } from "./balance-calculations";

const claimRow = z.object({
  id: z.string().uuid(),
  source_entry_id: z.string().uuid(),
  claimant_id: z.string().uuid(),
  currency: z.enum(["USD", "CNY", "HKD"]),
  claimed_minor: z.number().int().safe().positive(),
  status: z.enum(["open", "partially_settled", "settled", "voided"]),
  created_at: z.string().datetime({ offset: true }),
});

export type ClaimState = "confirmed_unpaid" | "partially_paid" | "settled" | "voided";
export type ReimbursementClaimView = {
  id: string;
  sourceEntryId: string;
  claimantId: string;
  currency: Currency;
  originalMinor: number;
  settledMinor: number;
  remainingMinor: number;
  state: ClaimState;
  title: string;
  category?: string;
  project?: string;
  occurredAt: string;
};

export function reimbursementClaimFromRows(input: unknown, source: LedgerEvent, settledMinor = 0): ReimbursementClaimView {
  const claim = claimRow.parse(input);
  const settled = safeInteger(settledMinor,"已打款金额");
  if (source.id !== claim.source_entry_id || source.type !== "reimbursement") throw new Error("代付原单与消费流水不匹配");
  if (source.payerMemberId !== claim.claimant_id) throw new Error("代付原单收款人与实际垫付人不一致");
  if (source.currency !== claim.currency || source.amountMinor !== claim.claimed_minor) throw new Error("代付原单金额与消费流水不一致");
  if (settled < 0 || settled > claim.claimed_minor) throw new Error("代付核销金额无效");
  const voided = claim.status === "voided" || source.status === "voided";
  const remainingMinor = voided ? 0 : claim.claimed_minor - settled;
  const state: ClaimState = voided ? "voided" : settled === claim.claimed_minor ? "settled" : settled > 0 ? "partially_paid" : "confirmed_unpaid";
  return { id: claim.id, sourceEntryId: source.id, claimantId: claim.claimant_id, currency: claim.currency, originalMinor: claim.claimed_minor, settledMinor: settled, remainingMinor, state, title: source.title ?? "成员代付共同消费", category: source.category, project: source.project, occurredAt: source.occurredAt };
}

export const claimStateLabel: Record<ClaimState,string> = {
  confirmed_unpaid: "已确认未打款",
  partially_paid: "部分打款",
  settled: "已结清",
  voided: "已作废",
};
