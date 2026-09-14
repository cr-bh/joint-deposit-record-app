"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Copy, LogOut, Plus, RefreshCcw, Settings, UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { calculateInvestmentPosition, latestValuation, valuePosition, type InvestmentPosition } from "@/lib/domain/investment-calculations";

import { ledgerEventFromRow } from "@/lib/domain/ledger-adapter";
import { summarizeLedger, recordCurrency, reportBalances } from "@/lib/domain/ledger-summary";
import { parseFixedDecimal } from "@/lib/domain/fixed-decimal";
import type { AccountBalances, CashTransfer } from "@/lib/domain/account-balances";
import type { CashAccountKind } from "@/lib/domain/balance-calculations";
import { ratesFromSnapshot, type FxRateSnapshot } from "@/lib/domain/fx-rates";
import { activeSpendingDimensions, type SpendingDimension } from "@/lib/domain/spending-dimensions";
import { emptyLedgerFilters, type LedgerFilters } from "@/lib/domain/ledger-filters";

export { emptyLedgerFilters } from "@/lib/domain/ledger-filters";
export type { LedgerFilters } from "@/lib/domain/ledger-filters";

type Row = Record<string, unknown>;
type Currency = "USD" | "CNY" | "HKD";
export type LedgerSummary = ReturnType<typeof summarizeLedger>;
export type InvestmentSnapshot =
  | { position: InvestmentPosition; valuation: ReturnType<typeof valuePosition>; latestValueDate?: string; error?: never }
  | { error: string; position?: never; valuation?: never; latestValueDate?: never };
export type FxRateSnapshotView = FxRateSnapshot & { stale: boolean };
type Props = { household: { id: string; name: string; reportingCurrency: string; ledgerVersion?: number }; userId: string; role: string; entries: Row[]; recentEntries?: Row[]; proposals: Row[]; investments: Row[]; valuations: Row[]; members: Row[]; accounts?: Row[]; accountBalances?: AccountBalances; fxSnapshot?: FxRateSnapshotView; fxSnapshots?: FxRateSnapshot[]; spendingCategories?: SpendingDimension[]; spendingProjects?: SpendingDimension[]; ledgerSummary?: LedgerSummary; postedEntryCount?: number; ledgerTotalEntries?: number; initialTab?: string; ledgerPage?: number; ledgerPageCount?: number; ledgerFilters?: LedgerFilters; investmentSnapshots?: Record<string, InvestmentSnapshot> };
const accountDefaults: Record<CashAccountKind, string> = { bank: "共同银行", brokerage: "共同券商" };
const normalizedDimensionName = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
const accountName = (accounts: Row[], kind: CashAccountKind) => String(accounts.find((account) => account.kind === kind)?.name ?? accountDefaults[kind]);
const money = (minor: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
const timestamp = (value: string) => new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));
function exchangeDifference(row: Row, reporting: Currency, snapshot?: FxRateSnapshot) {
  if (!snapshot) return null;
  const sourceCurrency = String(row.currency) as Currency;
  const destinationCurrency = String(row.destinationCurrency ?? row.destination_currency) as Currency;
  const balances = { USD: 0, CNY: 0, HKD: 0 };
  balances[sourceCurrency] = -Number(row.amountMinor ?? row.amount_minor);
  balances[destinationCurrency] = Number(row.destinationAmountMinor ?? row.destination_amount_minor);
  return reportBalances(balances, reporting, ratesFromSnapshot(snapshot)).amountMinor;
}
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

export default function AppClient({ household, userId, role, entries, recentEntries = entries, proposals, investments, valuations, members, accounts = [], accountBalances, fxSnapshot, fxSnapshots = [], spendingCategories = [], spendingProjects = [], ledgerSummary, postedEntryCount, ledgerTotalEntries, initialTab = "总览", ledgerPage = 1, ledgerPageCount = 1, ledgerFilters = emptyLedgerFilters, investmentSnapshots }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState(initialTab); const [recordOpen, setRecordOpen] = useState(false); const [investmentOpen, setInvestmentOpen] = useState(false); const [investmentActionId, setInvestmentActionId] = useState<string | null>(null); const [inviteOpen, setInviteOpen] = useState(false); const [fxOpen, setFxOpen] = useState(false); const [settingsOpen, setSettingsOpen] = useState(false); const [message, setMessage] = useState("");
  const posted = entries.filter((entry) => entry.status === "posted");
  const recentPosted = recentEntries.filter((entry) => entry.status === "posted");
  const pending = proposals.filter((proposal) => ["pending_approval", "overdue_pending"].includes(String(proposal.status)));
  useEffect(() => {
    const channel = createClient().channel(`household:${household.id}`).on("postgres_changes", { event: "*", schema: "public", table: "proposals", filter: `household_id=eq.${household.id}` }, () => router.refresh()).on("postgres_changes", { event: "*", schema: "public", table: "ledger_entries", filter: `household_id=eq.${household.id}` }, () => router.refresh()).on("postgres_changes", { event: "*", schema: "public", table: "cash_transfers", filter: `household_id=eq.${household.id}` }, () => router.refresh()).on("postgres_changes", { event: "*", schema: "public", table: "cash_accounts", filter: `household_id=eq.${household.id}` }, () => router.refresh()).on("postgres_changes", { event: "*", schema: "public", table: "fx_rate_snapshots", filter: `household_id=eq.${household.id}` }, () => router.refresh()).on("postgres_changes", { event: "*", schema: "public", table: "spending_categories", filter: `household_id=eq.${household.id}` }, () => router.refresh()).on("postgres_changes", { event: "*", schema: "public", table: "spending_projects", filter: `household_id=eq.${household.id}` }, () => router.refresh()).on("postgres_changes", { event: "*", schema: "public", table: "investments", filter: `household_id=eq.${household.id}` }, () => router.refresh()).on("postgres_changes", { event: "*", schema: "public", table: "investment_valuations", filter: `household_id=eq.${household.id}` }, () => router.refresh()).subscribe();
    return () => { createClient().removeChannel(channel); };
  }, [household.id, router]);
  async function decide(id: string, approve: boolean) { const response = await fetch(`/api/proposals/${id}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve }) }); const body = await response.json(); if (!response.ok) return setMessage(body.error || "操作失败"); router.refresh(); }
  async function logout() { await createClient().auth.signOut(); router.push("/login"); }
  const totalPostedEntries = postedEntryCount ?? posted.length;
  return <main className="min-h-screen bg-[#f3f2ed] p-4 text-[#1d3029] md:p-7"><div className="mx-auto max-w-7xl rounded-3xl border bg-[#fbfaf6]"><header className="flex flex-wrap justify-between gap-3 border-b p-5"><div><p className="text-xs tracking-widest text-[#587064]">在线共同账本 · {role === "owner" ? "管理员" : "成员"}</p><h1 className="text-2xl font-bold">{household.name}</h1><p className="mt-1 text-xs text-gray-500">{members.length}/2 位成员 · {pending.length} 笔待审批{household.ledgerVersion == null ? "" : ` · 账本版本 ${household.ledgerVersion}`}</p></div><div className="flex flex-wrap gap-2"><NewRecordButton open={() => setRecordOpen(true)}/><button onClick={() => setSettingsOpen(true)} className="rounded-xl border px-3 py-2 text-sm font-bold"><Settings size={16} className="mr-1 inline"/>账本设置</button>{role === "owner" && <button onClick={() => setInviteOpen(true)} className="rounded-xl border px-3 py-2 text-sm font-bold"><UserPlus size={16} className="mr-1 inline"/>邀请伴侣</button>}<button onClick={() => router.refresh()} className="rounded-xl border p-2" aria-label="刷新"><RefreshCcw size={17}/></button><button onClick={logout} className="rounded-xl border p-2" aria-label="退出"><LogOut size={17}/></button></div></header><nav className="flex gap-1 overflow-auto border-b p-2">{["总览", "审批中心", "流水", "投资"].map((item) => <button key={item} onClick={() => { setTab(item); window.history.replaceState(null, "", item === "流水" ? `/app?tab=ledger&ledgerPage=${ledgerPage}` : "/app"); }} className={`rounded-xl px-4 py-2 text-sm font-bold ${tab === item ? "bg-[#1f5243] text-white" : ""}`}>{item}{item === "审批中心" && pending.length > 0 ? ` (${pending.length})` : ""}</button>)}</nav><section className="p-5 md:p-7">{tab === "总览" && <Dashboard currency={household.reportingCurrency} entries={recentPosted} summary={ledgerSummary} postedEntryCount={totalPostedEntries} accounts={accounts} accountBalances={accountBalances} fxSnapshot={fxSnapshot} openFx={() => setFxOpen(true)}/>} {tab === "审批中心" && <Approvals proposals={proposals} userId={userId} decide={decide} currency={household.reportingCurrency} members={members} fxSnapshots={fxSnapshots}/>} {tab === "流水" && <Ledger entries={posted} currency={household.reportingCurrency} members={members} accounts={accounts} fxSnapshots={fxSnapshots} totalEntries={ledgerTotalEntries ?? totalPostedEntries} page={ledgerPage} pageCount={ledgerPageCount} filters={ledgerFilters} categories={spendingCategories} projects={spendingProjects}/>} {tab === "投资" && <InvestmentList investments={investments} valuations={valuations} entries={recentPosted} currency={household.reportingCurrency} openCreate={() => setInvestmentOpen(true)} openAction={setInvestmentActionId} snapshots={investmentSnapshots}/>}</section></div>{recordOpen && <RecordModal close={() => setRecordOpen(false)} household={household} investments={investments} members={members} userId={userId} spendingCategories={spendingCategories} spendingProjects={spendingProjects} refresh={() => router.refresh()} setMessage={setMessage}/>} {investmentActionId && <RecordModal close={() => setInvestmentActionId(null)} household={household} investments={investments} members={members} userId={userId} spendingCategories={spendingCategories} spendingProjects={spendingProjects} refresh={() => router.refresh()} setMessage={setMessage} mode="investment" initialInvestmentId={investmentActionId}/>} {settingsOpen && <LedgerSettings close={() => setSettingsOpen(false)} household={household} categories={spendingCategories} projects={spendingProjects} refresh={() => router.refresh()} setMessage={setMessage}/>} {fxOpen && <FxRateModal close={() => setFxOpen(false)} household={household} current={fxSnapshot} refresh={() => router.refresh()} setMessage={setMessage}/>} {investmentOpen && <InvestmentCreate close={() => setInvestmentOpen(false)} household={household} refresh={() => router.refresh()} setMessage={setMessage}/>} {inviteOpen && <InviteModal close={() => setInviteOpen(false)} householdId={household.id} setMessage={setMessage}/>} {message && <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-[#193d32] px-5 py-3 text-sm text-white">{message}</div>}</main>;
}
export function Dashboard({ currency, entries, transfers = [], accounts = [], accountBalances, fxSnapshot, rates, openFx, summary: providedSummary, postedEntryCount }: { currency: string; entries: Row[]; transfers?: CashTransfer[]; accounts?: Row[]; accountBalances?: AccountBalances; fxSnapshot?: FxRateSnapshotView; rates?: Partial<Record<Currency, number>>; openFx?: () => void; summary?: LedgerSummary; postedEntryCount?: number }) {
  const summary = useMemo(() => {
    if (providedSummary) return { value: providedSummary, error: null };
    try { return { value: summarizeLedger(entries.map(ledgerEventFromRow), currency as Currency, rates, transfers), error: null }; }
    catch { return { value: null, error: "流水数据无法核算，请核对记录后重试。" }; }
  }, [entries, currency, rates, transfers, providedSummary]);
  if (!summary.value) return <Empty text={summary.error!}/>;
  const { cash, cashByCurrency, trend } = summary.value;
  const missingTrend = trend.some((point) => point.amountMinor === null);
  return <div className="space-y-6"><div className="grid gap-4 md:grid-cols-3"><Card label="共同现金" value={cash.amountMinor === null ? "待完善汇率" : money(cash.amountMinor, currency)}/><Card label="已入账记录" value={`${postedEntryCount ?? entries.length} 笔`}/><Card label="报告币种" value={currency}/></div><FxRatePanel snapshot={fxSnapshot} open={openFx}/>{accountBalances && <AccountCashCards accounts={accounts} balances={accountBalances}/>}<div className="rounded-2xl border bg-white p-4 text-sm"><b>原币现金合计</b><div className="mt-2 flex flex-wrap gap-4">{Object.entries(cashByCurrency).map(([code, amount]) => <span key={code}>{code} {money(amount, code)}</span>)}</div>{cash.missingCurrencies.length > 0 && <p className="mt-2 text-amber-800">缺少 {cash.missingCurrencies.join(" / ")} 已确认汇率，暂不显示折算合计。</p>}</div><section className="rounded-2xl border bg-white p-5"><b>消费趋势</b>{missingTrend ? <Empty text="消费包含未配置汇率的币种，折算趋势待完善。原币金额可在流水查看。"/> : trend.length === 0 ? <Empty text="暂无消费记录。"/> : <div className="mt-4 h-72"><ResponsiveContainer><LineChart data={trend.map((point) => ({ date: point.date, total: point.amountMinor! / 100 }))}><XAxis dataKey="date" tick={{ fontSize: 10 }}/><YAxis tick={{ fontSize: 10 }}/><Tooltip formatter={(value: number) => money(Math.round(value * 100), currency)}/><Line type="monotone" dataKey="total" stroke="#1f5243" strokeWidth={3}/></LineChart></ResponsiveContainer></div>}</section></div>;
}
export function FxRatePanel({ snapshot, open }: { snapshot?: FxRateSnapshotView; open?: () => void }) {
  return <section className="rounded-2xl border bg-white p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><b>手动汇率 / 最新已确认汇率</b>{snapshot ? <><p className="mt-3 text-sm">1 USD = <b>{snapshot.usdToCny}</b> CNY · 1 USD = <b>{snapshot.usdToHkd}</b> HKD</p><p className={`mt-2 text-xs ${snapshot.stale ? "text-amber-800" : "text-gray-500"}`}>汇率更新于 {timestamp(snapshot.approvedAt)}（UTC） · 来源：{snapshot.sourceNote}{snapshot.stale ? " · 已超过24小时，仅提示不禁用" : ""}</p></> : <p className="mt-2 text-sm text-amber-800">尚无已确认汇率；外币折算保持待完善。</p>}</div>{open && <button onClick={open} className="rounded-xl border border-[#1f5243] px-3 py-2 text-sm font-bold text-[#1f5243]">提交汇率更新</button>}</div></section>;
}
export function AccountCashCards({ accounts = [], balances }: { accounts?: Row[]; balances: AccountBalances }) {
  return <section><div className="mb-3"><b>账户现金</b><p className="mt-1 text-sm text-gray-500">内部划转只改变资金所在账户；任一账户都允许显示负余额。</p></div><div className="grid gap-4 md:grid-cols-2">{(["bank", "brokerage"] as CashAccountKind[]).map((kind) => <article key={kind} className="rounded-2xl border bg-white p-5"><p className="text-sm font-bold">{accountName(accounts, kind)}</p><div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">{(["USD", "CNY", "HKD"] as Currency[]).map((code) => <span key={code} className={balances[kind][code] < 0 ? "font-bold text-red-700" : ""}>{code} {money(balances[kind][code], code)}</span>)}</div></article>)}</div></section>;
}
function Approvals({ proposals, userId, decide, currency, members, fxSnapshots }: { proposals: Row[]; userId: string; decide: (id: string, approve: boolean) => void; currency: string; members: Row[]; fxSnapshots: FxRateSnapshot[] }) {
  return <div className="space-y-3">{proposals.length ? proposals.map((proposal) => {
    const payload = proposal.payload as Row;
    const mine = proposal.submitter_id === userId;
    const payer = memberName(members, payload.payerMemberId);
    const transfer = payload.type === "account_transfer";
    const exchange = payload.type === "currency_exchange";
    const rateUpdate = payload.type === "fx_rate_update";
    const account = payload.accountKind === "brokerage" ? "共同券商" : "共同银行";
    const source = payload.sourceAccountKind === "brokerage" ? "共同券商" : "共同银行";
    const destination = payload.destinationAccountKind === "bank" ? "共同银行" : "共同券商";
    const category = typeof payload.category === "string" ? payload.category : "";
    const project = typeof payload.project === "string" ? payload.project : "";
    const lockedFx = fxSnapshots.find((snapshot) => snapshot.id === proposal.fx_snapshot_id);
    const difference = exchange ? exchangeDifference(payload, currency as Currency, lockedFx) : null;
    return <article key={String(proposal.id)} className="rounded-2xl border bg-white p-5"><div className="flex justify-between gap-3"><div><b>{String(payload.title)}</b>{rateUpdate ? <><p className="mt-1 text-xs text-gray-500">手动汇率完整快照 · 生效时间 {timestamp(String(payload.effectiveAt))}（UTC）</p><p className="mt-1 text-xs text-gray-500">1 USD = {String(payload.usdToCny)} CNY · 1 USD = {String(payload.usdToHkd)} HKD</p><p className="mt-1 text-xs text-gray-500">来源：{String(payload.sourceNote)}</p></> : exchange ? <><p className="mt-1 text-xs text-gray-500">实际换汇 · 扣除 {money(Number(payload.amountMinor), String(payload.currency))} · 到账 {money(Number(payload.destinationAmountMinor), String(payload.destinationCurrency))}</p><p className="mt-1 text-xs text-gray-500">{source} → {destination}</p></> : <><p className="mt-1 text-xs text-gray-500">{transfer ? "账户内部划转" : String(payload.type)} · {Number(payload.amountMinor) ? money(Number(payload.amountMinor), String(payload.currency || currency)) : "非现金操作"}</p>{transfer ? <p className="mt-1 text-xs text-gray-500">{source} → {destination}</p> : ["deposit", "expense", "expense_refund", "settlement"].includes(String(payload.type)) && <p className="mt-1 text-xs text-gray-500">入账账户：{account}</p>}</>}{category && <p className="mt-1 text-xs text-gray-500">用途：{category}{project ? ` · 事项：${project}` : ""}</p>}{lockedFx && <p className="mt-1 text-xs text-gray-500">锁定汇率：1 USD = {lockedFx.usdToCny} CNY / {lockedFx.usdToHkd} HKD · {lockedFx.sourceNote}</p>}{difference !== null && <p className="mt-1 text-xs text-gray-500">换汇净额折算差额（可能包含价差及费用）：{money(difference, currency)}</p>}{payer && <p className="mt-1 text-xs text-gray-500">实际付款人：{payer}</p>}</div><span className="rounded-full bg-amber-100 px-2 py-1 text-xs">{String(proposal.status)}</span></div>{["pending_approval", "overdue_pending"].includes(String(proposal.status)) && <div className="mt-4">{mine ? <span className="text-xs text-gray-500">你不能审批自己提交的记录。</span> : <><button onClick={() => decide(String(proposal.id), false)} className="mr-2 rounded-lg border px-3 py-2 text-sm">驳回</button><button onClick={() => decide(String(proposal.id), true)} className="rounded-lg bg-[#1f5243] px-3 py-2 text-sm text-white">批准</button></>}</div>}</article>;
  }) : <Empty text="暂无审批记录。"/>}</div>;
}
export function Ledger({ entries, currency, members, accounts = [], fxSnapshots = [], totalEntries, page = 1, pageCount = 1, filters = emptyLedgerFilters, categories = [], projects = [], filterAction = "/app" }: { entries: Row[]; currency: string; members: Row[]; accounts?: Row[]; fxSnapshots?: FxRateSnapshot[]; totalEntries: number; page?: number; pageCount?: number; filters?: LedgerFilters; categories?: SpendingDimension[]; projects?: SpendingDimension[]; filterAction?: string }) {
  const filtering = Object.values(filters).some(Boolean);
  return <div className="space-y-4"><form action={filterAction} method="get" className="grid gap-3 rounded-2xl border bg-white p-4 md:grid-cols-6"><input type="hidden" name="tab" value="ledger"/><FilterSelect name="account" label="账户" value={filters.account} options={[["bank","共同银行"],["brokerage","共同券商"]]}/><FilterSelect name="currency" label="币种" value={filters.currency} options={[["USD","USD"],["CNY","CNY"],["HKD","HKD"]]}/><FilterSelect name="category" label="类别" value={filters.category} options={categories.map((item) => [item.name,`${item.name}${item.archivedAt ? "（已归档）" : ""}`])}/><FilterSelect name="project" label="事项" value={filters.project} options={projects.map((item) => [item.name,`${item.name}${item.archivedAt ? "（已归档）" : ""}`])}/><FilterSelect name="payment" label="支付方式" value={filters.payment} options={[["joint","共同账户"],["member","成员代付"]]}/><div className="flex items-end gap-2"><button className="rounded-xl bg-[#1f5243] px-4 py-3 text-sm font-bold text-white">筛选</button>{filtering && <Link href={`${filterAction}?tab=ledger`} className="rounded-xl border px-3 py-3 text-sm">清除</Link>}</div></form><div className="overflow-hidden rounded-2xl border bg-white">{totalEntries > 0 && <p className="border-b bg-[#f7f6f1] px-4 py-3 text-xs text-gray-600">第 {page} / {pageCount} 页 · 本页 {entries.length} 笔，共 {totalEntries} 笔；总览与投资持仓始终按全部已入账记录计算。</p>}{entries.length ? entries.map((entry) => {
    const payer = memberName(members, entry.payer_member_id);
    const kind = entry.account_kind === "bank" || entry.account_kind === "brokerage" ? entry.account_kind : null;
    const exchange = entry.movement_type === "currency_exchange" || entry.entry_type === "currency_exchange";
    const transfer = entry.entry_type === "account_transfer" && !exchange;
    const source = entry.source_account_kind === "bank" || entry.source_account_kind === "brokerage" ? entry.source_account_kind : "bank";
    const destination = entry.destination_account_kind === "bank" || entry.destination_account_kind === "brokerage" ? entry.destination_account_kind : "brokerage";
    const lockedFx = fxSnapshots.find((snapshot) => snapshot.id === entry.fx_snapshot_id);
    const difference = exchange ? exchangeDifference(entry, currency as Currency, lockedFx) : null;
    return <div key={String(entry.id)} className="flex justify-between gap-3 border-b p-4"><div><b>{String(entry.title)}</b><p className="mt-1 text-xs text-gray-500">{String(entry.occurred_at)} · {exchange ? "实际换汇" : transfer ? "账户内部划转" : String(entry.entry_type)}{entry.category ? ` · ${String(entry.category)}` : ""}</p>{Boolean(entry.project_name) && <p className="mt-1 text-xs text-gray-500">事项：{String(entry.project_name)}</p>}{transfer || exchange ? <p className="mt-1 text-xs text-gray-500">{accountName(accounts, source)} → {accountName(accounts, destination)}</p> : kind && <p className="mt-1 text-xs text-gray-500">入账账户：{accountName(accounts, kind)}</p>}{exchange && <p className="mt-1 text-xs text-gray-500">实际扣除 {money(Number(entry.amount_minor), String(entry.currency))} · 实际到账 {money(Number(entry.destination_amount_minor), String(entry.destination_currency))}</p>}{difference !== null && <p className="mt-1 text-xs text-gray-500">换汇净额折算差额（可能包含价差及费用）：{money(difference, currency)}</p>}{payer && <p className="mt-1 text-xs text-gray-500">实际付款人：{payer}</p>}</div><b>{exchange ? `${String(entry.currency)} → ${String(entry.destination_currency)}` : money(Number(entry.amount_minor), String(entry.currency || currency))}</b></div>;
  }) : <Empty text={filtering ? "没有符合筛选条件的流水。" : "暂无已入账流水。"}/>} {pageCount > 1 && <nav aria-label="流水分页" className="flex items-center justify-between border-t bg-[#f7f6f1] p-3"><PaginationLink page={page - 1} disabled={page <= 1} filters={filters} action={filterAction}>上一页</PaginationLink><span className="text-xs text-gray-600">第 {page} / {pageCount} 页</span><PaginationLink page={page + 1} disabled={page >= pageCount} filters={filters} action={filterAction}>下一页</PaginationLink></nav>}</div></div>;
}
function FilterSelect({ name, label, value, options }: { name: string; label: string; value: string; options: string[][] }) {
  return <label className="text-sm"><span className="mb-1 block text-gray-600">{label}</span><select name={name} defaultValue={value} className="w-full rounded-xl border p-3"><option value="">全部</option>{options.map(([optionValue,optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></label>;
}
function PaginationLink({ page, disabled, filters, action, children }: { page: number; disabled: boolean; filters: LedgerFilters; action: string; children: string }) {
  const className = `rounded-lg border px-3 py-2 text-sm font-bold ${disabled ? "cursor-not-allowed bg-gray-100 text-gray-400" : "bg-white text-[#1f5243]"}`;
  const query = new URLSearchParams({ tab: "ledger", ledgerPage: String(page) });
  Object.entries(filters).forEach(([key,value]) => { if (value) query.set(key,value); });
  return disabled ? <span aria-disabled="true" className={className}>{children}</span> : <Link className={className} href={`${action}?${query.toString()}`} prefetch={false}>{children}</Link>;
}
export function InvestmentList({ investments, valuations, entries, currency, openCreate, openAction, snapshots }: { investments: Row[]; valuations: Row[]; entries: Row[]; currency: string; openCreate: () => void; openAction: (investmentId: string) => void; snapshots?: Record<string, InvestmentSnapshot> }) {
  return <div className="space-y-4"><div className="flex justify-between rounded-2xl bg-[#edf7ed] p-5"><div><b>投资台账</b><p className="mt-1 text-sm text-gray-500">每个标的分别发起买入、卖出、分红或估值，提交后仍由另一位成员审批。</p></div><button onClick={openCreate} className="rounded-xl bg-[#1f5243] px-4 py-2 text-sm font-bold text-white">新增投资标的</button></div>{investments.length ? investments.map((investment) => {
    const id = String(investment.id);
    const records = entries.filter((entry) => entry.investment_id === id);
    const serverSnapshot = snapshots?.[id];
    if (serverSnapshot?.error) return <article key={id} className="rounded-2xl border bg-white p-5"><div className="flex items-start justify-between gap-3"><b>{String(investment.name)}</b><InvestmentActionButton open={() => openAction(id)}/></div><p className="mt-2 text-sm text-red-700">{serverSnapshot.error}</p></article>;
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
    return <article key={id} className="rounded-2xl border bg-white p-5"><div className="flex items-start justify-between gap-3"><div><h2 className="font-bold">{String(investment.name)}</h2><p className="mt-1 text-xs text-gray-500">{String(investment.currency)} · 可卖 {position.quantityMilli / 1000} 份</p></div><InvestmentActionButton open={() => openAction(id)}/></div><div className="mt-5 grid gap-3 md:grid-cols-5"><Card label={valuation.source === "cost_estimate" ? "当前市值（成本暂估）" : "当前市值"} value={money(market, String(investment.currency))}/><Card label="剩余成本" value={money(position.remainingCostMinor, String(investment.currency))}/><Card label="未实现收益" value={valuation.unrealizedGainMinor === null ? "待估值" : money(valuation.unrealizedGainMinor, String(investment.currency))}/><Card label="已实现收益" value={money(position.realizedGainMinor, String(investment.currency))}/><Card label="累计分红" value={money(position.dividendMinor, String(investment.currency))}/></div><div className="mt-5 border-t pt-3 text-sm"><p className="mb-3 text-xs text-gray-500">{latestValueDate ? `人工估值日期：${latestValueDate}` : "尚无人工估值；暂按剩余成本展示。"}</p><b>最近交易</b>{records.length ? records.map((entry) => <p key={String(entry.id)} className="mt-2">{String(entry.occurred_at)} · {String(entry.entry_type)} · {money(Number(entry.amount_minor), String(entry.currency || currency))}</p>) : <p className="mt-2 text-gray-500">当前列表页没有该标的交易；持仓仍按完整账本计算。</p>}</div></article>;
  }) : <Empty text="尚未有投资标的。创建标的后，可在对应卡片中发起投资操作。"/>}</div>;
}
function InvestmentActionButton({ open }: { open: () => void }) { return <button onClick={open} className="shrink-0 rounded-xl border border-[#1f5243] px-3 py-2 text-sm font-bold text-[#1f5243]">投资操作</button>; }

export function RecordModal({ close, household, investments, members, userId, spendingCategories = [], spendingProjects = [], refresh, setMessage, readOnly = false, mode = "general", initialInvestmentId }: { close: () => void; household: Props["household"]; investments: Row[]; members: Row[]; userId: string; spendingCategories?: SpendingDimension[]; spendingProjects?: SpendingDimension[]; refresh: () => void; setMessage: (value: string) => void; readOnly?: boolean; mode?: "general" | "investment"; initialInvestmentId?: string }) {
  const [type, setType] = useState(mode === "investment" ? "investment_buy" : "expense");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [localCategories, setLocalCategories] = useState(spendingCategories);
  const [localProjects, setLocalProjects] = useState(spendingProjects);
  const [categoryId, setCategoryId] = useState(activeSpendingDimensions(spendingCategories)[0]?.id ?? "");
  const [projectId, setProjectId] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [newProject, setNewProject] = useState("");
  const [addingCategory, setAddingCategory] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [currency, setCurrency] = useState<Currency>(household.reportingCurrency as Currency);
  const [accountKind, setAccountKind] = useState<CashAccountKind>("bank");
  const [sourceAccountKind, setSourceAccountKind] = useState<CashAccountKind>("bank");
  const [destinationAccountKind, setDestinationAccountKind] = useState<CashAccountKind>("bank");
  const [destinationCurrency, setDestinationCurrency] = useState<Currency>(household.reportingCurrency === "USD" ? "CNY" : "USD");
  const [destinationAmount, setDestinationAmount] = useState("");
  const investmentId = initialInvestmentId ?? "";
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [payerMemberId, setPayerMemberId] = useState(userId);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const selectedInvestment = investments.find((item) => item.id === investmentId);
  const activeCategories = activeSpendingDimensions(localCategories);
  const activeProjects = activeSpendingDimensions(localProjects);
  const selectedCategory = activeCategories.find((item) => item.id === categoryId);
  const selectedProject = activeProjects.find((item) => item.id === projectId);

  async function createDimension(kind: "category" | "project") {
    const name = (kind === "category" ? newCategory : newProject).trim();
    const max = kind === "category" ? 30 : 60;
    if (!name || name.length > max) return setMessage(`${kind === "category" ? "分类" : "事项"}名称需为 1—${max} 个字符。`);
    if (kind === "category" && ["代付", "报销", "成员代付", "报销付款"].includes(name)) return setMessage("代付和报销是事件类型，不能作为消费分类。");
    if ((kind === "category" ? localCategories : localProjects).some((item) => normalizedDimensionName(item.name) === normalizedDimensionName(name))) return setMessage(`${kind === "category" ? "分类" : "事项"}已存在。`);
    if (readOnly) {
      const item = { id: crypto.randomUUID(), name, isSystem: false };
      if (kind === "category") { setLocalCategories((items) => [...items,item]); setCategoryId(item.id); setNewCategory(""); setAddingCategory(false); }
      else { setLocalProjects((items) => [...items,item]); setProjectId(item.id); setNewProject(""); setAddingProject(false); }
      return setMessage(`已在只读预览中临时新增${kind === "category" ? "分类" : "事项"}。`);
    }
    const response = await fetch(kind === "category" ? "/api/spending-categories" : "/api/spending-projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ householdId: household.id, name }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return setMessage(body.error || "新增失败");
    const item = { id: String(body.id), name: String(body.name), isSystem: false };
    if (kind === "category") { setLocalCategories((items) => [...items,item]); setCategoryId(item.id); setNewCategory(""); setAddingCategory(false); }
    else { setLocalProjects((items) => [...items,item]); setProjectId(item.id); setNewProject(""); setAddingProject(false); }
    refresh();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      if (mode === "investment" && !selectedInvestment) throw new Error("投资标的已不存在，请刷新页面");
      const payload = {
        householdId: household.id,
        type,
        amountMinor: type === "investment_valuation" ? 0 : parseFixedDecimal(amount, 2, { allowZero: type === "investment_sell", label: type === "investment_buy" ? "实际总扣款" : type === "investment_sell" ? "实际净到账" : "金额" }),
        currency: mode === "investment" ? recordCurrency(type, household.reportingCurrency as Currency, selectedInvestment ? { currency: selectedInvestment.currency as Currency } : undefined) : currency,
        occurredAt: new Date().toISOString().slice(0, 10),
        title,
        category: ["expense", "reimbursement"].includes(type) ? selectedCategory?.name : undefined,
        categoryId: ["expense", "reimbursement"].includes(type) ? selectedCategory?.id : undefined,
        project: ["expense", "reimbursement"].includes(type) ? selectedProject?.name : undefined,
        projectId: ["expense", "reimbursement"].includes(type) ? selectedProject?.id : undefined,
        payerMemberId: ["deposit", "reimbursement"].includes(type) ? payerMemberId : undefined,
        accountKind: ["deposit", "expense", "settlement"].includes(type) ? accountKind : undefined,
        sourceAccountKind: ["account_transfer", "currency_exchange"].includes(type) ? sourceAccountKind : undefined,
        destinationAccountKind: type === "account_transfer" ? (sourceAccountKind === "bank" ? "brokerage" : "bank") : type === "currency_exchange" ? destinationAccountKind : undefined,
        destinationAmountMinor: type === "currency_exchange" ? parseFixedDecimal(destinationAmount, 2, { label: "实际到账金额" }) : undefined,
        destinationCurrency: type === "currency_exchange" ? destinationCurrency : undefined,
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
  const cashAccountEntry = ["deposit", "expense", "settlement"].includes(type);
  const transfer = type === "account_transfer";
  const exchange = type === "currency_exchange";
  return <Modal close={close} title={mode === "investment" ? `${String(selectedInvestment?.name ?? "投资标的")} · 投资操作` : "提交账户记录"}><form onSubmit={submit} className="space-y-3"><select disabled={submitting} value={type} onChange={(event) => setType(event.target.value)}>{mode === "investment" ? <><option value="investment_buy">投资买入</option><option value="investment_sell">投资卖出</option><option value="dividend">投资分红</option><option value="investment_valuation">新增投资估值</option></> : <><option value="deposit">共同存入</option><option value="expense">共同账户消费</option><option value="reimbursement">成员代付共同消费</option><option value="settlement">报销付款</option><option value="account_transfer">银行 / 券商内部划转</option><option value="currency_exchange">实际换汇</option></>}</select>{mode === "investment" && <p className="rounded-xl bg-[#f3f5ef] px-3 py-2 text-sm text-[#385248]">当前标的：<b>{String(selectedInvestment?.name ?? "未知标的")}</b><span className="mt-1 block text-xs">结算账户：共同券商 · {String(selectedInvestment?.currency ?? household.reportingCurrency)}</span></p>}{mode === "general" && <label className="block text-sm"><span className="mb-1 block text-gray-600">{exchange ? "扣除币种" : "币种"}</span><select disabled={submitting} value={currency} onChange={(event) => { const next = event.target.value as Currency; setCurrency(next); if (next === destinationCurrency) setDestinationCurrency(next === "USD" ? "CNY" : "USD"); }}><option>USD</option><option>CNY</option><option>HKD</option></select></label>}{cashAccountEntry && <label className="block text-sm"><span className="mb-1 block text-gray-600">入账账户</span><select disabled={submitting} value={accountKind} onChange={(event) => setAccountKind(event.target.value as CashAccountKind)}><option value="bank">共同银行</option><option value="brokerage">共同券商</option></select></label>}{transfer && <label className="block text-sm"><span className="mb-1 block text-gray-600">划转方向</span><select disabled={submitting} value={sourceAccountKind} onChange={(event) => setSourceAccountKind(event.target.value as CashAccountKind)}><option value="bank">共同银行 → 共同券商</option><option value="brokerage">共同券商 → 共同银行</option></select></label>}{exchange && <div className="grid grid-cols-2 gap-3"><label className="block text-sm"><span className="mb-1 block text-gray-600">扣除账户</span><select disabled={submitting} value={sourceAccountKind} onChange={(event) => setSourceAccountKind(event.target.value as CashAccountKind)}><option value="bank">共同银行</option><option value="brokerage">共同券商</option></select></label><label className="block text-sm"><span className="mb-1 block text-gray-600">到账账户</span><select disabled={submitting} value={destinationAccountKind} onChange={(event) => setDestinationAccountKind(event.target.value as CashAccountKind)}><option value="bank">共同银行</option><option value="brokerage">共同券商</option></select></label></div>}<input disabled={submitting} required value={title} onChange={(event) => setTitle(event.target.value)} placeholder={transfer ? "划转说明" : exchange ? "换汇说明" : "说明"}/>{["deposit", "reimbursement"].includes(type) && <PayerSelect members={members} userId={userId} value={payerMemberId} disabled={submitting} onChange={setPayerMemberId}/>} {trade && <><input disabled={submitting} required value={quantity} onChange={(event) => setQuantity(event.target.value)} type="number" min=".001" step=".001" placeholder="份额"/><input disabled={submitting} required value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min={type === "investment_sell" ? "0" : ".01"} step=".01" placeholder={type === "investment_buy" ? "实际总扣款（含费用）" : "实际净到账（含费用影响）"}/><input disabled={submitting} value={price} onChange={(event) => setPrice(event.target.value)} type="number" min=".0001" step=".0001" placeholder="参考成交单价（可选）"/><p className="text-xs text-gray-500">实际金额是入账依据；参考单价只作备注，不会重新计算扣款或到账。</p></>}{type === "investment_valuation" ? <input disabled={submitting} required value={price} onChange={(event) => setPrice(event.target.value)} type="number" min=".0001" step=".0001" placeholder="单位估值"/> : !trade && <input disabled={submitting} required value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min=".01" step=".01" placeholder={exchange ? "实际扣除金额" : "金额"}/>} {exchange && <><label className="block text-sm"><span className="mb-1 block text-gray-600">到账币种</span><select disabled={submitting} value={destinationCurrency} onChange={(event) => setDestinationCurrency(event.target.value as Currency)}>{(["USD", "CNY", "HKD"] as Currency[]).filter((code) => code !== currency).map((code) => <option key={code}>{code}</option>)}</select></label><input disabled={submitting} required value={destinationAmount} onChange={(event) => setDestinationAmount(event.target.value)} type="number" min=".01" step=".01" placeholder="实际到账金额"/><p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">两端实际金额直接入账；系统不会按参考汇率重算，也不会另行推断手续费。</p></>}{["expense", "reimbursement"].includes(type) && <><label className="block text-sm"><span className="mb-1 block text-gray-600">消费分类</span><select disabled={submitting} required value={categoryId} onChange={(event) => event.target.value === "__new__" ? setAddingCategory(true) : setCategoryId(event.target.value)}><option value="" disabled>请选择分类</option>{activeCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="__new__">＋ 新增分类</option></select></label>{addingCategory && <div className="flex gap-2"><input value={newCategory} maxLength={30} onChange={(event) => setNewCategory(event.target.value)} placeholder="新分类名称（1—30字）"/><button type="button" onClick={() => createDimension("category")} className="shrink-0 rounded-xl border px-3 text-sm font-bold">添加</button></div>}<label className="block text-sm"><span className="mb-1 block text-gray-600">具体事项（可选）</span><select disabled={submitting} value={projectId} onChange={(event) => event.target.value === "__new__" ? setAddingProject(true) : setProjectId(event.target.value)}><option value="">不关联事项</option>{activeProjects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="__new__">＋ 新增事项</option></select></label>{addingProject && <div className="flex gap-2"><input value={newProject} maxLength={60} onChange={(event) => setNewProject(event.target.value)} placeholder="新事项名称，例如 2026 香港旅行"/><button type="button" onClick={() => createDimension("project")} className="shrink-0 rounded-xl border px-3 text-sm font-bold">添加</button></div>}</>}{transfer && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">同币种划转不会改变共同现金总额，也不会自动换汇或补足任一账户。</p>}<button disabled={submitting} className="w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-60">{submitting ? "正在提交…" : "提交给对方审批"}</button></form></Modal>;
}

export function LedgerSettings({ close, household, categories, projects, refresh, setMessage, readOnly = false }: { close: () => void; household: Props["household"]; categories: SpendingDimension[]; projects: SpendingDimension[]; refresh: () => void; setMessage: (value: string) => void; readOnly?: boolean }) {
  const [localCategories, setLocalCategories] = useState(categories);
  const [localProjects, setLocalProjects] = useState(projects);
  const [categoryName, setCategoryName] = useState("");
  const [projectName, setProjectName] = useState("");

  async function create(kind: "category" | "project") {
    const name = (kind === "category" ? categoryName : projectName).trim();
    const max = kind === "category" ? 30 : 60;
    if (!name || name.length > max) return setMessage(`${kind === "category" ? "分类" : "事项"}名称需为 1—${max} 个字符。`);
    if (kind === "category" && ["代付", "报销", "成员代付", "报销付款"].includes(name)) return setMessage("代付和报销是事件类型，不能作为消费分类。");
    const existing = (kind === "category" ? localCategories : localProjects).some((item) => normalizedDimensionName(item.name) === normalizedDimensionName(name));
    if (existing) return setMessage(`${kind === "category" ? "分类" : "事项"}已存在。`);
    let item: SpendingDimension;
    if (readOnly) item = { id: crypto.randomUUID(), name, isSystem: false };
    else {
      const response = await fetch(kind === "category" ? "/api/spending-categories" : "/api/spending-projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ householdId: household.id, name }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return setMessage(body.error || "新增失败");
      item = { id: String(body.id), name: String(body.name), isSystem: false };
    }
    if (kind === "category") { setLocalCategories((items) => [...items,item]); setCategoryName(""); }
    else { setLocalProjects((items) => [...items,item]); setProjectName(""); }
    setMessage(readOnly ? "已在只读预览中临时新增。" : "已新增并同步给双方。");
    refresh();
  }

  async function toggle(kind: "category" | "project", item: SpendingDimension) {
    const archived = !item.archivedAt;
    if (!readOnly) {
      const response = await fetch(kind === "category" ? "/api/spending-categories" : "/api/spending-projects", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: item.id, archived }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return setMessage(body.error || "操作失败");
    }
    const change = (candidate: SpendingDimension) => candidate.id === item.id ? { ...candidate, archivedAt: archived ? new Date().toISOString() : undefined } : candidate;
    if (kind === "category") setLocalCategories((items) => items.map(change)); else setLocalProjects((items) => items.map(change));
    setMessage(archived ? "已归档；历史流水名称保持不变。" : "已恢复，可用于新记录。");
    refresh();
  }

  return <Modal close={close} title="账本设置 · 用途"><div className="space-y-6"><section><b className="text-sm">消费分类</b><p className="mt-1 text-xs text-gray-500">双方共享；代付和报销属于事件类型，不能作为分类。</p><div className="mt-3 flex gap-2"><input value={categoryName} maxLength={30} onChange={(event) => setCategoryName(event.target.value)} placeholder="新增分类（1—30字）"/><button onClick={() => create("category")} className="shrink-0 rounded-xl border px-3 text-sm font-bold">新增</button></div><DimensionList items={localCategories} toggle={(item) => toggle("category",item)}/></section><section><b className="text-sm">具体事项</b><p className="mt-1 text-xs text-gray-500">同一事项可以聚合餐饮、交通等不同类别，例如“2026 香港旅行”。</p><div className="mt-3 flex gap-2"><input value={projectName} maxLength={60} onChange={(event) => setProjectName(event.target.value)} placeholder="新增事项"/><button onClick={() => create("project")} className="shrink-0 rounded-xl border px-3 text-sm font-bold">新增</button></div><DimensionList items={localProjects} toggle={(item) => toggle("project",item)} empty="尚无具体事项。"/></section></div></Modal>;
}

function DimensionList({ items, toggle, empty = "暂无分类。" }: { items: SpendingDimension[]; toggle: (item: SpendingDimension) => void; empty?: string }) {
  return items.length ? <div className="mt-3 divide-y rounded-xl border">{items.map((item) => <div key={item.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm"><span className={item.archivedAt ? "text-gray-400 line-through" : ""}>{item.name}{item.isSystem ? " · 内置" : ""}</span><button onClick={() => toggle(item)} className="rounded-lg border px-2 py-1 text-xs">{item.archivedAt ? "恢复" : "归档"}</button></div>)}</div> : <p className="mt-3 text-sm text-gray-500">{empty}</p>;
}

export function FxRateModal({ close, household, current, refresh, setMessage, readOnly = false }: { close: () => void; household: Props["household"]; current?: FxRateSnapshotView; refresh: () => void; setMessage: (value: string) => void; readOnly?: boolean }) {
  const [usdToCny, setUsdToCny] = useState(current ? String(current.usdToCny) : "");
  const [usdToHkd, setUsdToHkd] = useState(current ? String(current.usdToHkd) : "");
  const [sourceNote, setSourceNote] = useState(current?.sourceNote ?? "");
  const [effectiveAt, setEffectiveAt] = useState(() => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); });
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const effectiveIso = new Date(effectiveAt).toISOString();
      const payload = { householdId: household.id, type: "fx_rate_update", amountMinor: 0, currency: "USD", occurredAt: effectiveIso.slice(0, 10), title: "手动汇率更新", effectiveAt: effectiveIso, usdToCny: usdToCny.trim(), usdToHkd: usdToHkd.trim(), sourceNote: sourceNote.trim(), idempotencyKey };
      if (readOnly) {
        setMessage("本地只读预览不会提交；正式环境中需由另一位成员批准后才会更新总览。");
        return;
      }
      const response = await fetch("/api/proposals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return setMessage(body.error || "提交失败，请重试");
      close();
      setMessage("完整汇率快照已提交，批准前不会影响总览。");
      refresh();
    } catch (error) {
      setMessage(error instanceof Error ? `${error.message} 草稿已保留。` : "提交失败，草稿已保留。");
    } finally {
      setSubmitting(false);
    }
  }

  return <Modal close={close} title="提交手动汇率"><form onSubmit={submit} className="space-y-3"><p className="rounded-xl bg-[#f3f5ef] px-3 py-2 text-sm text-[#385248]">每次提交都保存 USD/CNY 与 USD/HKD 的完整快照。未改动的币种请保留当前值；另一位成员批准后才生效。</p><label className="block text-sm"><span className="mb-1 block text-gray-600">1 USD = 多少 CNY</span><input disabled={submitting} required value={usdToCny} onChange={(event) => setUsdToCny(event.target.value)} inputMode="decimal" placeholder="例如 7.2"/></label><label className="block text-sm"><span className="mb-1 block text-gray-600">1 USD = 多少 HKD</span><input disabled={submitting} required value={usdToHkd} onChange={(event) => setUsdToHkd(event.target.value)} inputMode="decimal" placeholder="例如 7.8"/></label><label className="block text-sm"><span className="mb-1 block text-gray-600">生效时间</span><input disabled={submitting} required type="datetime-local" value={effectiveAt} max={new Date().toISOString().slice(0, 16)} onChange={(event) => setEffectiveAt(event.target.value)}/></label><label className="block text-sm"><span className="mb-1 block text-gray-600">人工来源或说明</span><input disabled={submitting} required value={sourceNote} maxLength={240} onChange={(event) => setSourceNote(event.target.value)} placeholder="例如：银行 App 参考价，人工录入"/></label><p className="text-xs text-gray-500">这是人工维护的参考汇率；系统不会获取实时市场行情。历史记录继续引用原批准快照。</p><button disabled={submitting} className="w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-60">{submitting ? "正在提交…" : "提交给对方审批"}</button></form></Modal>;
}
function InvestmentCreate({ close, household, refresh, setMessage }: { close: () => void; household: Props["household"]; refresh: () => void; setMessage: (value: string) => void }) { const [name, setName] = useState(""); const [ticker, setTicker] = useState(""); const [currency, setCurrency] = useState<Currency>("USD"); const [assetType, setAssetType] = useState("基金 / ETF"); async function submit(event: React.FormEvent) { event.preventDefault(); const response = await fetch("/api/investments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ householdId: household.id, name, ticker: ticker || undefined, assetType, currency }) }); const body = await response.json(); if (!response.ok) return setMessage(body.error || "创建失败"); close(); setMessage("投资标的已创建，初始持仓为 0；后续请在该标的卡片中发起投资操作。"); refresh(); } return <Modal close={close} title="新增投资标的"><form onSubmit={submit} className="space-y-3"><p className="text-sm text-gray-500">新标的初始持仓固定为 0，不影响共同现金；所有持仓只从已批准交易流水计算。</p><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="标的名称"/><input value={ticker} onChange={(event) => setTicker(event.target.value)} placeholder="代码（可选）"/><input value={assetType} onChange={(event) => setAssetType(event.target.value)} placeholder="类型，例如 ETF、基金、股票"/><select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}><option>USD</option><option>CNY</option><option>HKD</option></select><button className="w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white">直接创建标的</button></form></Modal>; }
function InviteModal({ close, householdId, setMessage }: { close: () => void; householdId: string; setMessage: (value: string) => void }) { const [email, setEmail] = useState(""); const [link, setLink] = useState(""); async function create(event: React.FormEvent) { event.preventDefault(); const response = await fetch(`/api/households/${householdId}/invitations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }); const body = await response.json(); if (!response.ok) return setMessage(body.error || "创建邀请失败"); setLink(`${window.location.origin}/invite/${body.token}`); } return <Modal close={close} title="邀请伴侣"><form onSubmit={create} className="space-y-3"><p className="text-sm text-gray-500">请输入伴侣将用来注册/登录的邮箱。链接仅可被该邮箱账号接受。</p><input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="伴侣邮箱"/><button className="w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white">生成邀请链接</button></form>{link && <div className="mt-4 rounded-xl bg-[#f3f5ef] p-3"><p className="break-all text-xs">{link}</p><button onClick={() => navigator.clipboard.writeText(link)} className="mt-3 rounded-lg border px-3 py-2 text-sm"><Copy size={15} className="mr-1 inline"/>复制链接</button></div>}</Modal>; }
function Card({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl border bg-white p-4"><p className="text-sm text-gray-500">{label}</p><b className="mt-3 block text-xl">{value}</b></div>; }
function Empty({ text }: { text: string }) { return <p className="rounded-2xl border bg-white p-8 text-center text-sm text-gray-500">{text}</p>; }
function Modal({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) { return <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"><div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6"><div className="mb-4 flex justify-between"><b>{title}</b><button onClick={close}>×</button></div><div className="[&_input]:w-full [&_input]:rounded-xl [&_input]:border [&_input]:p-3 [&_select]:w-full [&_select]:rounded-xl [&_select]:border [&_select]:p-3">{children}</div></div></div>; }
