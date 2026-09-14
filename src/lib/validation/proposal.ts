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
const category = z.string().trim().min(1).max(30).refine((value) => !["代付", "报销", "成员代付", "报销付款"].includes(value), "事件类型不能作为消费分类");
const categoryId = z.string().uuid();
const projectFields = { projectId: z.string().uuid().optional(), project: z.string().trim().min(1).max(60).optional() };
const investmentId = z.string().uuid();
const memberId = z.string().uuid();
const accountKind = z.enum(["bank", "brokerage"]);
const quantityMilli = z.number().int().positive().max(9_999_999_999_999);
const referencePriceTenThousandths = z.number().int().positive().max(999_999_999_999).optional();
const positiveRate = z.string().trim().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,10})?$/).refine((value) => Number(value) > 0);

export const proposalSchema = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("deposit"), amountMinor: positiveMoney, payerMemberId: memberId, accountKind: accountKind.optional() }).strict(),
  z.object({ ...common, ...projectFields, type: z.literal("expense"), amountMinor: positiveMoney, category, categoryId, accountKind: accountKind.optional() }).strict(),
  z.object({ ...common, ...projectFields, type: z.literal("expense_refund"), amountMinor: positiveMoney, category: category.optional(), categoryId: categoryId.optional(), accountKind: accountKind.optional() }).strict(),
  z.object({ ...common, ...projectFields, type: z.literal("reimbursement"), amountMinor: positiveMoney, category, categoryId, payerMemberId: memberId }).strict(),
  z.object({ ...common, type: z.literal("settlement"), amountMinor: positiveMoney, accountKind: accountKind.optional() }).strict(),
  z.object({ ...common, type: z.literal("account_transfer"), amountMinor: positiveMoney, sourceAccountKind: accountKind, destinationAccountKind: accountKind }).strict(),
  z.object({ ...common, type: z.literal("currency_exchange"), amountMinor: positiveMoney, sourceAccountKind: accountKind, destinationAccountKind: accountKind, destinationAmountMinor: positiveMoney, destinationCurrency: currency }).strict(),
  z.object({ ...common, type: z.literal("fx_rate_update"), amountMinor: z.literal(0), currency: z.literal("USD"), effectiveAt: z.string().datetime({ offset: true }), usdToCny: positiveRate, usdToHkd: positiveRate, sourceNote: z.string().trim().min(1).max(240) }).strict(),
  z.object({ ...common, type: z.literal("investment_buy"), amountMinor: positiveMoney, investmentId, quantityMilli, unitPriceTenThousandths: referencePriceTenThousandths }).strict(),
  z.object({ ...common, type: z.literal("investment_sell"), amountMinor: z.number().int().nonnegative().max(9_999_999_999), investmentId, quantityMilli, unitPriceTenThousandths: referencePriceTenThousandths }).strict(),
  z.object({ ...common, type: z.literal("dividend"), amountMinor: positiveMoney, investmentId }).strict(),
  z.object({ ...common, type: z.literal("investment_valuation"), amountMinor: z.literal(0), investmentId, unitValueTenThousandths: z.number().int().positive().max(999_999_999_999) }).strict(),
]).superRefine((value, context) => {
  if (value.type === "account_transfer" && value.sourceAccountKind === value.destinationAccountKind) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "转出和转入账户不能相同", path: ["destinationAccountKind"] });
  }
  if (value.type === "currency_exchange" && value.currency === value.destinationCurrency) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "换汇的来源和目标币种不能相同", path: ["destinationCurrency"] });
  }
  if (["expense", "expense_refund", "reimbursement"].includes(value.type) && (("projectId" in value && Boolean(value.projectId)) !== ("project" in value && Boolean(value.project)))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "事项引用与名称快照必须同时提供", path: ["projectId"] });
  }
  if (value.type === "expense_refund" && ((Boolean(value.categoryId)) !== Boolean(value.category))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "退款分类引用与名称快照必须同时提供", path: ["categoryId"] });
  }
});

export type ProposalInput = z.infer<typeof proposalSchema>;
