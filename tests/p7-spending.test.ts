import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LedgerEvent } from "@/lib/domain/balance-calculations";
import { buildSpendingReport } from "@/lib/domain/spending-report";
import { filterLedgerActivity, normalizeLedgerFilters, ledgerDate } from "@/lib/domain/ledger-filters";
import SpendingSankey from "@/app/app/spending-sankey";
import SpendingCharts from "@/app/app/spending-charts";

const event = (id: string, type: LedgerEvent["type"], amountMinor: number, occurredAt = "2026-09-01", extra: Partial<LedgerEvent> = {}): LedgerEvent => ({ id, type, amountMinor, occurredAt, status: "posted", currency: "USD", category: "餐饮", ...extra });
const filters = normalizeLedgerFilters({});
const expense = event("expense", "expense", 10000, "2026-08-31", { accountKind: "bank", project: "旅行" });
const member = event("member", "reimbursement", 12000, "2026-08-31", { payerMemberId: "A", project: "旅行" });
const refund = event("refund", "expense_refund", 3000, "2026-09-02", { refundSourceEntryId: "expense", refundRecipient: "common", accountKind: "bank" });

describe("P7 spending occurrences, refunds and provenance", () => {
  it("uses refund dates, not source dates; September net can be negative", () => {
    const result = buildSpendingReport([expense, refund], "USD", {}, normalizeLedgerFilters({ start: "2026-09-01", end: "2026-09-03" }));
    expect(result).toMatchObject({ grossMinor: 0, refundMinor: 3000, netMinor: -3000 });
    expect(result.trend.map(p => [p.date, p.netMinor])).toEqual([["2026-09-01", 0], ["2026-09-02", -3000], ["2026-09-03", 0]]);
    expect(result.consumption.links).toHaveLength(0); expect(result.refunds.links[0]).toMatchObject({ value: 3000, recordIds: ["refund"] });
    expect(result.refunds.nodes.map(n => n.name)).toEqual(["餐饮", "共同银行"]);
  });
  it("member expense followed by full reimbursement counts once; returns and trades excluded", () => {
    const rows = [member, event("pay", "settlement", 12000), event("return", "member_return", 1000), event("buy", "investment_buy", 3000), event("div", "dividend", 1000)];
    const result = buildSpendingReport(rows, "USD", {}, filters, { A: "顾言" });
    expect(result.grossMinor).toBe(12000); expect(result.records).toHaveLength(1);
    expect(result.consumption.nodes.map(n => n.name)).toEqual(["成员代付 · 顾言", "餐饮", "旅行"]);
    expect(result.consumption.links).toHaveLength(2); expect(result.consumption.links.every(l => l.value === 12000)).toBe(true);
  });
  it("each category conserves both layers and edge record sums, even with arrows in names", () => {
    const rows = [expense, member, event("b", "expense", 5000, "2026-09-01", { accountKind: "brokerage", category: "餐饮→旅行", project: "餐饮" })];
    const result = buildSpendingReport(rows, "USD", {}, filters);
    for (const node of result.consumption.nodes.filter(n => n.layer === 1)) {
      const input = result.consumption.links.filter(l => l.target === node.id).reduce((s, l) => s + l.value, 0);
      const output = result.consumption.links.filter(l => l.source === node.id).reduce((s, l) => s + l.value, 0);
      expect(input).toBe(output);
    }
    for (const link of result.consumption.links) expect(link.value).toBe(result.records.filter(r => link.recordIds.includes(r.id)).reduce((s, r) => s + r.amountMinor!, 0));
    const inputTotal = result.consumption.links.filter(l => result.consumption.nodes.find(n => n.id === l.source)?.layer === 0).reduce((s, l) => s + l.value, 0);
    expect(inputTotal).toBe(result.grossMinor);
  });
  it("locks historical FX instead of applying new current rates, including CNY report currency", () => {
    const cny = event("cny", "expense", 72000, "2026-09-01", { currency: "CNY", fxSnapshotId: "old" });
    expect(buildSpendingReport([cny], "USD", { old: { CNY: 7.2 }, new: { CNY: 8 } }, filters).netMinor).toBe(10000);
    expect(buildSpendingReport([cny], "CNY", {}, filters).netMinor).toBe(72000);
    const result = buildSpendingReport([cny], "USD", {}, filters);
    expect(result.netMinor).toBeNull(); expect(result.consumption.links).toHaveLength(0); expect(result.records[0].originalMinor).toBe(72000);
  });
  it("splits member and common refunds by actual recipient, inheriting original category", () => {
    const personal = event("personal", "expense_refund", 5000, "2026-09-01", { refundSourceEntryId: "member", refundRecipient: "member", category: "错误类别" });
    const result = buildSpendingReport([expense, member, refund, personal], "USD", {}, filters, { A: "顾言" });
    expect(result.refunds.nodes.map(n => n.name)).toEqual(expect.arrayContaining(["餐饮", "原垫付成员 · 顾言", "共同银行"]));
    expect(result.records.find(r => r.id === "personal")?.category).toBe("餐饮");
  });
  it("reuses ledger filters including both inclusive date endpoints", () => {
    const query = normalizeLedgerFilters({ account: "bank", currency: "USD", category: "餐饮", project: "旅行", payment: "joint", start: "2026-08-31", end: "2026-09-02" });
    const domain = buildSpendingReport([expense, member, refund], "USD", {}, query);
    const rows = [expense, member, { ...refund, project: "旅行" }].map(e => ({ id: e.id, occurred_at: e.occurredAt, entry_type: e.type, account_kind: e.accountKind, currency: e.currency, category: e.category, project_name: e.project, payer_member_id: e.payerMemberId }));
    expect(domain.records.map(r => r.id)).toEqual(filterLedgerActivity(rows, query).map(r => r.id));
    expect(domain.netMinor).toBe(7000);
  });
  it("fills dates across leap days and UTC midnight without regrouping business dates", () => {
    const result = buildSpendingReport([event("leap", "expense", 100, "2024-02-29", { createdAt: "2024-03-01T00:01:00Z" })], "USD", {}, normalizeLedgerFilters({ start: "2024-02-28", end: "2024-03-01" }));
    expect(result.trend.map(p => p.date)).toEqual(["2024-02-28", "2024-02-29", "2024-03-01"]);
    expect(result.trend[1].netMinor).toBe(100);
    expect(ledgerDate("2026-02-30")).toBe(""); expect(ledgerDate("2024-02-29")).toBe("2024-02-29");
  });
  it("shows zero data without fixtures; voided records and reversed ranges are not counted", () => {
    expect(buildSpendingReport([], "USD", {}, filters)).toMatchObject({ grossMinor: 0, netMinor: 0, records: [], consumption: { links: [], nodes: [] } });
    expect(buildSpendingReport([{ ...expense, status: "voided" }], "USD", {}, filters).grossMinor).toBe(0);
    expect(buildSpendingReport([expense], "USD", {}, normalizeLedgerFilters({ start: "2026-09-02", end: "2026-09-01" })).issues).toContain("开始日期不能晚于结束日期");
  });
  it("uses full 1500-row input, independently of paginated recent rows", () => {
    const result = buildSpendingReport(Array.from({ length: 1500 }, (_, n) => event(String(n), "expense", 100)), "USD", {}, filters);
    expect(result.grossMinor).toBe(150000); expect(result.records).toHaveLength(1500); expect(result.consumption.links[0].recordIds).toHaveLength(1500);
  });
  it("zero fills calendar months for long ranges and handles upper supported dates", () => {
    const result = buildSpendingReport([event("a", "expense", 100, "2025-01-31"), event("b", "expense", 200, "2026-02-02")], "USD", {}, filters);
    expect(result.monthly).toBe(true); expect(result.trend).toHaveLength(14); expect(result.trend[1].netMinor).toBe(0);
    expect(buildSpendingReport([event("z", "expense", 100, "9999-12-31")], "USD", {}, filters).trend).toHaveLength(1);
  });
  it("renders actual SVG flows, accessible trace controls and CNY labels without negative area", () => {
    const report = buildSpendingReport([expense, refund], "CNY", { x: { CNY: 7.2 } }, filters);
    const usd = buildSpendingReport([expense, refund], "USD", {}, filters);
    const html = renderToStaticMarkup(createElement(SpendingSankey, { graph: usd.consumption, currency: "USD", select: () => {} }));
    expect(html).toContain("<svg"); expect(html).toContain('role="button"'); expect(html).toContain("共同银行 → 餐饮"); expect(html).toContain("旅行");
    const charts = renderToStaticMarkup(createElement(SpendingCharts, { report, currency: "CNY", filters, categories: [], projects: [], action: "/app" }));
    expect(charts).toContain("退款流向 · CNY"); expect(charts).not.toContain("RMB");
  });
});
