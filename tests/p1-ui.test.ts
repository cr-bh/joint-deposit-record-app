import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountCashCards, Dashboard, FxRateModal, FxRatePanel, InvestmentList, Ledger, LedgerSettings, NewRecordButton, PayerSelect, RecordModal } from "@/app/app/app-client";

const id = "00000000-0000-4000-8000-000000000001";
const row = { id, title: "测试存入", entry_type: "deposit", amount_minor: 10000, currency: "USD", status: "posted", occurred_at: "2026-09-01", created_at: "2026-09-01T00:00:00Z" };

describe("P1 页面金额回归（服务端组件渲染，非双人E2E）", () => {
  it("总览显示原币余额及缺汇率提示，不能展示USD820", () => {
    const html = renderToStaticMarkup(createElement(Dashboard, { currency: "USD", entries: [row, { ...row, id: "00000000-0000-4000-8000-000000000002", currency: "CNY", amount_minor: 72000 }] }));
    expect(html).toContain("待完善汇率");
    expect(html).toContain("CNY");
    expect(html).toContain("$100.00");
    expect(html).not.toContain("$820.00");
  });
  it("损坏流水显示核算错误，不显示零余额", () => {
    const html = renderToStaticMarkup(createElement(Dashboard, { currency: "USD", entries: [{ ...row, amount_minor: null }] }));
    expect(html).toContain("流水数据无法核算");
    expect(html).not.toContain("$0.00");
  });
  it("未录价格保留原投资卡片，并显示成本暂估/待估值", () => {
    const html = renderToStaticMarkup(createElement(InvestmentList, { currency: "USD", entries: [{ ...row, entry_type: "investment_buy", investment_id: id, quantity_milli: 10000 }], investments: [{ id, name: "测试标的", currency: "USD", opening_quantity_milli: 0, opening_cost_minor: 0 }], valuations: [], openCreate: () => {}, openAction: () => {} }));
    expect(html).toContain("当前市值（成本暂估）");
    expect(html).toContain("$100.00");
    expect(html).toContain("待估值");
    expect(html).toContain("最近交易");
    expect(html).toContain("投资操作");
    expect(html).not.toContain("页面顶部“新建账本记录”");
    expect(html).not.toContain("更新最新价格");
  });
  it("新建个人存入时显示账本成员作为实际付款人", () => {
    const members = [
      { user_id: id, profiles: { display_name: "顾言" } },
      { user_id: "00000000-0000-4000-8000-000000000002", profiles: { display_name: "林知夏" } },
    ];
    const html = renderToStaticMarkup(createElement(PayerSelect, { members, userId: id, value: id, onChange: () => {} }));
    expect(html).toContain("实际付款人");
    expect(html).toContain("顾言（我）");
    expect(html).toContain("林知夏");
  });
  it("通用记录入口明确属于整个账本", () => {
    const html = renderToStaticMarkup(createElement(NewRecordButton, { open: () => {} }));
    expect(html).toContain("新建账本记录");
  });

  it("账户记录与标的投资操作使用各自的类型范围", () => {
    const investment = { id, name: "测试标的", currency: "USD", opening_quantity_milli: 0, opening_cost_minor: 0 };
    const common = { household: { id, name: "测试账本", reportingCurrency: "USD" }, investments: [investment], members: [], userId: id, spendingCategories: [{ id, name: "购物", isSystem: true }], spendingProjects: [{ id: "00000000-0000-4000-8000-000000000002", name: "2026 香港旅行", isSystem: false }], close: () => {}, refresh: () => {}, setMessage: () => {}, readOnly: true };
    const generalHtml = renderToStaticMarkup(createElement(RecordModal, common));
    const investmentHtml = renderToStaticMarkup(createElement(RecordModal, { ...common, mode: "investment", initialInvestmentId: id }));
    expect(generalHtml).toContain("共同账户消费");
    expect(generalHtml).toContain("银行 / 券商内部划转");
    expect(generalHtml).toContain("实际换汇");
    expect(generalHtml).toContain("入账账户");
    expect(generalHtml).toContain("消费分类");
    expect(generalHtml).toContain("购物");
    expect(generalHtml).toContain("2026 香港旅行");
    expect(generalHtml).not.toContain("投资买入");
    expect(investmentHtml).toContain("测试标的 · 投资操作");
    expect(investmentHtml).toContain("当前标的：");
    expect(investmentHtml).toContain("投资买入");
    expect(investmentHtml).toContain("结算账户：共同券商");
    expect(investmentHtml).not.toContain("共同账户消费");
  });

  it("两类现金账户按原币显示余额并明确标出负数", () => {
    const html = renderToStaticMarkup(createElement(AccountCashCards, { accounts: [{ kind: "bank", name: "家庭银行" }], balances: { bank: { USD: 40_000, CNY: 0, HKD: 0 }, brokerage: { USD: -18_000, CNY: 7_200, HKD: 0 } } }));
    expect(html).toContain("家庭银行");
    expect(html).toContain("共同券商");
    expect(html).toContain("-$180.00");
    expect(html).toContain("内部划转只改变资金所在账户");
  });

  it("划转流水显示方向且不伪装成收支", () => {
    const transfer = { id, title: "转入券商", entry_type: "account_transfer", amount_minor: 20_000, currency: "USD", status: "posted", occurred_at: "2026-09-02", source_account_kind: "bank", destination_account_kind: "brokerage" };
    const html = renderToStaticMarkup(createElement(Ledger, { entries: [transfer], currency: "USD", members: [], totalEntries: 1 }));
    expect(html).toContain("账户内部划转");
    expect(html).toContain("共同银行 → 共同券商");
  });

  it("实际换汇流水同时显示真实扣除和到账金额", () => {
    const exchange = { id, title: "美元换港币", entry_type: "currency_exchange", movement_type: "currency_exchange", amount_minor: 10_000, currency: "USD", destination_amount_minor: 78_000, destination_currency: "HKD", fx_snapshot_id: id, status: "posted", occurred_at: "2026-09-02", source_account_kind: "bank", destination_account_kind: "bank" };
    const snapshot = { id, usdToCny: 7.2, usdToHkd: 7.8, effectiveAt: "2026-09-01T00:00:00Z", sourceNote: "人工录入", createdBy: id, approvedBy: id, approvedAt: "2026-09-01T00:00:00Z" };
    const html = renderToStaticMarkup(createElement(Ledger, { entries: [exchange], currency: "USD", members: [], fxSnapshots: [snapshot], totalEntries: 1 }));
    expect(html).toContain("实际换汇");
    expect(html).toContain("实际扣除 $100.00");
    expect(html).toContain("实际到账 HK$780.00");
    expect(html).toContain("换汇净额折算差额（可能包含价差及费用）：$0.00");
  });

  it("汇率面板明确方向、人工来源和过期提示", () => {
    const snapshot = { id, usdToCny: 7.2, usdToHkd: 7.8, effectiveAt: "2026-09-01T00:00:00Z", sourceNote: "银行 App 人工录入", createdBy: id, approvedBy: id, approvedAt: "2026-09-01T00:00:00Z", stale: true };
    const html = renderToStaticMarkup(createElement(FxRatePanel, { snapshot, open: () => {} }));
    expect(html).toContain("手动汇率");
    expect(html).toContain("1 USD = <b>7.2</b> CNY");
    expect(html).toContain("1 USD = <b>7.8</b> HKD");
    expect(html).toContain("已超过24小时，仅提示不禁用");
  });

  it("汇率提交要求完整快照并说明批准前不生效", () => {
    const current = { id, usdToCny: 7.2, usdToHkd: 7.8, effectiveAt: "2026-09-01T00:00:00Z", sourceNote: "银行 App 人工录入", createdBy: id, approvedBy: id, approvedAt: "2026-09-01T00:00:00Z", stale: false };
    const html = renderToStaticMarkup(createElement(FxRateModal, { close: () => {}, household: { id, name: "测试账本", reportingCurrency: "USD" }, current, refresh: () => {}, setMessage: () => {}, readOnly: true }));
    expect(html).toContain("完整快照");
    expect(html).toContain("1 USD = 多少 CNY");
    expect(html).toContain("1 USD = 多少 HKD");
    expect(html).toContain("批准后才生效");
    expect(html).toContain("不会获取实时市场行情");
  });

  it("流水分页显示完整总数和可访问的前后页", () => {
    const html = renderToStaticMarkup(createElement(Ledger, { entries: [{ ...row, category: "餐饮", project_name: "2026 香港旅行" }], currency: "USD", members: [], totalEntries: 205, page: 2, pageCount: 3, filters: { account: "bank", currency: "USD", category: "餐饮", project: "2026 香港旅行", payment: "joint" }, categories: [{ id, name: "餐饮", isSystem: true }], projects: [{ id, name: "2026 香港旅行", isSystem: false }] }));
    expect(html).toContain("第 2 / 3 页");
    expect(html).toContain("本页 1 笔，共 205 笔");
    expect(html).toContain("ledgerPage=1");
    expect(html).toContain("ledgerPage=3");
    expect(html).toContain("account=bank");
    expect(html).toContain("category=%E9%A4%90%E9%A5%AE");
    expect(html).toContain("支付方式");
    expect(html).toContain("事项：2026 香港旅行");
  });

  it("账本设置支持共享分类、事项与不改历史的归档", () => {
    const html = renderToStaticMarkup(createElement(LedgerSettings, { close: () => {}, household: { id, name: "测试账本", reportingCurrency: "USD" }, categories: [{ id, name: "玩乐", isSystem: true }], projects: [{ id: "00000000-0000-4000-8000-000000000002", name: "旧事项", archivedAt: "2026-09-01T00:00:00Z", isSystem: false }], refresh: () => {}, setMessage: () => {}, readOnly: true }));
    expect(html).toContain("账本设置 · 用途");
    expect(html).toContain("双方共享");
    expect(html).toContain("代付和报销属于事件类型");
    expect(html).toContain("玩乐 · 内置");
    expect(html).toContain("旧事项");
    expect(html).toContain("恢复");
  });
});
