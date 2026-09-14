import { describe, expect, it } from "vitest";
import { fetchAllPages, paginateLedgerRows, parseLedgerPage, readConsistentSnapshot } from "@/lib/server/ledger-snapshot";

describe("流水列表分页", () => {
  it.each([undefined, "", "0", "-1", "1.5", "abc", "9007199254740992"])("非法页码 %s 回到第一页", (value) => {
    expect(parseLedgerPage(value)).toBe(1);
  });

  it("按页切分且将超过末页的请求收敛到末页", () => {
    const rows = Array.from({ length: 205 }, (_, id) => ({ id }));
    expect(paginateLedgerRows(rows, 2)).toMatchObject({ page: 2, pageCount: 3, rows: rows.slice(100, 200) });
    expect(paginateLedgerRows(rows, 99)).toMatchObject({ page: 3, pageCount: 3, rows: rows.slice(200) });
  });
});

describe("服务端全量账本分页 AC-07", () => {
  it.each([1500, 10_000])("读取 %i 条时不会被单页上限截断", async (size) => {
    const source = Array.from({ length: size }, (_, id) => ({ id }));
    const rows = await fetchAllPages(async (from, to) => ({ data: source.slice(from, to + 1), error: null }));
    expect(rows).toHaveLength(size);
    expect(rows.at(-1)?.id).toBe(size - 1);
  });

  it("任一分页失败时不返回部分账本", async () => {
    await expect(fetchAllPages(async (from) => from === 0
      ? { data: Array.from({ length: 500 }, (_, id) => ({ id })), error: null }
      : { data: null, error: { message: "第二页读取失败" } }
    )).rejects.toThrow("第二页读取失败");
  });
});

describe("账本版本一致性读取", () => {
  it("版本变化时丢弃混合快照并整体重读", async () => {
    const versions = [4, 5, 5, 5];
    let reads = 0;
    const result = await readConsistentSnapshot(async () => versions.shift()!, async () => ({ read: ++reads }));
    expect(result).toEqual({ version: 5, snapshot: { read: 2 } });
  });

  it("持续变化时明确失败", async () => {
    let version = 0;
    await expect(readConsistentSnapshot(async () => version++, async () => ({}), 2)).rejects.toThrow("账本正在更新");
  });
});
