import { z } from "zod";

export const settlementSchema = z.object({
  householdId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  payeeMemberId: z.string().uuid(),
  accountKind: z.enum(["bank", "brokerage"]),
  currency: z.enum(["USD", "CNY", "HKD"]),
  occurredAt: z.string().date(),
  title: z.string().trim().min(1).max(160),
  allocations: z.array(z.object({
    claimId: z.string().uuid(),
    amountMinor: z.number().int().positive().max(9_999_999_999),
    expectedVersion: z.number().int().safe().positive(),
  }).strict()).min(1).max(100),
}).strict();
