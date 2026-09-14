import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dashboard, InvestmentList, Ledger, NewRecordButton, PayerSelect, RecordModal } from "@/app/app/app-client";

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
    const common = { household: { id, name: "测试账本", reportingCurrency: "USD" }, investments: [investment], members: [], userId: id, close: () => {}, refresh: () => {}, setMessage: () => {}, readOnly: true };
    const generalHtml = renderToStaticMarkup(createElement(RecordModal, common));
    const investmentHtml = renderToStaticMarkup(createElement(RecordModal, { ...common, mode: "investment", initialInvestmentId: id }));
    expect(generalHtml).toContain("共同账户消费");
    expect(generalHtml).not.toContain("投资买入");
    expect(investmentHtml).toContain("测试标的 · 投资操作");
    expect(investmentHtml).toContain("当前标的：");
    expect(investmentHtml).toContain("投资买入");
    expect(investmentHtml).not.toContain("共同账户消费");
  });

  it("流水分页显示完整总数和可访问的前后页", () => {
    const html = renderToStaticMarkup(createElement(Ledger, { entries: [row], currency: "USD", members: [], totalEntries: 205, page: 2, pageCount: 3 }));
    expect(html).toContain("第 2 / 3 页");
    expect(html).toContain("本页 1 笔，共 205 笔");
    expect(html).toContain("ledgerPage=1");
    expect(html).toContain("ledgerPage=3");
  });
});
