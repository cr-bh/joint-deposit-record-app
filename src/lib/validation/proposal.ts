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
const tradeQuantity = { quantityMilli: quantityMilli.optional(), quantityMicro: z.number().int().positive().max(9_999_999_999_999).optional(), unitPriceHundredMillionths: z.number().int().positive().max(9_999_999_999_999).optional() };
const basis = z.object({ quantityMicro: z.number().int().positive().safe(), throughSequence: z.string().regex(/^\d+$/), revision: z.number().int().nonnegative().safe(), signature: z.string().max(1_000_000) }).strict();
const funding = z.object({ currency, amountMinor: positiveMoney, destinationAmountMinor: positiveMoney, occurredAt: z.string().date() }).strict();
const referencePriceTenThousandths = z.number().int().positive().max(999_999_999_999).optional();
const positiveRate = z.string().trim().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,10})?$/).refine((value) => Number(value) > 0);

export const proposalSchema = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("deposit"), amountMinor: positiveMoney, payerMemberId: memberId, accountKind: accountKind.optional() }).strict(),
  z.object({ ...common, ...projectFields, type: z.literal("expense"), amountMinor: positiveMoney, category, categoryId, accountKind: accountKind.optional() }).strict(),
  z.object({ ...common, ...projectFields, type: z.literal("expense_refund"), amountMinor: positiveMoney, category: category.optional(), categoryId: categoryId.optional(), accountKind: accountKind.optional() }).strict(),
  z.object({ ...common, ...projectFields, type: z.literal("reimbursement"), amountMinor: positiveMoney, category, categoryId, payerMemberId: memberId }).strict(),
  z.object({ ...common, type: z.literal("account_transfer"), amountMinor: positiveMoney, sourceAccountKind: accountKind, destinationAccountKind: accountKind }).strict(),
  z.object({ ...common, type: z.literal("currency_exchange"), amountMinor: positiveMoney, sourceAccountKind: accountKind, destinationAccountKind: accountKind, destinationAmountMinor: positiveMoney, destinationCurrency: currency }).strict(),
  z.object({ ...common, type: z.literal("fx_rate_update"), amountMinor: z.literal(0), currency: z.literal("USD"), effectiveAt: z.string().datetime({ offset: true }), usdToCny: positiveRate, usdToHkd: positiveRate, sourceNote: z.string().trim().min(1).max(240) }).strict(),
  z.object({ ...common, type: z.literal("investment_buy"), amountMinor: positiveMoney, investmentId, ...tradeQuantity, unitPriceTenThousandths: referencePriceTenThousandths, funding: funding.optional(), linkedTransferId: z.string().uuid().optional() }).strict(),
  z.object({ ...common, type: z.literal("investment_sell"), amountMinor: z.number().int().nonnegative().max(9_999_999_999), investmentId, ...tradeQuantity, unitPriceTenThousandths: referencePriceTenThousandths }).strict(),
  z.object({ ...common, type: z.literal("dividend"), amountMinor: positiveMoney, investmentId }).strict(),
  z.object({ ...common, type: z.literal("investment_valuation"), amountMinor: z.literal(0), investmentId, unitValueTenThousandths: z.number().int().nonnegative().max(999_999_999_999).optional(), valuationMode: z.enum(["total_market", "unit_price"]).optional(), totalValueMinor: z.number().int().nonnegative().max(9_999_999_999).optional(), unitValueHundredMillionths: z.number().int().nonnegative().max(9_999_999_999_999).optional(), basis: basis.optional() }).strict(),
]).superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (value.type === "investment_buy" || value.type === "investment_sell") {
    if ((value.quantityMicro == null) === (value.quantityMilli == null)) issue("必须提供一个份额字段");
    if (value.unitPriceHundredMillionths != null && value.unitPriceTenThousandths != null) issue("参考单价不能重复");
    if (value.type === "investment_buy" && value.funding) {
      if (value.linkedTransferId) issue("新转入和已有转入不能同时使用");
      if (value.funding.occurredAt > value.occurredAt) issue("转入日期不能晚于买入日期");
      if (value.funding.currency === value.currency && value.funding.amountMinor !== value.funding.destinationAmountMinor) issue("同币种转入与到账金额必须相同");
    }
  }
  if (value.type === "investment_valuation") {
    if (value.valuationMode) {
      if (!value.basis || value.unitValueTenThousandths != null) issue("必须确认持仓基准");
      if (value.valuationMode === "total_market" ? value.totalValueMinor == null || value.unitValueHundredMillionths != null : value.unitValueHundredMillionths == null || value.totalValueMinor != null) issue("估值模式与金额不匹配");
    } else if (value.unitValueTenThousandths == null || value.basis || value.totalValueMinor != null || value.unitValueHundredMillionths != null) issue("估值字段无效");
  }
  if (value.type === "account_transfer" && value.sourceAccountKind === value.destinationAccountKind) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "转出和转入账户不能相同", path: ["destinationAccountKind"] });
  }
  if (value.type === "currency_exchange" && value.currency === value.destinationCurrency) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "换汇的来源和目标币种不能相同", path: ["destinationCurrency"] });
  }
  if (["expense", "expense_refund", "reimbursement"].includes(value.type) && (("projectId" in value && Boolean(value.projectId) && !("project" in value && Boolean(value.project))) || (value.type === "expense_refund" && Boolean(value.project) && !value.projectId))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "事项引用与名称快照必须同时提供", path: ["projectId"] });
  }
  if (value.type === "expense_refund" && ((Boolean(value.categoryId)) !== Boolean(value.category))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "退款分类引用与名称快照必须同时提供", path: ["categoryId"] });
  }
});

export type ProposalInput = z.infer<typeof proposalSchema>;
