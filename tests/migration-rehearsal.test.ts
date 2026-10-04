import { describe, expect, it } from "vitest";
import { migrationInventory, rehearseMigration } from "@/lib/domain/migration-rehearsal";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const row = (n: number, type: string, amount: number, date: string, extra = {}) => ({ id: id(n), entry_type: type, amount_minor: amount, currency: "USD", occurred_at: date, created_at: `${date}T12:00:00Z`, status: "posted", title: "历史", effective_sequence: String(n), ...extra });
function fixture() {
  return { configuration: { name: "迁移样例", reporting_currency: "USD", time_zone: "UTC", time_zone_confirmed: true, status: "active" }, capturedAt: "2026-10-04T12:00:00Z", currentFxId: null,
    entries: [row(1,"deposit",100000,"2026-09-01"),row(2,"investment_buy",20000,"2026-09-02",{investment_id:id(10),quantity_milli:2000}),row(3,"expense",10000,"2026-09-10",{account_kind:"bank"}),row(4,"investment_sell",15000,"2026-09-11",{investment_id:id(10),quantity_milli:1000,account_kind:"brokerage"})],
    investments: [{id:id(10),name:"旧标的",currency:"USD",opening_quantity_milli:0,opening_cost_minor:0}], valuations: [], proposals: [], members: [], accounts: [], transfers: [], fxSnapshots: [], spendingCategories: [], spendingProjects: [], reimbursementClaims: [], settlementAllocations: [], settlementBatches: [], voidRequests: [] };
}
const plan = {cutoffDate:"2026-09-05",cash:{bank:{USD:50000,CNY:0,HKD:0},brokerage:{USD:30000,CNY:0,HKD:0}},investments:[{id:id(10),mode:"opening",quantityMilli:2000,costMinor:20000}]};
describe("P8 legacy inventory and isolated migration rehearsal", () => {
  it("splits cash conservatively and replays only post-cutoff cash/holdings, retaining history", () => {
    const data=fixture(), original=structuredClone(data), result=rehearseMigration(data,plan);
    expect(result.cash).toEqual({bank:{USD:40000,CNY:0,HKD:0},brokerage:{USD:45000,CNY:0,HKD:0}});
    expect(result.positions[0]).toMatchObject({newPosition:{quantityMilli:1000,remainingCostMinor:10000,realizedGainMinor:5000},quantityDeltaMicro:0,costDeltaMinor:0});
    expect(result.retainedHistoryCount).toBe(2); expect(result.contributionAddedMinor).toBe(0);
    expect(rehearseMigration(data,plan)).toEqual(result); expect(data).toEqual(original);
  });
  it("rejects nonconserving balances, duplicate modes and full-history plus opening ambiguity", () => {
    expect(()=>rehearseMigration(fixture(),{...plan,cash:{...plan.cash,bank:{USD:50001,CNY:0,HKD:0}}})).toThrow("期初合计");
    expect(()=>rehearseMigration(fixture(),{...plan,investments:[...plan.investments,...plan.investments]})).toThrow("只能");
    expect(()=>rehearseMigration(fixture(),{...plan,investments:[{id:id(10),mode:"full_history",quantityMilli:2000,costMinor:20000}]})).toThrow();
    expect(rehearseMigration(fixture(),{...plan,investments:[{id:id(10),mode:"full_history"}]}).positions[0].costDeltaMinor).toBe(0);
  });
  it("does not infer a legacy payer/payee, payment allocation or historic FX from submitter/current rates", () => {
    const data=fixture(); data.entries.push(row(5,"reimbursement",72000,"2026-09-01",{currency:"CNY",member_id:id(21)}),row(6,"settlement",10000,"2026-09-02",{member_id:id(21)}));
    const report=migrationInventory(data);
    expect(report.issues).toEqual(expect.arrayContaining([expect.objectContaining({id:id(5),category:"member"}),expect.objectContaining({id:id(5),category:"fx"}),expect.objectContaining({id:id(6),category:"allocation"})]));
    expect(data.entries.at(-2)).not.toHaveProperty("payer_member_id");
  });
  it("accepts legitimate six-decimal quantities without inventing a legacy precision discrepancy", () => {
    const data=fixture();const entry=row(8,"investment_buy",1000,"2026-09-12",{investment_id:id(10),quantity_milli:1234,quantity_micro:1234567,proposal_id:id(50),account_kind:"brokerage"});
    const input={...data,entries:[...data.entries,entry],proposals:[{id:id(50),payload:{quantityMicro:1234567}}]};
    expect(migrationInventory(input).issues.filter(i=>i.id===id(8)&&i.category==="precision")).toHaveLength(0);
  });
  it("reports malformed values instead of calculating a false zero", () => {
    const data=fixture();data.entries.push(row(7,"deposit",Number.NaN,"2026-09-01"));
    expect(migrationInventory(data).issues).toContainEqual(expect.objectContaining({id:id(7),category:"data"}));
    expect(()=>rehearseMigration(data,plan)).toThrow();
  });
});
