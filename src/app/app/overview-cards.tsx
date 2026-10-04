"use client";
import { useLedgerTimeZone } from "./ledger-clock";
import { ledgerTimestamp } from "@/lib/domain/ledger-time";
import type { OverviewSummary } from "@/lib/domain/overview-summary";

const money = (minor: number, currency: string) => `${currency} ${new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100)}`;

export default function OverviewCards({ summary, currency, fxTime, pendingCount }: { summary: OverviewSummary; currency: string; fxTime?: string; pendingCount: number }) {
  const timeZone = useLedgerTimeZone();
  const value = (amount: number | null) => amount === null ? "待核对 / 待完善汇率" : money(amount, currency);
  const when = fxTime ? ledgerTimestamp(fxTime,timeZone) + `（${timeZone}）` : "尚无已批准快照；同币种金额可直接核算";
  return <div className="space-y-4">
    <p className="text-xs leading-5 text-gray-500">当前全部账本资产 · 汇率更新时间：{when}</p>
    <div className="grid gap-4 md:grid-cols-3">{[["共同现金", summary.cashMinor], ["共同投资资产", summary.investmentMinor], ["共同资产总额", summary.assetsMinor]].map(([label, amount]) => <section key={String(label)} className="rounded-2xl border bg-white p-5"><p className="text-xs text-gray-500">{label}</p><p className="mt-3 break-words text-2xl font-bold">{value(amount as number | null)}</p><p className="mt-2 text-xs text-gray-500">{label === "共同投资资产" ? summary.estimated ? "包含成本暂估 · 部分标的待估值" : "仅已持有标的市值" : label === "共同现金" ? "银行现金 + 券商未投资现金" : "共同现金 + 共同投资资产"}</p></section>)}</div>
    <div className="grid gap-3 md:grid-cols-3">{[["未报销垫款", summary.payablesMinor], ["成员应返共同款", summary.receivablesMinor], ["扣除往来后的净额", summary.netMinor]].map(([label, amount]) => <section key={String(label)} className={`rounded-2xl border p-4 ${label === "扣除往来后的净额" ? "bg-[#e6eee7]" : "bg-white"}`}><p className="text-xs text-gray-600">{label}</p><p className="mt-2 break-words text-xl font-bold">{value(amount as number | null)}</p></section>)}</div>
    <p className="text-xs leading-5 text-gray-500">净额 = 共同资产总额 − 未报销垫款 + 成员应返共同款。{pendingCount} 笔待审批独立保留，未计入正式资产。</p>
    {summary.issues.map(issue => <p key={issue} className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{issue}</p>)}
    <details className="rounded-2xl border bg-white p-4 text-sm"><summary className="cursor-pointer font-semibold">投资估值与往来原币明细</summary><div className="mt-3 space-y-2">{summary.prices.length === 0 && <p className="text-gray-500">暂无持有投资。</p>}{summary.prices.map(price => <p key={price.id} className="break-words">{price.name} · {price.marketMinor === null ? "待核对" : money(price.marketMinor, price.currency)} · {price.error ?? (price.estimated ? "成本暂估 / 待估值" : `估值日期 ${price.valueDate}`)}</p>)}{Object.entries(summary.debtByCurrency).map(([code, amount]) => <p key={code}>{code} · 未报销 {money(amount, code)} · 应返 {money(summary.recoveryByCurrency[code as keyof typeof summary.recoveryByCurrency], code)}</p>)}</div></details>
  </div>;
}
