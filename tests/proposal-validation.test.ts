import { describe, expect, it } from "vitest";
import { proposalSchema } from "@/lib/validation/proposal";

const base = {
  householdId: "00000000-0000-4000-8000-000000000001",
  currency: "USD" as const,
  occurredAt: "2026-09-12",
  title: "测试记录",
  idempotencyKey: "00000000-0000-4000-8000-000000000002",
};
const investmentId = "00000000-0000-4000-8000-000000000003";
const payerMemberId = "00000000-0000-4000-8000-000000000004";
const categoryId = "00000000-0000-4000-8000-000000000005";
const projectId = "00000000-0000-4000-8000-000000000006";

describe("按提案类型校验 AC-02/05/21/76", () => {
  it("共同消费必须有类别且金额为正", () => {
    expect(proposalSchema.safeParse({ ...base, type: "expense", amountMinor: 100, category: "餐饮", categoryId }).success).toBe(true);
    expect(proposalSchema.safeParse({ ...base, type: "expense", amountMinor: 100 }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...base, type: "expense", amountMinor: 0, category: "餐饮", categoryId }).success).toBe(false);
  });

  it("个人存入与成员代付必须明确实际付款人", () => {
    expect(proposalSchema.safeParse({ ...base, type: "deposit", amountMinor: 100, payerMemberId }).success).toBe(true);
    expect(proposalSchema.safeParse({ ...base, type: "deposit", amountMinor: 100 }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...base, type: "reimbursement", amountMinor: 100, category: "餐饮", categoryId, payerMemberId }).success).toBe(true);
    expect(proposalSchema.safeParse({ ...base, type: "reimbursement", amountMinor: 100, category: "餐饮", categoryId }).success).toBe(false);
  });

  it("买入必须有标的、数量及实际总扣款，参考价可选", () => {
    const buy = { ...base, type: "investment_buy", amountMinor: 100_200, investmentId, quantityMilli: 100_000 };
    expect(proposalSchema.safeParse(buy).success).toBe(true);
    expect(proposalSchema.safeParse({ ...buy, quantityMilli: undefined }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...buy, amountMinor: 0 }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...buy, unitPriceTenThousandths: 100000 }).success).toBe(true);
    expect(proposalSchema.safeParse({ ...buy, unitPriceMinor: 1000 }).success).toBe(false);
  });

  it("卖出允许净到账为零，但不允许负数或缺数量", () => {
    const sell = { ...base, type: "investment_sell", amountMinor: 0, investmentId, quantityMilli: 10_000 };
    expect(proposalSchema.safeParse(sell).success).toBe(true);
    expect(proposalSchema.safeParse({ ...sell, amountMinor: -1 }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...sell, quantityMilli: undefined }).success).toBe(false);
  });

  it("分红必须关联标的；估值金额固定为零且必须有单位估值", () => {
    expect(proposalSchema.safeParse({ ...base, type: "dividend", amountMinor: 500, investmentId }).success).toBe(true);
    expect(proposalSchema.safeParse({ ...base, type: "dividend", amountMinor: 500 }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...base, type: "investment_valuation", amountMinor: 0, investmentId, unitValueTenThousandths: 123400 }).success).toBe(true);
    expect(proposalSchema.safeParse({ ...base, type: "investment_valuation", amountMinor: 1, investmentId, unitValueTenThousandths: 123400 }).success).toBe(false);
  });

  it("拒绝多余字段、非UUID幂等键和非法日期文本", () => {
    expect(proposalSchema.safeParse({ ...base, type: "deposit", amountMinor: 100, payerMemberId, unexpected: true }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...base, type: "deposit", amountMinor: 100, payerMemberId, idempotencyKey: "draft-1" }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...base, type: "deposit", amountMinor: 100, payerMemberId, occurredAt: "09/12/2026" }).success).toBe(false);
  });

  it("接受同币种跨账户划转并拒绝同账户划转", () => {
    const transfer = { ...base, type: "account_transfer", amountMinor: 20_000, sourceAccountKind: "bank", destinationAccountKind: "brokerage" };
    expect(proposalSchema.safeParse(transfer).success).toBe(true);
    expect(proposalSchema.safeParse({ ...transfer, destinationAccountKind: "bank" }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...transfer, sourceAccountKind: "wallet" }).success).toBe(false);
  });

  it("允许现金记录明确选择账户和三种原币", () => {
    expect(proposalSchema.safeParse({ ...base, type: "expense", amountMinor: 100, category: "餐饮", categoryId, currency: "CNY", accountKind: "brokerage" }).success).toBe(true);
    expect(proposalSchema.safeParse({ ...base, type: "reimbursement", amountMinor: 100, category: "餐饮", categoryId, payerMemberId, accountKind: "bank" }).success).toBe(false);
  });

  it("消费和代付共享分类及可选事项，禁止把事件类型当分类", () => {
    const spending = { ...base, type: "expense", amountMinor: 100, category: "餐饮", categoryId, project: "2026 香港旅行", projectId };
    expect(proposalSchema.safeParse(spending).success).toBe(true);
    expect(proposalSchema.safeParse({ ...spending, projectId: undefined }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...spending, category: "代付" }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...spending, categoryId: undefined }).success).toBe(false);
  });

  it("真实换汇保存两侧实际金额并要求不同币种", () => {
    const exchange = { ...base, type: "currency_exchange", amountMinor: 72_000, currency: "CNY", sourceAccountKind: "bank", destinationAccountKind: "brokerage", destinationAmountMinor: 9_500, destinationCurrency: "USD" };
    expect(proposalSchema.safeParse(exchange).success).toBe(true);
    expect(proposalSchema.safeParse({ ...exchange, destinationCurrency: "CNY" }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...exchange, destinationAmountMinor: 0 }).success).toBe(false);
  });

  it("汇率更新必须提交完整USD基准快照和有效时间", () => {
    const update = { ...base, type: "fx_rate_update", amountMinor: 0, effectiveAt: "2026-09-14T12:00:00Z", usdToCny: "7.20000000", usdToHkd: "7.80000000", sourceNote: "双方核对的手动汇率" };
    expect(proposalSchema.safeParse(update).success).toBe(true);
    expect(proposalSchema.safeParse({ ...update, usdToCny: "0" }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...update, usdToHkd: "7.12345678901" }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...update, effectiveAt: "2026-09-14" }).success).toBe(false);
  });
});
