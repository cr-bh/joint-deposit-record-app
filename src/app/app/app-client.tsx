"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Copy, LogOut, Plus, RefreshCcw, UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { calculateInvestmentPosition, latestValuation, valuePosition, type InvestmentPosition } from "@/lib/domain/investment-calculations";

import { ledgerEventFromRow } from "@/lib/domain/ledger-adapter";
import { summarizeLedger, recordCurrency } from "@/lib/domain/ledger-summary";
import { parseFixedDecimal } from "@/lib/domain/fixed-decimal";

type Row = Record<string, unknown>;
type Currency = "USD" | "CNY" | "HKD";
export type LedgerSummary = ReturnType<typeof summarizeLedger>;
export type InvestmentSnapshot =
  | { position: InvestmentPosition; valuation: ReturnType<typeof valuePosition>; latestValueDate?: string; error?: never }
  | { error: string; position?: never; valuation?: never; latestValueDate?: never };
type Props = { household: { id: string; name: string; reportingCurrency: string; ledgerVersion?: number }; userId: string; role: string; entries: Row[]; proposals: Row[]; investments: Row[]; valuations: Row[]; members: Row[]; ledgerSummary?: LedgerSummary; postedEntryCount?: number; investmentSnapshots?: Record<string, InvestmentSnapshot> };
const categories = ["日常生活", "餐饮", "居住", "家居", "交通", "旅行", "医疗健康", "礼物", "订阅服务", "宠物", "教育", "其他"];
const money = (minor: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
function memberDisplayName(member: Row) {
  const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
  const displayName = profile && typeof profile === "object" ? (profile as Row).display_name : undefined;
  return typeof displayName === "string" && displayName.trim() ? displayName : `成员 ${String(member.user_id).slice(0, 8)}`;
}
function memberName(members: Row[], memberId: unknown) {
  if (typeof memberId !== "string") return null;
  const member = members.find((item) => item.user_id === memberId);
  return member ? memberDisplayName(member) : `成员 ${memberId.slice(0, 8)}`;
}
export function PayerSelect({ members, userId, value, disabled, onChange }: { members: Row[]; userId: string; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  return <label className="block text-sm"><span className="mb-1 block text-gray-600">实际付款人</span><select disabled={disabled} required value={value} onChange={(event) => onChange(event.target.value)}>{members.map((member) => <option key={String(member.user_id)} value={String(member.user_id)}>{memberDisplayName(member)}{member.user_id === userId ? "（我）" : ""}</option>)}</select></label>;
}
export function NewRecordButton({ open }: { open: () => void }) {
  return <button onClick={open} className="rounded-xl bg-[#1f5243] px-4 py-2 text-sm font-bold text-white"><Plus size={16} className="inline"/> 新建账本记录</button>;
}

export default function AppClient({ household, userId, role, entries, proposals, investments, valuations, members, ledgerSummary, postedEntryCount, investmentSnapshots }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState("总览"); const [recordOpen, setRecordOpen] = useState(false); const [investmentOpen, setInvestmentOpen] = useState(false); const [inviteOpen, setInviteOpen] = useState(false); const [message, setMessage] = useState("");
  const posted = entries.filter((entry) => entry.status === "posted");
  const pending = proposals.filter((proposal) => ["pending_approval", "overdue_pending"].includes(String(proposal.status)));
  useEffect(() => {
    const channel = createClient().channel(`household:${household.id}`).on("postgres_changes", { event: "*", schema: "public", table: "proposals", filter: `household_id=eq.${household.id}` }, () => router.refresh()).on("postgres_changes", { event: "*", schema: "public", table: "ledger_entries", filter: `household_id=eq.${household.id}` }, () => router.refresh()).on("postgres_changes", { event: "*", schema: "public", table: "investments", filter: `household_id=eq.${household.id}` }, () => router.refresh()).on("postgres_changes", { event: "*", schema: "public", table: "investment_valuations", filter: `household_id=eq.${household.id}` }, () => router.refresh()).subscribe();
    return () => { createClient().removeChannel(channel); };
  }, [household.id, router]);
  async function decide(id: string, approve: boolean) { const response = await fetch(`/api/proposals/${id}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve }) }); const body = await response.json(); if (!response.ok) return setMessage(body.error || "操作失败"); router.refresh(); }
  async function logout() { await createClient().auth.signOut(); router.push("/login"); }
  const totalPostedEntries = postedEntryCount ?? posted.length;
  return <main className="min-h-screen bg-[#f3f2ed] p-4 text-[#1d3029] md:p-7"><div className="mx-auto max-w-7xl rounded-3xl border bg-[#fbfaf6]"><header className="flex flex-wrap justify-between gap-3 border-b p-5"><div><p className="text-xs tracking-widest text-[#587064]">在线共同账本 · {role === "owner" ? "管理员" : "成员"}</p><h1 className="text-2xl font-bold">{household.name}</h1><p className="mt-1 text-xs text-gray-500">{members.length}/2 位成员 · {pending.length} 笔待审批{household.ledgerVersion == null ? "" : ` · 账本版本 ${household.ledgerVersion}`}</p></div><div className="flex flex-wrap gap-2"><NewRecordButton open={() => setRecordOpen(true)}/>{role === "owner" && <button onClick={() => setInviteOpen(true)} className="rounded-xl border px-3 py-2 text-sm font-bold"><UserPlus size={16} className="mr-1 inline"/>邀请伴侣</button>}<button onClick={() => router.refresh()} className="rounded-xl border p-2" aria-label="刷新"><RefreshCcw size={17}/></button><button onClick={logout} className="rounded-xl border p-2" aria-label="退出"><LogOut size={17}/></button></div></header><nav className="flex gap-1 overflow-auto border-b p-2">{["总览", "审批中心", "流水", "投资"].map((item) => <button key={item} onClick={() => setTab(item)} className={`rounded-xl px-4 py-2 text-sm font-bold ${tab === item ? "bg-[#1f5243] text-white" : ""}`}>{item}{item === "审批中心" && pending.length > 0 ? ` (${pending.length})` : ""}</button>)}</nav><section className="p-5 md:p-7">{tab === "总览" && <Dashboard currency={household.reportingCurrency} entries={posted} summary={ledgerSummary} postedEntryCount={totalPostedEntries}/>} {tab === "审批中心" && <Approvals proposals={proposals} userId={userId} decide={decide} currency={household.reportingCurrency} members={members}/>} {tab === "流水" && <Ledger entries={posted} currency={household.reportingCurrency} members={members} totalEntries={totalPostedEntries}/>} {tab === "投资" && <InvestmentList investments={investments} valuations={valuations} entries={posted} currency={household.reportingCurrency} openCreate={() => setInvestmentOpen(true)} snapshots={investmentSnapshots}/>}</section></div>{recordOpen && <RecordModal close={() => setRecordOpen(false)} household={household} investments={investments} members={members} userId={userId} refresh={() => router.refresh()} setMessage={setMessage}/>} {investmentOpen && <InvestmentCreate close={() => setInvestmentOpen(false)} household={household} refresh={() => router.refresh()} setMessage={setMessage}/>} {inviteOpen && <InviteModal close={() => setInviteOpen(false)} householdId={household.id} setMessage={setMessage}/>} {message && <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-[#193d32] px-5 py-3 text-sm text-white">{message}</div>}</main>;
}
export function Dashboard({ currency, entries, summary: providedSummary, postedEntryCount }: { currency: string; entries: Row[]; summary?: LedgerSummary; postedEntryCount?: number }) {
  const summary = useMemo(() => {
    if (providedSummary) return { value: providedSummary, error: null };
    try { return { value: summarizeLedger(entries.map(ledgerEventFromRow), currency as Currency), error: null }; }
    catch { return { value: null, error: "流水数据无法核算，请核对记录后重试。" }; }
  }, [entries, currency, providedSummary]);
  if (!summary.value) return <Empty text={summary.error!}/>;
  const { cash, cashByCurrency, trend } = summary.value;
  const missingTrend = trend.some((point) => point.amountMinor === null);
  return <div className="space-y-6"><div className="grid gap-4 md:grid-cols-3"><Card label="共同现金" value={cash.amountMinor === null ? "待完善汇率" : money(cash.amountMinor, currency)}/><Card label="已入账记录" value={`${postedEntryCount ?? entries.length} 笔`}/><Card label="报告币种" value={currency}/></div><div className="rounded-2xl border bg-white p-4 text-sm"><b>原币现金</b><div className="mt-2 flex flex-wrap gap-4">{Object.entries(cashByCurrency).map(([code, amount]) => <span key={code}>{code} {money(amount, code)}</span>)}</div>{cash.missingCurrencies.length > 0 && <p className="mt-2 text-amber-800">缺少 {cash.missingCurrencies.join(" / ")} 已确认汇率，暂不显示折算合计。</p>}</div><section className="rounded-2xl border bg-white p-5"><b>消费趋势</b>{missingTrend ? <Empty text="消费包含未配置汇率的币种，折算趋势待完善。原币金额可在流水查看。"/> : trend.length === 0 ? <Empty text="暂无消费记录。"/> : <div className="mt-4 h-72"><ResponsiveContainer><LineChart data={trend.map((point) => ({ date: point.date, total: point.amountMinor! / 100 }))}><XAxis dataKey="date" tick={{ fontSize: 10 }}/><YAxis tick={{ fontSize: 10 }}/><Tooltip formatter={(value: number) => money(Math.round(value * 100), currency)}/><Line type="monotone" dataKey="total" stroke="#1f5243" strokeWidth={3}/></LineChart></ResponsiveContainer></div>}</section></div>;
}
function Approvals({ proposals, userId, decide, currency, members }: { proposals: Row[]; userId: string; decide: (id: string, approve: boolean) => void; currency: string; members: Row[] }) {
  return <div className="space-y-3">{proposals.length ? proposals.map((proposal) => {
    const payload = proposal.payload as Row;
    const mine = proposal.submitter_id === userId;
    const payer = memberName(members, payload.payerMemberId);
    return <article key={String(proposal.id)} className="rounded-2xl border bg-white p-5"><div className="flex justify-between gap-3"><div><b>{String(payload.title)}</b><p className="mt-1 text-xs text-gray-500">{String(payload.type)} · {Number(payload.amountMinor) ? money(Number(payload.amountMinor), String(payload.currency || currency)) : "非现金操作"}</p>{payer && <p className="mt-1 text-xs text-gray-500">实际付款人：{payer}</p>}</div><span className="rounded-full bg-amber-100 px-2 py-1 text-xs">{String(proposal.status)}</span></div>{["pending_approval", "overdue_pending"].includes(String(proposal.status)) && <div className="mt-4">{mine ? <span className="text-xs text-gray-500">你不能审批自己提交的记录。</span> : <><button onClick={() => decide(String(proposal.id), false)} className="mr-2 rounded-lg border px-3 py-2 text-sm">驳回</button><button onClick={() => decide(String(proposal.id), true)} className="rounded-lg bg-[#1f5243] px-3 py-2 text-sm text-white">批准</button></>}</div>}</article>;
  }) : <Empty text="暂无审批记录。"/>}</div>;
}
function Ledger({ entries, currency, members, totalEntries }: { entries: Row[]; currency: string; members: Row[]; totalEntries: number }) {
  return <div className="overflow-hidden rounded-2xl border bg-white">{totalEntries > entries.length && <p className="border-b bg-[#f7f6f1] px-4 py-3 text-xs text-gray-600">当前显示最近 {entries.length} 笔；总览与投资持仓按全部 {totalEntries} 笔已入账记录计算。</p>}{entries.length ? entries.map((entry) => {
    const payer = memberName(members, entry.payer_member_id);
    return <div key={String(entry.id)} className="flex justify-between gap-3 border-b p-4"><div><b>{String(entry.title)}</b><p className="mt-1 text-xs text-gray-500">{String(entry.occurred_at)} · {String(entry.entry_type)} · {String(entry.category || "")}</p>{payer && <p className="mt-1 text-xs text-gray-500">实际付款人：{payer}</p>}</div><b>{money(Number(entry.amount_minor), String(entry.currency || currency))}</b></div>;
  }) : <Empty text="暂无已入账流水。"/>}</div>;
}
export function InvestmentList({ investments, valuations, entries, currency, openCreate, snapshots }: { investments: Row[]; valuations: Row[]; entries: Row[]; currency: string; openCreate: () => void; snapshots?: Record<string, InvestmentSnapshot> }) {
  return <div className="space-y-4"><div className="flex justify-between rounded-2xl bg-[#edf7ed] p-5"><div><b>投资台账</b><p className="mt-1 text-sm text-gray-500">这里仅展示标的与持仓。交易、分红和估值请从页面顶部“新建账本记录”统一提交审批。</p></div><button onClick={openCreate} className="rounded-xl bg-[#1f5243] px-4 py-2 text-sm font-bold text-white">新增投资标的</button></div>{investments.length ? investments.map((investment) => {
    const id = String(investment.id);
    const records = entries.filter((entry) => entry.investment_id === id);
    const serverSnapshot = snapshots?.[id];
    if (serverSnapshot?.error) return <article key={id} className="rounded-2xl border bg-white p-5"><b>{String(investment.name)}</b><p className="mt-2 text-sm text-red-700">{serverSnapshot.error}</p></article>;
    let position = serverSnapshot?.position;
    let valuation = serverSnapshot?.valuation;
    let latestValueDate = serverSnapshot?.latestValueDate;
    if (!position || !valuation) {
      try {
        position = calculateInvestmentPosition(records.map(ledgerEventFromRow), id, Number(investment.opening_quantity_milli), Number(investment.opening_cost_minor));
        const latest = latestValuation(valuations.filter((value) => value.investment_id === id).map((value) => ({ id: String(value.id), valueDate: String(value.value_date), createdAt: String(value.created_at), unitValueTenThousandths: Number(value.unit_value_1e4 ?? Number(value.unit_value_minor) * 100) })));
        latestValueDate = latest?.valueDate;
        valuation = valuePosition(position, latest);
      } catch (error) {
        return <article key={id} className="rounded-2xl border bg-white p-5"><b>{String(investment.name)}</b><p className="mt-2 text-sm text-red-700">{error instanceof Error ? error.message : "投资流水需核对"}</p></article>;
      }
    }
    const market = valuation.marketMinor;
    return <article key={id} className="rounded-2xl border bg-white p-5"><div><h2 className="font-bold">{String(investment.name)}</h2><p className="mt-1 text-xs text-gray-500">{String(investment.currency)} · 可卖 {position.quantityMilli / 1000} 份</p></div><div className="mt-5 grid gap-3 md:grid-cols-5"><Card label={valuation.source === "cost_estimate" ? "当前市值（成本暂估）" : "当前市值"} value={money(market, String(investment.currency))}/><Card label="剩余成本" value={money(position.remainingCostMinor, String(investment.currency))}/><Card label="未实现收益" value={valuation.unrealizedGainMinor === null ? "待估值" : money(valuation.unrealizedGainMinor, String(investment.currency))}/><Card label="已实现收益" value={money(position.realizedGainMinor, String(investment.currency))}/><Card label="累计分红" value={money(position.dividendMinor, String(investment.currency))}/></div><div className="mt-5 border-t pt-3 text-sm"><p className="mb-3 text-xs text-gray-500">{latestValueDate ? `人工估值日期：${latestValueDate}` : "尚无人工估值；暂按剩余成本展示。"}</p><b>最近交易</b>{records.length ? records.map((entry) => <p key={String(entry.id)} className="mt-2">{String(entry.occurred_at)} · {String(entry.entry_type)} · {money(Number(entry.amount_minor), String(entry.currency || currency))}</p>) : <p className="mt-2 text-gray-500">当前列表页没有该标的交易；持仓仍按完整账本计算。</p>}</div></article>;
  }) : <Empty text="尚未有投资标的。请先创建零持仓标的，再从页面顶部提交交易审批。"/>}</div>;
}
export function RecordModal({ close, household, investments, members, userId, refresh, setMessage, readOnly = false }: { close: () => void; household: Props["household"]; investments: Row[]; members: Row[]; userId: string; refresh: () => void; setMessage: (value: string) => void; readOnly?: boolean }) {
  const [type, setType] = useState("expense");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(categories[0]);
  const [investmentId, setInvestmentId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [payerMemberId, setPayerMemberId] = useState(userId);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const payload = {
        householdId: household.id,
        type,
        amountMinor: type === "investment_valuation" ? 0 : parseFixedDecimal(amount, 2, { allowZero: type === "investment_sell", label: type === "investment_buy" ? "实际总扣款" : type === "investment_sell" ? "实际净到账" : "金额" }),
        currency: recordCurrency(type, household.reportingCurrency as Currency, investmentId ? { currency: investments.find((item) => item.id === investmentId)?.currency as Currency } : undefined),
        occurredAt: new Date().toISOString().slice(0, 10),
        title,
        category: ["expense", "reimbursement"].includes(type) ? category : undefined,
        payerMemberId: ["deposit", "reimbursement"].includes(type) ? payerMemberId : undefined,
        investmentId: investmentId || undefined,
        quantityMilli: quantity ? parseFixedDecimal(quantity, 3, { label: "份额" }) : undefined,
        unitPriceTenThousandths: price && ["investment_buy", "investment_sell"].includes(type) ? parseFixedDecimal(price, 4, { label: "参考成交单价" }) : undefined,
        unitValueTenThousandths: type === "investment_valuation" ? parseFixedDecimal(price, 4, { label: "单位估值" }) : undefined,
        idempotencyKey,
      };
      if (readOnly) {
        setMessage("本地只读预览不会提交数据；正式环境会复用当前草稿的幂等键。");
        return;
      }
      const response = await fetch("/api/proposals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return setMessage(body.error || "提交失败，请重试");
      close();
      setMessage("已提交给对方审批。");
      refresh();
    } catch (error) {
      setMessage(error instanceof Error ? `${error.message} 草稿已保留。` : "网络连接失败，草稿已保留，请重试。");
    } finally {
      setSubmitting(false);
    }
  }

  const trade = ["investment_buy", "investment_sell"].includes(type);
  const investmentAction = trade || ["dividend", "investment_valuation"].includes(type);
  return <Modal close={close} title="提交记录"><form onSubmit={submit} className="space-y-3"><select disabled={submitting} value={type} onChange={(event) => setType(event.target.value)}><option value="deposit">共同存入</option><option value="expense">共同账户消费</option><option value="reimbursement">成员代付共同消费</option><option value="settlement">报销付款</option><option value="investment_buy">投资买入</option><option value="investment_sell">投资卖出</option><option value="dividend">投资分红</option><option value="investment_valuation">新增投资估值</option></select>{investmentAction && <select disabled={submitting} required value={investmentId} onChange={(event) => setInvestmentId(event.target.value)}><option value="">选择投资标的</option>{investments.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.name)}</option>)}</select>}<input disabled={submitting} required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="说明"/>{["deposit", "reimbursement"].includes(type) && <PayerSelect members={members} userId={userId} value={payerMemberId} disabled={submitting} onChange={setPayerMemberId}/>} {trade && <><input disabled={submitting} required value={quantity} onChange={(event) => setQuantity(event.target.value)} type="number" min=".001" step=".001" placeholder="份额"/><input disabled={submitting} required value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min={type === "investment_sell" ? "0" : ".01"} step=".01" placeholder={type === "investment_buy" ? "实际总扣款（含费用）" : "实际净到账（含费用影响）"}/><input disabled={submitting} value={price} onChange={(event) => setPrice(event.target.value)} type="number" min=".0001" step=".0001" placeholder="参考成交单价（可选）"/><p className="text-xs text-gray-500">实际金额是入账依据；参考单价只作备注，不会重新计算扣款或到账。</p></>}{type === "investment_valuation" ? <input disabled={submitting} required value={price} onChange={(event) => setPrice(event.target.value)} type="number" min=".0001" step=".0001" placeholder="单位估值"/> : !trade && <input disabled={submitting} required value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min=".01" step=".01" placeholder="金额"/>}{["expense", "reimbursement"].includes(type) && <select disabled={submitting} value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select>}<button disabled={submitting} className="w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-60">{submitting ? "正在提交…" : "提交给对方审批"}</button></form></Modal>;
}
function InvestmentCreate({ close, household, refresh, setMessage }: { close: () => void; household: Props["household"]; refresh: () => void; setMessage: (value: string) => void }) { const [name, setName] = useState(""); const [ticker, setTicker] = useState(""); const [currency, setCurrency] = useState<Currency>("USD"); const [assetType, setAssetType] = useState("基金 / ETF"); async function submit(event: React.FormEvent) { event.preventDefault(); const response = await fetch("/api/investments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ householdId: household.id, name, ticker: ticker || undefined, assetType, currency }) }); const body = await response.json(); if (!response.ok) return setMessage(body.error || "创建失败"); close(); setMessage("投资标的已创建，初始持仓为 0；后续买入、卖出和分红请通过交易记录提交审批。"); refresh(); } return <Modal close={close} title="新增投资标的"><form onSubmit={submit} className="space-y-3"><p className="text-sm text-gray-500">新标的初始持仓固定为 0，不影响共同现金；所有持仓只从已批准交易流水计算。</p><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="标的名称"/><input value={ticker} onChange={(event) => setTicker(event.target.value)} placeholder="代码（可选）"/><input value={assetType} onChange={(event) => setAssetType(event.target.value)} placeholder="类型，例如 ETF、基金、股票"/><select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}><option>USD</option><option>CNY</option><option>HKD</option></select><button className="w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white">直接创建标的</button></form></Modal>; }
function InviteModal({ close, householdId, setMessage }: { close: () => void; householdId: string; setMessage: (value: string) => void }) { const [email, setEmail] = useState(""); const [link, setLink] = useState(""); async function create(event: React.FormEvent) { event.preventDefault(); const response = await fetch(`/api/households/${householdId}/invitations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }); const body = await response.json(); if (!response.ok) return setMessage(body.error || "创建邀请失败"); setLink(`${window.location.origin}/invite/${body.token}`); } return <Modal close={close} title="邀请伴侣"><form onSubmit={create} className="space-y-3"><p className="text-sm text-gray-500">请输入伴侣将用来注册/登录的邮箱。链接仅可被该邮箱账号接受。</p><input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="伴侣邮箱"/><button className="w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white">生成邀请链接</button></form>{link && <div className="mt-4 rounded-xl bg-[#f3f5ef] p-3"><p className="break-all text-xs">{link}</p><button onClick={() => navigator.clipboard.writeText(link)} className="mt-3 rounded-lg border px-3 py-2 text-sm"><Copy size={15} className="mr-1 inline"/>复制链接</button></div>}</Modal>; }
function Card({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl border bg-white p-4"><p className="text-sm text-gray-500">{label}</p><b className="mt-3 block text-xl">{value}</b></div>; }
function Empty({ text }: { text: string }) { return <p className="rounded-2xl border bg-white p-8 text-center text-sm text-gray-500">{text}</p>; }
function Modal({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) { return <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"><div className="w-full max-w-md rounded-2xl bg-white p-6"><div className="mb-4 flex justify-between"><b>{title}</b><button onClick={close}>×</button></div><div className="[&_input]:w-full [&_input]:rounded-xl [&_input]:border [&_input]:p-3 [&_select]:w-full [&_select]:rounded-xl [&_select]:border [&_select]:p-3">{children}</div></div></div>; }
