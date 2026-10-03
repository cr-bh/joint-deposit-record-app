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
  version: z.number().int().safe().positive().default(1),
});

export type ClaimState = "confirmed_unpaid" | "partially_paid" | "settled" | "voided" | "fully_refunded" | "recovery_due";
export type ReimbursementClaimView = {
  id: string;
  sourceEntryId: string;
  claimantId: string;
  currency: Currency;
  originalMinor: number;
  settledMinor: number;
  remainingMinor: number;
  reservedMinor?: number;
  availableMinor?: number;
  version?: number;
  refundedMemberMinor?: number; effectiveMinor?: number; returnedMinor?: number; recoveryMinor?: number; returnReservedMinor?: number; returnAvailableMinor?: number; financialHistory?: LedgerEvent[];
  state: ClaimState;
  title: string;
  category?: string;
  project?: string;
  occurredAt: string;
};

export function reimbursementClaimFromRows(input: unknown, source: LedgerEvent, settledMinor = 0, reservedMinor = 0, facts: {refundedMemberMinor?:number;returnedMinor?:number;returnReservedMinor?:number;history?:LedgerEvent[]} = {}): ReimbursementClaimView {
  const claim = claimRow.parse(input);
  const settled = safeInteger(settledMinor,"已打款金额");
  if (source.id !== claim.source_entry_id || source.type !== "reimbursement") throw new Error("代付原单与消费流水不匹配");
  if (source.payerMemberId !== claim.claimant_id) throw new Error("代付原单收款人与实际垫付人不一致");
  if (source.currency !== claim.currency || source.amountMinor !== claim.claimed_minor) throw new Error("代付原单金额与消费流水不一致");
  const refunded = safeInteger(facts.refundedMemberMinor ?? 0, "成员退款");
  const returned = safeInteger(facts.returnedMinor ?? 0, "返还原币");
  const effective = claim.claimed_minor - refunded;
  const recovery = Math.max(settled - effective,0) - returned;
  const returnReserved = safeInteger(facts.returnReservedMinor ?? 0,"返还预留");
  if (effective<0 || refunded<0 || returned<0 || recovery<0 || returnReserved<0 || returnReserved>recovery) throw new Error("退款返还额度无效");
  if (settled < 0 || settled > claim.claimed_minor) throw new Error("代付核销金额无效");
  const voided = claim.status === "voided" || source.status === "voided";
  const remainingMinor = voided ? 0 : Math.max(effective - settled,0);
  const reserved = safeInteger(reservedMinor, "预留金额");
  if (reserved < 0 || reserved > remainingMinor) throw new Error("代付预留额度无效");
  const state: ClaimState = voided ? "voided" : recovery>0 ? "recovery_due" : effective===0 ? "fully_refunded" : settled >= effective ? "settled" : settled > 0 ? "partially_paid" : "confirmed_unpaid";
  return { id: claim.id, sourceEntryId: source.id, claimantId: claim.claimant_id, currency: claim.currency, originalMinor: claim.claimed_minor, settledMinor: settled, remainingMinor, reservedMinor: reserved, availableMinor: remainingMinor - reserved, version: claim.version, refundedMemberMinor:refunded,effectiveMinor:effective,returnedMinor:returned,recoveryMinor:voided?0:recovery,returnReservedMinor:returnReserved,returnAvailableMinor:voided?0:recovery-returnReserved,financialHistory:facts.history, state, title: source.title ?? "成员代付共同消费", category: source.category, project: source.project, occurredAt: source.occurredAt };
}

export const claimStateLabel: Record<ClaimState,string> = {
  confirmed_unpaid: "已确认未打款",
  partially_paid: "部分打款",
  settled: "已结清",
  voided: "已作废",
  fully_refunded: "已全额退款",
  recovery_due: "需返还共同款",
};
