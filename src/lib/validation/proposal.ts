import { z } from "zod";

const currency = z.enum(["USD", "CNY", "HKD"]);
const positiveMoney = z.number().int().positive().max(9_999_999_999);
const common = {
  householdId: z.string().uuid(),
  currency,
  occurredAt: z.string().date(),
  title: z.string().trim().min(1).max(160),
  idempotencyKey: z.string().uuid(),
};
const category = z.string().trim().min(1).max(60);
const investmentId = z.string().uuid();
const memberId = z.string().uuid();
const accountKind = z.enum(["bank", "brokerage"]);
const quantityMilli = z.number().int().positive().max(9_999_999_999_999);
const referencePriceTenThousandths = z.number().int().positive().max(999_999_999_999).optional();

export const proposalSchema = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("deposit"), amountMinor: positiveMoney, payerMemberId: memberId, accountKind: accountKind.optional() }).strict(),
  z.object({ ...common, type: z.literal("expense"), amountMinor: positiveMoney, category, accountKind: accountKind.optional() }).strict(),
  z.object({ ...common, type: z.literal("expense_refund"), amountMinor: positiveMoney, category: category.optional(), accountKind: accountKind.optional() }).strict(),
  z.object({ ...common, type: z.literal("reimbursement"), amountMinor: positiveMoney, category, payerMemberId: memberId }).strict(),
  z.object({ ...common, type: z.literal("settlement"), amountMinor: positiveMoney, accountKind: accountKind.optional() }).strict(),
  z.object({ ...common, type: z.literal("account_transfer"), amountMinor: positiveMoney, sourceAccountKind: accountKind, destinationAccountKind: accountKind }).strict(),
  z.object({ ...common, type: z.literal("investment_buy"), amountMinor: positiveMoney, investmentId, quantityMilli, unitPriceTenThousandths: referencePriceTenThousandths }).strict(),
  z.object({ ...common, type: z.literal("investment_sell"), amountMinor: z.number().int().nonnegative().max(9_999_999_999), investmentId, quantityMilli, unitPriceTenThousandths: referencePriceTenThousandths }).strict(),
  z.object({ ...common, type: z.literal("dividend"), amountMinor: positiveMoney, investmentId }).strict(),
  z.object({ ...common, type: z.literal("investment_valuation"), amountMinor: z.literal(0), investmentId, unitValueTenThousandths: z.number().int().positive().max(999_999_999_999) }).strict(),
]).superRefine((value, context) => {
  if (value.type === "account_transfer" && value.sourceAccountKind === value.destinationAccountKind) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "转出和转入账户不能相同", path: ["destinationAccountKind"] });
  }
});

export type ProposalInput = z.infer<typeof proposalSchema>;
