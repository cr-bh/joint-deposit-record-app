import { describe, expect, it } from "vitest";
import { isLedgerTimeZone, ledgerToday, ledgerTimestamp } from "../src/lib/domain/ledger-time";
import { householdCreateSchema } from "../src/lib/validation/household";

describe("账本共用业务日", () => {
  it("UTC跨年时同一时刻分别属于香港1月1日、纽约12月31日", () => {
    const instant = new Date("2026-01-01T00:30:00Z");
    expect(ledgerToday("Asia/Hong_Kong",instant)).toBe("2026-01-01");
    expect(ledgerToday("America/New_York",instant)).toBe("2025-12-31");
  });
  it("UTC晚上香港已跨日；日期不受运行机器时区影响", () => {
    expect(ledgerToday("Asia/Hong_Kong",new Date("2026-09-01T16:01:00Z"))).toBe("2026-09-02");
    expect(ledgerToday("UTC",new Date("2026-09-01T16:01:00Z"))).toBe("2026-09-01");
  });
  it("夏令时跳时前后保持同一业务日", () => {
    for (const date of ["2026-03-08T06:59:00Z","2026-03-08T07:01:00Z"]) expect(ledgerToday("America/New_York",new Date(date))).toBe("2026-03-08");
    expect(ledgerTimestamp("2026-01-01T00:30:00Z","America/New_York")).toContain("2025");
  });
  it("拒绝拼写错误、固定偏移及非法时区，创建必须显式提供时区", () => {
    for (const value of ["Asia/NoSuchCity","+08:00","","GMT","UTC0"]) expect(isLedgerTimeZone(value)).toBe(false);
    for (const value of ["UTC","Asia/Shanghai","America/New_York","Etc/GMT+12"]) expect(isLedgerTimeZone(value)).toBe(true);
    expect(householdCreateSchema.safeParse({name:"测试",timeZone:"Asia/Shanghai"}).success).toBe(true);
    expect(householdCreateSchema.safeParse({name:"测试"}).success).toBe(false);
  });
});
