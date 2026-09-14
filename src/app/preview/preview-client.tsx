"use client";

import { useState } from "react";
import { Dashboard, InvestmentList, NewRecordButton, RecordModal } from "@/app/app/app-client";

type Row = Record<string, unknown>;
const money = (minor: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
const memberName = (members: Row[], id: unknown) => {
  const member = members.find((item) => item.user_id === id);
  const profile = member && (Array.isArray(member.profiles) ? member.profiles[0] : member.profiles);
  return profile && typeof profile === "object" ? String((profile as Row).display_name) : null;
};

function Approvals({ proposals, userId, notify, members }: { proposals: Row[]; userId: string; notify: () => void; members: Row[] }) {
  return <div className="space-y-3">{proposals.map((proposal) => { const payload = proposal.payload as Row; const mine = proposal.submitter_id === userId; const payer = memberName(members, payload.payerMemberId); return <article key={String(proposal.id)} className="rounded-2xl border bg-white p-5"><div className="flex justify-between gap-3"><div><b>{String(payload.title)}</b><p className="mt-1 text-xs text-gray-500">{String(payload.type)} · {money(Number(payload.amountMinor), String(payload.currency))}</p>{payer && <p className="mt-1 text-xs text-gray-500">实际付款人：{payer}</p>}</div><span className="rounded-full bg-amber-100 px-2 py-1 text-xs">{String(proposal.status)}</span></div><div className="mt-4">{mine ? <span className="text-xs text-gray-500">你不能审批自己提交的记录。</span> : <><button onClick={notify} className="mr-2 rounded-lg border px-3 py-2 text-sm">驳回</button><button onClick={notify} className="rounded-lg bg-[#1f5243] px-3 py-2 text-sm text-white">批准</button></>}</div></article>; })}</div>;
}

function Ledger({ entries }: { entries: Row[] }) {
  return <div className="overflow-hidden rounded-2xl border bg-white">{entries.map((entry) => <div key={String(entry.id)} className="flex justify-between gap-3 border-b p-4"><div><b>{String(entry.title)}</b><p className="mt-1 text-xs text-gray-500">{String(entry.occurred_at)} · {String(entry.entry_type)} · {String(entry.category || "")}</p></div><b>{money(Number(entry.amount_minor), String(entry.currency))}</b></div>)}</div>;
}

export default function PreviewClient({ entries, proposals, investments, valuations, members }: { entries: Row[]; proposals: Row[]; investments: Row[]; valuations: Row[]; members: Row[] }) {
  const [tab, setTab] = useState("总览");
  const [message, setMessage] = useState("");
  const [recordOpen, setRecordOpen] = useState(false);
  const [investmentActionId, setInvestmentActionId] = useState<string | null>(null);
  const notify = () => setMessage("本地只读预览不会写入数据。");
  return <main className="min-h-screen bg-[#f3f2ed] p-4 text-[#1d3029] md:p-7"><div className="mx-auto max-w-7xl rounded-3xl border bg-[#fbfaf6]"><div className="rounded-t-3xl bg-[#d8eadc] px-5 py-3 text-sm font-medium">本地只读预览 · 合成数据 · 不连接 Supabase</div><header className="flex flex-wrap justify-between gap-3 border-b p-5"><div><p className="text-xs tracking-widest text-[#587064]">开发预览 · 管理员</p><h1 className="text-2xl font-bold">共筑生活账本</h1><p className="mt-1 text-xs text-gray-500">2/2 位成员 · {proposals.length} 笔待审批</p></div><div className="flex items-center gap-2"><NewRecordButton open={() => setRecordOpen(true)}/><span className="rounded-full border border-[#1f5243]/20 bg-white px-3 py-1 text-xs text-[#1f5243]">v1.1 · P1 审批基础</span></div></header><nav className="flex gap-1 overflow-auto border-b p-2">{["总览", "审批中心", "流水", "投资"].map((item) => <button key={item} onClick={() => setTab(item)} className={`rounded-xl px-4 py-2 text-sm font-bold ${tab === item ? "bg-[#1f5243] text-white" : ""}`}>{item}{item === "审批中心" ? ` (${proposals.length})` : ""}</button>)}</nav><section className="p-5 md:p-7">{tab === "总览" && <Dashboard currency="USD" entries={entries}/>} {tab === "审批中心" && <Approvals proposals={proposals} userId="00000000-0000-4000-8000-000000000001" notify={notify} members={members}/>} {tab === "流水" && <Ledger entries={entries}/>} {tab === "投资" && <InvestmentList investments={investments} valuations={valuations} entries={entries} currency="USD" openCreate={notify} openAction={setInvestmentActionId}/>}</section></div>{recordOpen && <RecordModal close={() => setRecordOpen(false)} household={{ id: "00000000-0000-4000-8000-000000000010", name: "共筑生活账本", reportingCurrency: "USD" }} investments={investments} members={members} userId="00000000-0000-4000-8000-000000000001" refresh={() => undefined} setMessage={setMessage} readOnly/>}{investmentActionId && <RecordModal close={() => setInvestmentActionId(null)} household={{ id: "00000000-0000-4000-8000-000000000010", name: "共筑生活账本", reportingCurrency: "USD" }} investments={investments} members={members} userId="00000000-0000-4000-8000-000000000001" refresh={() => undefined} setMessage={setMessage} readOnly mode="investment" initialInvestmentId={investmentActionId}/>} {message && <button onClick={() => setMessage("")} className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-xl bg-[#193d32] px-5 py-3 text-sm text-white">{message}</button>}</main>;
}
