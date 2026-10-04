"use client";
import MigrationReport from "./migration-report";
import { createUUID } from "@/lib/uuid";
import { useEffect, useState } from "react";
import { managementOverview, managementPlanSchema, type ManagementPlan } from "@/lib/domain/household-management";

const money = (value: number | null, currency: string) => value === null ? "待核对" : `${currency} ${new Intl.NumberFormat("en-US",{style:"currency",currency}).format(value/100)}`;
export function HouseholdManagementDetails({ snapshot, reason }: { snapshot: unknown; reason?: string }) {
  let overview: ReturnType<typeof managementOverview> | undefined;
  let currency = "USD";
  try {
    overview = managementOverview(snapshot);
    currency = managementPlanSchema.shape.snapshot.parse(snapshot).configuration.reporting_currency;
  } catch { /* Data errors become a visible incomplete state below. */ }
  if (!overview) return <p className="text-red-700">归档快照无法核算，请刷新并核对；不能将缺失数据显示为零。</p>;
  return <div className="space-y-3 rounded-xl border bg-[#f7f6f1] p-4 text-sm">{reason && <p>理由：{reason}</p>}<p className="font-semibold">只关闭记录，不转账、不分割资产、不清零债务。恢复仍需另一位成员批准。</p><div className="grid gap-2 sm:grid-cols-2">{[["共同现金",overview.cashMinor],["投资市值",overview.investmentMinor],["资产总额",overview.assetsMinor],["未报销垫款",overview.payablesMinor],["成员应返款",overview.receivablesMinor],["共同净额",overview.netMinor]].map(([label,value]) => <p key={String(label)}>{label}：<b>{money(value as number|null,currency)}</b></p>)}</div><details><summary className="cursor-pointer">银行/券商、持仓与未清往来明细</summary>{(["bank","brokerage"] as const).map(account => <p key={account}>共同{account === "bank" ? "银行" : "券商"}：{Object.entries(overview.balances[account]).map(([code,value]) => money(value,code)).join(" · ")}</p>)}{overview.prices.map(price => <p key={price.id}>{price.name} · {money(price.marketMinor,price.currency)} · {price.error ?? (price.estimated ? "成本暂估" : `估值 ${price.valueDate}`)}</p>)}{Object.keys(overview.debtByCurrency).map(code => <p key={code}>{code} 欠款 {money(overview.debtByCurrency[code as "USD"],code)} · 应返 {money(overview.recoveryByCurrency[code as "USD"],code)}</p>)}</details>{overview.issues.map(issue => <p key={issue} className="text-amber-800">{issue}</p>)}</div>;
}

export default function HouseholdManagement({ householdId, close, refresh, notify, previewPlan }: { householdId: string; close: () => void; refresh: () => void; notify: (message: string) => void; previewPlan?: ManagementPlan }) {
  const [plan,setPlan] = useState(previewPlan), [error,setError] = useState(""), [reason,setReason] = useState(""), [busy,setBusy] = useState(false);
  const [key] = useState(() => createUUID());
  useEffect(() => {
    if (previewPlan) return;
    const abort = new AbortController();
    fetch(`/api/households/management?householdId=${householdId}`,{cache:"no-store",signal:abort.signal}).then(async response => {
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "核对信息读取失败");
      if (!abort.signal.aborted) setPlan(managementPlanSchema.parse(body));
    }).catch(error => { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : "核对信息读取失败"); });
    return () => abort.abort();
  },[householdId,previewPlan]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!plan || busy || plan.blockers.length) return;
    if (previewPlan) return notify("只读演示不会归档、恢复或提交审批。");
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/households/management",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({householdId,action:plan.status === "active" ? "archive" : "restore",reason,expectedVersion:plan.version,idempotencyKey:key})});
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "提交失败");
      notify("已提交，请另一位成员在审批中心核对并批准。");close();refresh();
    } catch(error) { setError(`${error instanceof Error ? error.message : "提交失败"} 草稿已保留。`); } finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"><section role="dialog" aria-modal="true" aria-label="账本管理" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6"><div className="mb-4 flex justify-between"><h2 className="font-bold">{plan?.status === "archived" ? "申请恢复账本" : "申请归档账本"}</h2><button disabled={busy} onClick={close} aria-label="关闭">×</button></div>{plan ? <form onSubmit={submit} className="space-y-4"><p className="text-xs text-gray-500">账本版本 {plan.version} · 时区 {plan.snapshot.configuration.time_zone}{plan.archivedAt ? ` · 已归档于 ${plan.archivedAt}` : ""}</p><HouseholdManagementDetails snapshot={plan.snapshot}/><MigrationReport snapshot={plan.snapshot}/>{plan.blockers.length>0 && <div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900"><b>先处理以下事项：</b>{plan.blockers.map(item => <p key={item}>{item}</p>)}</div>}{plan.migrationIssues.length>0 && <details className="text-sm"><summary>历史待核对清单（{plan.migrationIssues.length}）</summary>{plan.migrationIssues.map(item => <p key={String(item.id)}>{String(item.title)} · {String(item.reason)} · {String(item.id)}</p>)}</details>}<label className="block text-sm">申请理由<textarea required maxLength={500} disabled={busy} value={reason} onChange={e => setReason(e.target.value)} className="mt-1 min-h-20 w-full rounded-xl border p-3"/></label><button disabled={busy || plan.blockers.length>0 || !reason.trim()} className="w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white disabled:opacity-40">{busy ? "提交中…" : plan.status === "archived" ? "提交恢复申请" : "提交归档申请"}</button></form> : !error && <p>正在读取同版本账本快照…</p>}{error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}</section></div>;
}
