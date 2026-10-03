import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend, ReferenceLine } from "recharts";
import type { FlowEdge, SpendingReport } from "@/lib/domain/spending-report";
import type { LedgerFilters } from "@/lib/domain/ledger-filters";
import type { SpendingDimension } from "@/lib/domain/spending-dimensions";
import SpendingSankey from "./spending-sankey";

const money = (minor: number, currency: string) => `${currency} ${new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100)}`;
export default function SpendingCharts({ report, currency, filters, categories, projects, action }: { report: SpendingReport; currency: string; filters: LedgerFilters; categories: SpendingDimension[]; projects: SpendingDimension[]; action: string }) {
  const [selected, setSelected] = useState<{ ids: string[]; title: string } | null>(null);
  const [page, setPage] = useState(0);
  const detailsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected) { detailsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); detailsRef.current?.focus({ preventScroll: true }); }
  }, [selected]);
  const records = selected ? report.records.filter(r => selected.ids.includes(r.id)) : [];
  const select = (edge: FlowEdge, title: string) => { setPage(0); setSelected({ ids: edge.recordIds, title }); };
  const input = "w-full rounded-xl border bg-white p-2.5 text-sm";
  return <div className="space-y-5">
    <section className="rounded-2xl border bg-white p-5">
      <h2 className="font-bold">消费分析</h2><p className="mt-1 text-xs leading-5 text-gray-500">筛选仅影响消费图表；上方资产始终为当前全部账本。按记录发生日和锁定汇率统计，报销打款、成员返还与投资交易不重复计入消费。</p>
      <form action={action} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><input type="hidden" name="tab" value="overview"/>
        <label className="text-sm">开始日期<input className={input} type="date" name="start" defaultValue={filters.start || report.start}/></label>
        <label className="text-sm">结束日期<input className={input} type="date" name="end" defaultValue={filters.end || report.end}/></label>
        {[["account", "支付账户", [["bank", "共同银行"], ["brokerage", "共同券商"]]], ["currency", "原币币种", ["USD", "CNY", "HKD"].map(c => [c, c])], ["category", "用途分类", categories.map(c => [c.name, c.name])], ["project", "具体事项", projects.map(p => [p.name, p.name])], ["payment", "支付方式", [["joint", "共同账户支付"], ["member", "成员代付"]]]].map(([name, label, options]) => <label key={String(name)} className="text-sm">{String(label)}<select className={input} name={String(name)} defaultValue={String(filters[name as keyof LedgerFilters] ?? "")}><option value="">全部</option>{(options as string[][]).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>)}
        <div className="flex items-end gap-3"><button className="rounded-xl bg-[#1f5243] px-4 py-2.5 text-sm font-bold text-white">应用筛选</button><Link href={action} className="text-sm underline">重置</Link></div>
      </form>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">{[["消费发生额（未扣退款）", report.grossMinor], ["当期退款额", report.refundMinor], ["当期净消费", report.netMinor]].map(([label, amount]) => <div key={String(label)} className="rounded-xl bg-[#f3f5ef] p-4"><p className="text-xs text-gray-600">{label}</p><p className="mt-2 text-lg font-bold">{amount === null ? "待核对 / 待完善汇率" : money(amount as number, currency)}</p></div>)}</div>
      {report.issues.map(issue => <p className="mt-3 text-sm text-amber-800" key={issue}>{issue}</p>)}
    </section>
    <section className="rounded-2xl border bg-white p-5"><h2 className="font-bold">消费趋势 · {currency}</h2><p className="mt-1 text-xs text-gray-500">{report.start || "暂无日期"} — {report.end || "暂无日期"} · {report.monthly ? "按自然月汇总" : "按日汇总"} · 缺失日期补零，退款后的净消费可为负</p>{!report.records.length || report.issues.length ? <p className="py-10 text-center text-sm text-gray-500">{report.issues.length ? "消费折算待核对，原币记录仍可追溯。" : "暂无消费记录。"}</p> : <div className="mt-4 h-72"><ResponsiveContainer><LineChart data={report.trend.map(point => ({ date: point.date, account: point.accountMinor / 100, member: point.memberMinor / 100, net: point.netMinor / 100 }))}><XAxis dataKey="date" tick={{ fontSize: 10 }}/><YAxis tick={{ fontSize: 10 }}/><Tooltip formatter={(value: number) => money(Math.round(value * 100), currency)}/><Legend/><ReferenceLine y={0} stroke="#b2bcb3"/><Line type="linear" name="共同账户消费" dataKey="account" stroke="#768958" dot={false}/><Line type="linear" name="成员代付" dataKey="member" stroke="#b79b61" dot={false}/><Line type="linear" name="净消费" dataKey="net" stroke="#1f5243" strokeWidth={3} dot={false}/></LineChart></ResponsiveContainer></div>}</section>
    <section className="rounded-2xl border bg-white p-5"><h2 className="mb-3 font-bold">消费发生额（未扣退款）· {currency}</h2><SpendingSankey graph={report.consumption} currency={currency} select={select}/></section>
    <section className="rounded-2xl border bg-white p-5"><h2 className="mb-3 font-bold">退款流向 · {currency}</h2><SpendingSankey graph={report.refunds} currency={currency} refund select={select}/><p className="mt-3 text-xs text-gray-500">按退款自身发生日取数，可包含以前月份的原消费；以正值解释退款去向，不抵消主图面积。</p></section>
    {selected && <section ref={detailsRef} tabIndex={-1} aria-live="polite" aria-label="流量原始记录" className="rounded-2xl border border-[#1f5243]/30 bg-white p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="font-bold">{selected.title}</h3><p className="mt-1 text-xs text-gray-500">{records.length} 笔记录 · 按历史锁定汇率折算 · 每页 50 笔</p></div><button onClick={() => setSelected(null)} className="rounded-lg border px-3 py-2 text-sm">关闭明细</button></div><div className="mt-3 divide-y">{records.slice(page * 50, (page + 1) * 50).map(record => <div key={record.id} className="space-y-1 py-3 text-sm"><Link className="font-medium underline" href={`${action}?tab=ledger&entry=${record.id}`}>{record.date} · {record.title}</Link><p className="text-xs text-gray-500">{money(record.originalMinor, record.currency)} · 折算 {record.amountMinor === null ? "待完善汇率" : money(record.amountMinor, currency)} · {record.category} · {record.project}</p>{record.originalId && <Link className="text-xs underline" href={`${action}?tab=ledger&entry=${record.originalId}`}>查看原消费</Link>}</div>)}</div>{records.length > 50 && <div className="mt-3 flex justify-between text-sm"><button disabled={page === 0} onClick={() => setPage(p => p - 1)}>上一页</button><span>{page + 1} / {Math.ceil(records.length / 50)}</span><button disabled={(page + 1) * 50 >= records.length} onClick={() => setPage(p => p + 1)}>下一页</button></div>}</section>}
    <details className="rounded-2xl border bg-white p-4 text-sm"><summary className="cursor-pointer">所选范围原始消费与退款（{report.records.length} 笔）</summary><button className="mt-3 underline" onClick={() => { setPage(0); setSelected({ ids: report.records.map(r => r.id), title: "全部消费与退款" }); }}>展开可追溯明细</button></details>
  </div>;
}
