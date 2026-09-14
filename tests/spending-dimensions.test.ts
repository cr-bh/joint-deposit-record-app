import { describe, expect, it } from "vitest";
import { activeSpendingDimensions, defaultSpendingCategoryNames, spendingDimensionFromRow } from "@/lib/domain/spending-dimensions";
import { filterLedgerActivity, normalizeLedgerFilters } from "@/lib/domain/ledger-filters";

const id = "00000000-0000-4000-8000-000000000001";

describe("P2 用途分类、事项与流水筛选", () => {
  it("保留原分类并新增玩乐、日用和购物，币种名称不使用 RMB", () => {
    expect(defaultSpendingCategoryNames).toEqual(expect.arrayContaining(["日常生活", "餐饮", "玩乐", "日用", "购物"]));
    expect(defaultSpendingCategoryNames.join(" ")).not.toContain("RMB");
  });

  it("数据库适配器保留归档状态，新记录只能选未归档项", () => {
    const active = spendingDimensionFromRow({ id, name: "餐饮", archived_at: null, is_system: true });
    const archived = spendingDimensionFromRow({ id: "00000000-0000-4000-8000-000000000002", name: "旧事项", archived_at: "2026-09-14T00:00:00Z" });
    expect(active).toMatchObject({ name: "餐饮", isSystem: true, archivedAt: undefined });
    expect(activeSpendingDimensions([active,archived])).toEqual([active]);
  });

  it("先筛选完整活动再分页时，共同账户消费与成员代付可按同一事项聚合", () => {
    const rows = [
      { id: "1", entry_type: "expense", account_kind: "bank", currency: "USD", category: "餐饮", project_name: "2026 香港旅行" },
      { id: "2", entry_type: "reimbursement", currency: "USD", category: "交通", project_name: "2026 香港旅行", payer_member_id: id },
      { id: "3", entry_type: "expense", account_kind: "bank", currency: "CNY", category: "日用", project_name: "搬家" },
    ];
    const trip = filterLedgerActivity(rows,normalizeLedgerFilters({ project: " 2026 香港旅行 " }));
    expect(trip.map((row) => row.id)).toEqual(["1","2"]);
    expect(filterLedgerActivity(rows,normalizeLedgerFilters({ payment: "member" }))).toEqual([rows[1]]);
    expect(filterLedgerActivity(rows,normalizeLedgerFilters({ account: "invalid" }))).toEqual(rows);
  });
});
