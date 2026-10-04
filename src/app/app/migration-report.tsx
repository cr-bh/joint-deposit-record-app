"use client";
import { useMemo, useState } from "react";
import { migrationInventory } from "@/lib/domain/migration-rehearsal";

export default function MigrationReport({ snapshot }: { snapshot: unknown }) {
  const [page, setPage] = useState(0);
  const report = useMemo(() => {
    try { return { data: migrationInventory(snapshot), error: "" }; }
    catch { return { data: null, error: "原始资料不完整，核对报告读取失败；不能将缺失事实视为已确认。" }; }
  }, [snapshot]);
  if (!report.data) return <p className="text-sm text-red-700">{report.error}</p>;
  const { issues, entries, investments, policy } = report.data;
  const pages = Math.max(1, Math.ceil(issues.length / 50)), current = Math.min(page, pages - 1);
  return <details className="rounded-xl border p-3 text-sm"><summary className="cursor-pointer font-semibold">旧数据核对报告 · {issues.length ? `${issues.length} 项待核对` : "未发现已检查的历史疑点"}</summary><div className="mt-3 space-y-3"><p>{entries} 条流水 · {investments} 个标的。{policy}。</p><p className="text-xs leading-5 text-gray-500">此报告只读，检查付款成员、原单分配、账户归属、历史汇率、数量与价格精度。迁移期初须由双方核对，不能把期初与切换日前流水再计算一次。</p>{issues.length ? <><ul className="space-y-2">{issues.slice(current * 50, current * 50 + 50).map((item, index) => <li key={`${item.id}-${item.category}-${index}`} className="rounded-lg bg-amber-50 p-3 text-amber-900"><p>{item.reason}</p><p className="mt-1 break-all text-xs">原始记录：{item.id}</p></li>)}</ul>{pages > 1 && <div className="flex items-center justify-between"><button disabled={!current} onClick={() => setPage(current - 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">上一页</button><span>{current + 1} / {pages}</span><button disabled={current === pages - 1} onClick={() => setPage(current + 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">下一页</button></div>}</> : <p className="text-[#1f5243]">当前资料没有上述疑点。此结果不替代双方对真实账目和余额的核对。</p>}</div></details>;
}
