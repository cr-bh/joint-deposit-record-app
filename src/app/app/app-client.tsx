"use client";
import { createUUID } from "@/lib/uuid";

import { useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { LedgerClockProvider, useLedgerTimeZone } from "./ledger-clock";
import { ledgerToday, ledgerTimestamp, isLedgerTimeZone } from "@/lib/domain/ledger-time";
import Link from "next/link";
import { useLedgerSync } from "./use-ledger-sync";
import { useRouter } from "next/navigation";
import { Copy, LogOut, Plus, RefreshCcw, Settings, UserPlus } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { valuePosition, type InvestmentPosition } from "@/lib/domain/investment-calculations";

import InvestmentCenter from "./investment-center";
import type { LedgerRecordState } from "@/lib/domain/ledger-record-states";
import HouseholdManagement, { HouseholdManagementDetails } from "./household-management";
import ApprovalStatus from "./approval-status";
import OverviewCards from "./overview-cards";
import SpendingCharts from "./spending-charts";
import type { OverviewSummary } from "@/lib/domain/overview-summary";
import type { SpendingReport } from "@/lib/domain/spending-report";
import { InvestmentActionModal, InvestmentMetadataModal, InvestmentProposalDetails } from "./investment-modal";
import { ledgerEventFromRow } from "@/lib/domain/ledger-adapter";
import { summarizeLedger, recordCurrency, reportBalances } from "@/lib/domain/ledger-summary";
import { parseFixedDecimal } from "@/lib/domain/fixed-decimal";
import type { AccountBalances, CashTransfer } from "@/lib/domain/account-balances";
import {eventLabel, type LedgerEventType, type CashAccountKind } from "@/lib/domain/balance-calculations";
import { ratesFromSnapshot, type FxRateSnapshot } from "@/lib/domain/fx-rates";
import { activeSpendingDimensions, type SpendingDimension } from "@/lib/domain/spending-dimensions";
import { emptyLedgerFilters, type LedgerFilters } from "@/lib/domain/ledger-filters";
import { type ReimbursementClaimView } from "@/lib/domain/reimbursement-claims";

import CorrectionModal, {CorrectionDetails, type CorrectionTarget} from "./correction-modal";
import ReimbursementCenter, { SettlementAllocationDetails } from "./reimbursement-center";
import type { SettlementBatchView } from "@/lib/domain/settlement-batches";

export { emptyLedgerFilters } from "@/lib/domain/ledger-filters";
export type { LedgerFilters } from "@/lib/domain/ledger-filters";

type Row = Record<string, unknown>;
type Currency = "USD" | "CNY" | "HKD";
export type LedgerSummary = ReturnType<typeof summarizeLedger>;
export type InvestmentSnapshot =
  | { position: InvestmentPosition; valuation: ReturnType<typeof valuePosition>; latestValueDate?: string; error?: never }
  | { error: string; position?: never; valuation?: never; latestValueDate?: never };
export type FxRateSnapshotView = FxRateSnapshot & { stale: boolean };
type Props = { ledgerRecordStates?: Record<string, LedgerRecordState>; household: { id: string; name: string; reportingCurrency: string; ledgerVersion?: number; timeZone?: string; timeZoneConfirmed?: boolean; status?: string; archivedAt?: string; hasArchiveSnapshot?: boolean }; userId: string; role: string; entries: Row[]; recentEntries?: Row[]; proposals: Row[]; investments: Row[]; valuations: Row[]; members: Row[]; accounts?: Row[]; accountBalances?: AccountBalances; fxSnapshot?: FxRateSnapshotView; fxSnapshots?: FxRateSnapshot[]; spendingCategories?: SpendingDimension[]; spendingProjects?: SpendingDimension[]; reimbursementClaims?: ReimbursementClaimView[]; settlementBatches?: SettlementBatchView[]; initialBatchId?: string; unreviewedPaymentCount?: number; overviewSummary?: OverviewSummary; spendingReport?: SpendingReport; ledgerSummary?: LedgerSummary; postedEntryCount?: number; ledgerTotalEntries?: number; initialTab?: string; ledgerPage?: number; ledgerPageCount?: number; ledgerFilters?: LedgerFilters; investmentSnapshots?: Record<string, InvestmentSnapshot>; investmentTransfers?: CashTransfer[] };
const accountDefaults: Record<CashAccountKind, string> = { bank: "共同银行", brokerage: "共同券商" };
const normalizedDimensionName = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
const accountName = (accounts: Row[], kind: CashAccountKind) => String(accounts.find((account) => account.kind === kind)?.name ?? accountDefaults[kind]);
const money = (minor: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
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

export default function AppClient(props: Props) { return <LedgerClockProvider timeZone={props.household.timeZone ?? "UTC"}><AppContent {...props}/></LedgerClockProvider>; }

function AppContent({ ledgerRecordStates = {}, household, userId, role, entries, recentEntries = entries, proposals, investments, valuations, members, accounts = [], accountBalances, fxSnapshot, fxSnapshots = [], spendingCategories = [], spendingProjects = [], reimbursementClaims = [], settlementBatches = [], initialBatchId, unreviewedPaymentCount = 0, overviewSummary, spendingReport, ledgerSummary, postedEntryCount, ledgerTotalEntries, initialTab = "总览", ledgerPage = 1, ledgerPageCount = 1, ledgerFilters = emptyLedgerFilters, investmentSnapshots, investmentTransfers = [] }: Props) {
  const archived = household.status === "archived";
  const [managementOpen,setManagementOpen] = useState(false);
  const router = useRouter();
  const [tab, setTab] = useState(initialTab); const [recordOpen, setRecordOpen] = useState(false); const [investmentOpen, setInvestmentOpen] = useState(false); const [investmentActionId, setInvestmentActionId] = useState<string | null>(null); const [inviteOpen, setInviteOpen] = useState(false); const [fxOpen, setFxOpen] = useState(false); const [settingsOpen, setSettingsOpen] = useState(false); const [message, setMessage] = useState("");
  const posted = entries;
  const recentPosted = recentEntries.filter((entry) => entry.status === "posted");
  const pending = proposals.filter((proposal) => ["pending_approval", "overdue_pending"].includes(String(proposal.status)));
  const syncState = useLedgerSync(household.id);
  const syncLabel = { connected: "实时同步已连接", connecting: "正在连接同步", reconnecting: "正在恢复同步", offline: "离线 · 待同步" }[syncState];
  const decisions = useRef(new Set<string>());
  const [decisionBusy,setDecisionBusy] = useState<string[]>([]);
  async function decide(id: string, approve: boolean) {
    if (decisions.current.has(id)) return;
    decisions.current.add(id); setDecisionBusy([...decisions.current]);
    try {
      const response = await fetch(`/api/proposals/${id}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "操作失败"); router.refresh();
    } catch (error) { setMessage(`${error instanceof Error ? error.message : "操作失败"} 请刷新核对结果后重试。`); }
    finally { decisions.current.delete(id); setDecisionBusy([...decisions.current]); }
  }
  async function withdraw(id: string) {
    if (decisions.current.has(id)) return;
    decisions.current.add(id); setDecisionBusy([...decisions.current]);
    try { const response = await fetch(`/api/proposals/${id}/withdraw`, { method: "POST" }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "撤回失败"); router.refresh(); setMessage("提案已撤回，相关预留额度已释放。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "撤回失败，请刷新核对结果后重试"); }
    finally { decisions.current.delete(id); setDecisionBusy([...decisions.current]); }
  }
  async function logout() { await createClient().auth.signOut(); router.push("/login"); }
  const totalPostedEntries = postedEntryCount ?? posted.length;
  return <main className="min-h-screen bg-[#f3f2ed] p-4 text-[#1d3029] md:p-7"><div className="mx-auto max-w-7xl rounded-3xl border bg-[#fbfaf6]">{managementOpen && <HouseholdManagement householdId={household.id} close={() => setManagementOpen(false)} refresh={() => router.refresh()} notify={setMessage}/>}<header className="flex flex-wrap justify-between gap-3 border-b p-5"><div><p className="text-xs tracking-widest text-[#587064]">在线共同账本 · {role === "owner" ? "管理员" : "成员"}</p><h1 className="text-2xl font-bold">{household.name}</h1><p className="mt-1 text-xs text-gray-500">当前账号：{memberName(members,userId)} · {members.length}/2 位成员 · {pending.length} 笔待审批</p><p role="status" className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${syncState === "connected" ? "bg-[#e6eee7] text-[#1f5243]" : "bg-amber-50 text-amber-800"}`}><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${syncState === "connected" ? "bg-[#1f5243]" : "bg-amber-600"}`}/>{syncLabel}</p></div><div className="flex flex-wrap gap-2"><button onClick={() => setManagementOpen(true)} className="rounded-xl border px-3 py-2 text-sm font-bold">{archived ? "申请恢复账本" : "账本管理"}</button>{!archived && <NewRecordButton open={() => setRecordOpen(true)}/>}<button disabled={archived} onClick={() => setSettingsOpen(true)} className="rounded-xl border px-3 py-2 text-sm font-bold"><Settings size={16} className="mr-1 inline"/>账本设置</button>{!archived && role === "owner" && members.length < 2 && <button onClick={() => setInviteOpen(true)} className="rounded-xl border px-3 py-2 text-sm font-bold"><UserPlus size={16} className="mr-1 inline"/>邀请伴侣</button>}<button onClick={() => router.refresh()} className="rounded-xl border p-2" aria-label="刷新"><RefreshCcw size={17}/></button><button onClick={logout} className="rounded-xl border p-2" aria-label="退出"><LogOut size={17}/></button></div></header><nav className="flex gap-1 overflow-auto border-b p-2">{["总览", "审批中心", "流水", "投资", "代付与报销"].map((item) => <button key={item} onClick={() => { setTab(item); const query = new URLSearchParams(window.location.search); query.delete("entry"); query.delete("batch"); query.delete("ledgerPage"); query.set("tab", item === "流水" ? "ledger" : item === "代付与报销" ? "reimbursements" : item === "投资" ? "investments" : item === "审批中心" ? "approvals" : "overview"); router.push(`/app?${query.toString()}`); }} className={`shrink-0 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-bold ${tab === item ? "bg-[#1f5243] text-white" : ""}`}>{item}{item === "审批中心" && pending.length > 0 ? ` (${pending.length})` : ""}</button>)}</nav><section className="p-5 md:p-7">{syncState !== "connected" && <p role="status" className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{syncState === "offline" ? "当前设备离线，显示的是上次读取的账本。联网后会自动更新。" : syncState === "connecting" ? "正在连接账本同步…" : "实时同步正在恢复，账本会自动重新核对；也可点击刷新。"}</p>}{archived && <p className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">已归档 · 只读 · {household.hasArchiveSnapshot ? "资产按冻结快照展示" : "历史归档快照待核对"}，未清垫款及应返款保留。恢复需另一位成员批准。</p>}<p className="mb-4 text-xs text-gray-500">账本时区：{household.timeZone ?? "UTC"}{household.timeZoneConfirmed === false ? " · 历史账本沿用 UTC，请在账本设置核对确认；历史发生日不会自动改写。" : ""}</p>{tab === "总览" && <Dashboard currency={household.reportingCurrency} entries={recentPosted} summary={ledgerSummary} postedEntryCount={totalPostedEntries} accounts={accounts} accountBalances={accountBalances} fxSnapshot={fxSnapshot} openFx={archived ? undefined : () => setFxOpen(true)} overviewSummary={overviewSummary} spendingReport={spendingReport} filters={ledgerFilters} categories={spendingCategories} projects={spendingProjects} pendingCount={pending.length}/>} {tab === "审批中心" && <Approvals busyIds={decisionBusy} proposals={proposals} userId={userId} decide={decide} currency={household.reportingCurrency} members={members} fxSnapshots={fxSnapshots} settlementBatches={settlementBatches} claims={reimbursementClaims} withdraw={withdraw}/>} {tab === "流水" && <Ledger recordStates={ledgerRecordStates} entries={posted} currency={household.reportingCurrency} members={members} accounts={accounts} fxSnapshots={fxSnapshots} totalEntries={ledgerTotalEntries ?? totalPostedEntries} page={ledgerPage} pageCount={ledgerPageCount} filters={ledgerFilters} categories={spendingCategories} projects={spendingProjects} householdId={archived ? undefined : household.id} proposals={proposals} refresh={() => router.refresh()} notify={setMessage}/>} {tab === "投资" && <InvestmentList archived={archived} householdId={household.id} investments={investments} valuations={valuations} entries={recentPosted} currency={household.reportingCurrency} openCreate={() => setInvestmentOpen(true)} openAction={setInvestmentActionId} snapshots={investmentSnapshots} fxSnapshot={fxSnapshot} refresh={() => router.refresh()} notify={setMessage}/>} {tab === "代付与报销" && <ReimbursementCenter archived={archived} householdId={household.id} userId={userId} claims={reimbursementClaims} batches={settlementBatches} proposals={proposals} members={members} fxSnapshot={fxSnapshot} fxSnapshots={fxSnapshots} refresh={() => router.refresh()} notify={setMessage} initialBatchId={initialBatchId} unreviewedPaymentCount={unreviewedPaymentCount}/>}</section></div>{recordOpen && <RecordModal close={() => setRecordOpen(false)} household={household} investments={investments} members={members} userId={userId} spendingCategories={spendingCategories} spendingProjects={spendingProjects} refresh={() => router.refresh()} setMessage={setMessage}/>} {investmentActionId && <RecordModal close={() => setInvestmentActionId(null)} household={household} investments={investments} members={members} userId={userId} spendingCategories={spendingCategories} spendingProjects={spendingProjects} refresh={() => router.refresh()} setMessage={setMessage} mode="investment" initialInvestmentId={investmentActionId} transfers={investmentTransfers} accountBalances={accountBalances}/>} {settingsOpen && <LedgerSettings close={() => setSettingsOpen(false)} household={household} categories={spendingCategories} projects={spendingProjects} refresh={() => router.refresh()} setMessage={setMessage}/>} {fxOpen && <FxRateModal close={() => setFxOpen(false)} household={household} current={fxSnapshot} refresh={() => router.refresh()} setMessage={setMessage}/>} {investmentOpen && <InvestmentCreate close={() => setInvestmentOpen(false)} household={household} refresh={() => router.refresh()} setMessage={setMessage}/>} {inviteOpen && <InviteModal close={() => setInviteOpen(false)} householdId={household.id} setMessage={setMessage}/>} {message && <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-[#193d32] px-5 py-3 text-sm text-white">{message}</div>}</main>;
}
export function Dashboard({ currency, entries, transfers = [], accounts = [], accountBalances, fxSnapshot, rates, openFx, summary: providedSummary, postedEntryCount, overviewSummary, spendingReport, filters = emptyLedgerFilters, categories = [], projects = [], pendingCount = 0, action = "/app" }: { currency: string; entries: Row[]; transfers?: CashTransfer[]; accounts?: Row[]; accountBalances?: AccountBalances; fxSnapshot?: FxRateSnapshotView; rates?: Partial<Record<Currency, number>>; openFx?: () => void; summary?: LedgerSummary; postedEntryCount?: number; overviewSummary?: OverviewSummary; spendingReport?: SpendingReport; filters?: LedgerFilters; categories?: SpendingDimension[]; projects?: SpendingDimension[]; pendingCount?: number; action?: string }) {
  const summary = useMemo(() => {
    if (providedSummary) return { value: providedSummary, error: null };
    try { return { value: summarizeLedger(entries.map(ledgerEventFromRow), currency as Currency, rates, transfers), error: null }; }
    catch { return { value: null, error: "流水数据无法核算，请核对记录后重试。" }; }
  }, [entries, currency, rates, transfers, providedSummary]);
  if (!summary.value) return <Empty text={summary.error!}/>;
  const { cash, cashByCurrency } = summary.value;
  return <div className="space-y-6">
    {overviewSummary ? <OverviewCards summary={overviewSummary} currency={currency} fxTime={fxSnapshot?.approvedAt} pendingCount={pendingCount}/> : <Card label="共同现金" value={cash.amountMinor === null ? "待完善汇率" : money(cash.amountMinor, currency)}/>}
    <FxRatePanel snapshot={fxSnapshot} open={openFx}/>
    <details className="rounded-2xl border bg-white p-4"><summary className="cursor-pointer text-sm font-semibold">共同现金 · 银行 / 券商原币明细</summary><div className="mt-4 space-y-3">{accountBalances && <AccountCashCards accounts={accounts} balances={accountBalances}/>}<div className="text-sm"><b>原币现金合计</b><div className="mt-2 flex flex-wrap gap-4">{Object.entries(cashByCurrency).map(([code, amount]) => <span key={code}>{code} {money(amount, code)}</span>)}</div>{cash.missingCurrencies.length > 0 && <p className="mt-2 text-amber-800">缺少 {cash.missingCurrencies.join(" / ")} 已确认汇率，暂不显示折算合计。</p>}</div><p className="text-xs text-gray-500">负余额保留符号参与资产计算；券商闲置现金计入共同现金，不计入投资市值。</p></div></details>
    <p className="text-xs text-gray-500">已入账 {postedEntryCount ?? entries.length} 笔 · {currency}</p>
    {spendingReport && <SpendingCharts key={JSON.stringify(filters)} report={spendingReport} currency={currency} filters={filters} categories={categories} projects={projects} action={action}/>}
  </div>;
}
export function FxRatePanel({ snapshot, open }: { snapshot?: FxRateSnapshotView; open?: () => void }) {
  const timeZone = useLedgerTimeZone();
  const timestamp = (value: string) => ledgerTimestamp(value,timeZone);
  return <section className="rounded-2xl border bg-white p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><b>手动汇率 / 最新已确认汇率</b>{snapshot ? <><p className="mt-3 text-sm">1 USD = <b>{snapshot.usdToCny}</b> CNY · 1 USD = <b>{snapshot.usdToHkd}</b> HKD</p><p className={`mt-2 text-xs ${snapshot.stale ? "text-amber-800" : "text-gray-500"}`}>汇率更新于 {timestamp(snapshot.approvedAt)}（{timeZone}） · 来源：{snapshot.sourceNote}{snapshot.stale ? " · 已超过24小时，仅提示不禁用" : ""}</p></> : <p className="mt-2 text-sm text-amber-800">尚无已确认汇率；外币折算保持待完善。</p>}</div>{open && <button onClick={open} className="rounded-xl border border-[#1f5243] px-3 py-2 text-sm font-bold text-[#1f5243]">提交汇率更新</button>}</div></section>;
}
export function AccountCashCards({ accounts = [], balances }: { accounts?: Row[]; balances: AccountBalances }) {
  return <section><div className="mb-3"><b>账户现金</b><p className="mt-1 text-sm text-gray-500">内部划转只改变资金所在账户；任一账户都允许显示负余额。</p></div><div className="grid gap-4 md:grid-cols-2">{(["bank", "brokerage"] as CashAccountKind[]).map((kind) => <article key={kind} className="rounded-2xl border bg-white p-5"><p className="text-sm font-bold">{accountName(accounts, kind)}</p><div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">{(["USD", "CNY", "HKD"] as Currency[]).map((code) => <span key={code} className={balances[kind][code] < 0 ? "font-bold text-red-700" : ""}>{code} {money(balances[kind][code], code)}</span>)}</div></article>)}</div></section>;
}
export function Approvals({ busyIds = [], proposals, userId, decide, currency, members, fxSnapshots, settlementBatches = [], claims = [], withdraw, reimbursementPath = "/app" }: { proposals: Row[]; userId: string; decide: (id: string, approve: boolean) => void; currency: string; members: Row[]; fxSnapshots: FxRateSnapshot[]; settlementBatches?: SettlementBatchView[]; claims?: ReimbursementClaimView[]; withdraw?: (id: string) => void; reimbursementPath?: string; busyIds?: string[] }) {
  const timeZone = useLedgerTimeZone();
  const timestamp = (value: string) => ledgerTimestamp(value,timeZone);
  return <div className="space-y-3">{proposals.length ? proposals.map((proposal) => {
    const payload = proposal.payload as Row;
    const mine = proposal.submitter_id === userId;
    const payer = memberName(members, payload.payerMemberId);
    const transfer = payload.type === "account_transfer";
    const exchange = payload.type === "currency_exchange";
    const rateUpdate = payload.type === "fx_rate_update";
    const management = ["household_archive","household_restore"].includes(String(payload.type));
    const account = payload.accountKind === "brokerage" ? "共同券商" : "共同银行";
    const source = payload.sourceAccountKind === "brokerage" ? "共同券商" : "共同银行";
    const destination = payload.destinationAccountKind === "bank" ? "共同银行" : "共同券商";
    const category = typeof payload.category === "string" ? payload.category : "";
    const project = typeof payload.project === "string" ? payload.project : "";
    const lockedFx = fxSnapshots.find((snapshot) => snapshot.id === proposal.fx_snapshot_id);
    const batch = settlementBatches.find(item => item.proposalId === proposal.id);
    const funding = payload.funding as Row | undefined;
    const difference = exchange ? exchangeDifference(payload, currency as Currency, lockedFx) : funding && funding.currency !== payload.currency ? exchangeDifference({ ...funding, destinationCurrency: payload.currency }, currency as Currency, lockedFx) : null;
    return <article id={`approval-${String(proposal.id)}`} key={String(proposal.id)} className="rounded-2xl border border-[#1f5243]/10 bg-white p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1 basis-48"><b className="text-base text-[#1d3029]">{String(payload.title)}</b>{rateUpdate ? <><p className="mt-1 text-xs text-gray-500">手动汇率完整快照 · 生效时间 {timestamp(String(payload.effectiveAt))}（{timeZone}）</p><p className="mt-1 text-xs text-gray-500">1 USD = {String(payload.usdToCny)} CNY · 1 USD = {String(payload.usdToHkd)} HKD</p><p className="mt-1 text-xs text-gray-500">来源：{String(payload.sourceNote)}</p></> : exchange ? <><p className="mt-1 text-xs text-gray-500">实际换汇 · 扣除 {money(Number(payload.amountMinor), String(payload.currency))} · 到账 {money(Number(payload.destinationAmountMinor), String(payload.destinationCurrency))}</p><p className="mt-1 text-xs text-gray-500">{source} → {destination}</p></> : <><p className="mt-1 text-xs text-gray-500">{transfer ? "账户内部划转" : payload.type === "void_record" ? "作废申请" : payload.type === "investment_valuation" ? "投资估值" : management ? payload.type === "household_archive" ? "账本归档申请" : "账本恢复申请" : eventLabel(payload.type as LedgerEventType) ?? "账本记录"} · {Number(payload.amountMinor) ? money(Number(payload.amountMinor), String(payload.currency || currency)) : "非现金操作"}</p>{transfer ? <p className="mt-1 text-xs text-gray-500">{source} → {destination}</p> : (["deposit", "expense", "settlement"].includes(String(payload.type)) || (payload.type === "expense_refund" && payload.recipient === "common")) && <p className="mt-1 text-xs text-gray-500">入账账户：{account}</p>}</>}{category && <p className="mt-1 text-xs text-gray-500">用途：{category}{project ? ` · 事项：${project}` : ""}</p>}{lockedFx && <p className="mt-1 text-xs text-gray-500">锁定汇率：1 USD = {lockedFx.usdToCny} CNY / {lockedFx.usdToHkd} HKD · {lockedFx.sourceNote}</p>}{difference !== null && <p className="mt-1 text-xs text-gray-500">换汇净额折算差额（可能包含价差及费用）：{money(difference, currency)}</p>}{payer && <p className="mt-1 text-xs text-gray-500">实际付款人：{payer}</p>}</div><ApprovalStatus status={String(proposal.status)}/></div><InvestmentProposalDetails payload={payload}/>{management && <HouseholdManagementDetails snapshot={payload.reviewSnapshot} reason={String(payload.reason)}/>}<CorrectionDetails payload={payload}/>{Boolean(proposal.replacement_proposal_id)&&<p className="mt-2 text-sm">关联替代审批：{String(proposal.replacement_proposal_id)}（单独审批）</p>}{Boolean(proposal.replaces_void_proposal_id)&&<p className="mt-2 text-sm">来自作废审批：{String(proposal.replaces_void_proposal_id)}</p>}<p className="mt-3 break-all text-xs leading-5 text-gray-400">审批编号：{String(proposal.id)}{proposal.decided_at ? ` · ${timestamp(String(proposal.decided_at))}（${timeZone}）` : ""}</p>{batch && <><p className="mt-3 text-sm">收款成员：{memberName(members,batch.claimantId)}</p><SettlementAllocationDetails batch={batch} claims={claims}/><Link href={`${reimbursementPath}?tab=reimbursements&batch=${batch.id}`} className="mt-2 inline-block text-sm underline">查看打款批次与原单</Link></>}{["pending_approval", "overdue_pending"].includes(String(proposal.status)) && <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-gray-100 pt-4">{mine ? <><span className="min-w-0 flex-1 text-xs leading-5 text-gray-500">等待另一位成员确认</span>{withdraw && <button disabled={busyIds.includes(String(proposal.id))} onClick={() => withdraw(String(proposal.id))} className="min-h-11 shrink-0 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1f5243]">撤回申请</button>}</> : <><button disabled={busyIds.includes(String(proposal.id))} onClick={() => decide(String(proposal.id), false)} className="min-h-11 flex-1 rounded-xl border border-rose-200 bg-white px-5 py-2.5 text-sm font-medium text-rose-700 transition-colors hover:bg-rose-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500 sm:flex-none">驳回</button><button disabled={busyIds.includes(String(proposal.id))} onClick={() => decide(String(proposal.id), true)} className="min-h-11 flex-1 rounded-xl bg-[#1f5243] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#193f34] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1f5243] sm:flex-none">{busyIds.includes(String(proposal.id)) ? "处理中…" : "批准"}</button></>}</div>}</article>;
  }) : <Empty text="暂无审批记录。"/>}</div>;
}
export function Ledger({ recordStates = {}, entries, currency, members, accounts = [], fxSnapshots = [], totalEntries, page = 1, pageCount = 1, filters = emptyLedgerFilters, categories = [], projects = [], filterAction = "/app", householdId, proposals = [], readOnly = false, refresh = () => undefined, notify = () => undefined }: { recordStates?: Record<string, LedgerRecordState>; entries: Row[]; currency: string; members: Row[]; accounts?: Row[]; fxSnapshots?: FxRateSnapshot[]; totalEntries: number; page?: number; pageCount?: number; filters?: LedgerFilters; categories?: SpendingDimension[]; projects?: SpendingDimension[]; filterAction?: string; householdId?: string; proposals?: Row[]; readOnly?: boolean; refresh?: () => void; notify?: (message: string) => void }) {
  const [correction,setCorrection] = useState<CorrectionTarget>();
  const filtering = Object.values(filters).some(Boolean);
  return <div className="space-y-4">{correction && householdId && <CorrectionModal target={correction} householdId={householdId} close={() => setCorrection(undefined)} refresh={refresh} notify={notify} readOnly={readOnly}/>}<form action={filterAction} method="get" className="grid gap-3 rounded-2xl border bg-white p-4 md:grid-cols-6"><input type="hidden" name="tab" value="ledger"/><label className="text-sm">开始日期<input type="date" name="start" defaultValue={filters.start} className="mt-1 w-full rounded-xl border p-3"/></label><label className="text-sm">结束日期<input type="date" name="end" defaultValue={filters.end} className="mt-1 w-full rounded-xl border p-3"/></label><FilterSelect name="account" label="账户" value={filters.account} options={[["bank","共同银行"],["brokerage","共同券商"]]}/><FilterSelect name="currency" label="币种" value={filters.currency} options={[["USD","USD"],["CNY","CNY"],["HKD","HKD"]]}/><FilterSelect name="category" label="类别" value={filters.category} options={categories.map((item) => [item.name,`${item.name}${item.archivedAt ? "（已归档）" : ""}`])}/><FilterSelect name="project" label="事项" value={filters.project} options={projects.map((item) => [item.name,`${item.name}${item.archivedAt ? "（已归档）" : ""}`])}/><FilterSelect name="payment" label="支付方式" value={filters.payment} options={[["joint","共同账户"],["member","成员代付"]]}/><div className="flex items-end gap-2"><button className="rounded-xl bg-[#1f5243] px-4 py-3 text-sm font-bold text-white">筛选</button>{<Link href={`${filterAction}?tab=ledger`} className="rounded-xl border px-3 py-3 text-sm">{filtering ? "清除" : "全部流水"}</Link>}</div><p className="text-xs leading-relaxed text-gray-500 md:col-span-6">事项用于归集同一次旅行、装修等活动的消费，可跨类别。录入时直接输入名称，提交后自动加入共享选项；已归档事项仍可筛选历史记录。</p></form><div className="overflow-hidden rounded-2xl border bg-white">{totalEntries > 0 && <p className="border-b bg-[#f7f6f1] px-4 py-3 text-xs text-gray-600">第 {page} / {pageCount} 页 · 本页 {entries.length} 笔，共 {totalEntries} 笔；总览与投资持仓始终按全部已入账记录计算。</p>}{entries.length ? entries.map((entry) => {
    const state = recordStates[String(entry.id)] ?? { label: entry.status === "voided" ? "已作废" : "已入账", tone: entry.status === "voided" ? "gray" : "green", notices: [], refundIds: [] };
    const payer = memberName(members, entry.payer_member_id);
    const kind = entry.account_kind === "bank" || entry.account_kind === "brokerage" ? entry.account_kind : null;
    const exchange = entry.movement_type === "currency_exchange" || entry.entry_type === "currency_exchange";
    const transfer = entry.entry_type === "account_transfer" && !exchange;
    const source = entry.source_account_kind === "bank" || entry.source_account_kind === "brokerage" ? entry.source_account_kind : "bank";
    const destination = entry.destination_account_kind === "bank" || entry.destination_account_kind === "brokerage" ? entry.destination_account_kind : "brokerage";
    const lockedFx = fxSnapshots.find((snapshot) => snapshot.id === entry.fx_snapshot_id);
    const difference = exchange ? exchangeDifference(entry, currency as Currency, lockedFx) : null;
    return <div key={String(entry.id)} className="flex justify-between gap-3 border-b p-4"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><b>{String(entry.title)}</b><LedgerStateBadge label={state.label} tone={state.tone}/>{state.notices.map(label => <LedgerStateBadge key={label} label={label} tone={label === "已结清" ? "green" : label === "已作废" ? "gray" : "amber"}/>)}</div>{state.refundedMinor !== undefined && <p className="mt-2 text-xs text-gray-600">原金额 {money(Number(entry.amount_minor), String(entry.currency))} · 已退款 {money(state.refundedMinor, String(entry.currency))} · 净消费 {money(state.netMinor!, String(entry.currency))}</p>}{state.refundIds.length > 0 && <div className="mt-1 flex flex-wrap gap-3 text-xs text-[#1f5243]">{state.refundIds.map((id,index) => <Link key={id} className="underline" href={`${filterAction}?tab=ledger&entry=${id}`}>查看退款{state.refundIds.length > 1 ? ` ${index+1}` : "记录"}</Link>)}</div>}<p className="mt-1 text-xs text-gray-500">{String(entry.occurred_at)} · {exchange ? "实际换汇" : transfer ? "账户内部划转" : eventLabel(entry.entry_type as LedgerEventType)}{entry.category ? ` · ${String(entry.category)}` : ""}</p>{Boolean(entry.project_name) && <p className="mt-1 text-xs text-gray-500">事项：{String(entry.project_name)}</p>}{transfer || exchange ? <p className="mt-1 text-xs text-gray-500">{accountName(accounts, source)} → {accountName(accounts, destination)}</p> : kind && <p className="mt-1 text-xs text-gray-500">入账账户：{accountName(accounts, kind)}</p>}{exchange && <p className="mt-1 text-xs text-gray-500">实际扣除 {money(Number(entry.amount_minor), String(entry.currency))} · 实际到账 {money(Number(entry.destination_amount_minor), String(entry.destination_currency))}</p>}{difference !== null && <p className="mt-1 text-xs text-gray-500">换汇净额折算差额（可能包含价差及费用）：{money(difference, currency)}</p>}{payer && <p className="mt-1 text-xs text-gray-500">实际付款人：{payer}</p>}{entry.status === "voided" ? <p className="mt-2 text-xs text-red-700">已作废 · 历史统计已重算 · <Link href={`${filterAction}?tab=approvals#approval-${String(entry.void_proposal_id)}`}>作废审批 {String(entry.void_proposal_id??'').slice(0,8)}</Link></p> : householdId && <div className="mt-2 flex gap-3">{["expense","reimbursement"].includes(String(entry.entry_type)) && <button className="text-sm underline" onClick={() => setCorrection({mode:"refund",entry})}>关联退款</button>}<button className="text-sm underline" onClick={() => {const kind=transfer||exchange?"transfer":"entry",pid=proposals.find(p=>p.id===entry.proposal_id),group=entry.proposal_id?entries.filter(e=>e.proposal_id===entry.proposal_id):[entry];setCorrection({mode:"void",entry,kind,originalPayload:pid?.payload as Row|undefined,previewPlan:readOnly?{entries:group.filter(e=>!["account_transfer","currency_exchange"].includes(String(e.entry_type))),transfers:group.filter(e=>["account_transfer","currency_exchange"].includes(String(e.entry_type))),valuations:[]}:undefined});}}>申请作废</button></div>}{Boolean(entry.refund_source_entry_id)&&<p className="mt-1 text-xs"><Link className="underline" href={`${filterAction}?tab=ledger&entry=${String(entry.refund_source_entry_id)}`}>查看原消费 {String(entry.refund_source_entry_id).slice(0,8)}</Link> · {entry.refund_recipient==="member"?"退款给垫付成员，共同现金不变":"退款回共同账户"}</p>}{Boolean(entry.recovery_claim_id)&&<p className="mt-1 text-xs">返还关联原单 {String(entry.recovery_claim_id)}；不增加贡献</p>}</div><b>{exchange ? `${String(entry.currency)} → ${String(entry.destination_currency)}` : money(Number(entry.amount_minor), String(entry.currency || currency))}</b></div>;
  }) : <Empty text={filtering ? "没有符合筛选条件的流水。" : "暂无已入账流水。"}/>} {pageCount > 1 && <nav aria-label="流水分页" className="flex items-center justify-between border-t bg-[#f7f6f1] p-3"><PaginationLink page={page - 1} disabled={page <= 1} filters={filters} action={filterAction}>上一页</PaginationLink><span className="text-xs text-gray-600">第 {page} / {pageCount} 页</span><PaginationLink page={page + 1} disabled={page >= pageCount} filters={filters} action={filterAction}>下一页</PaginationLink></nav>}</div></div>;
}
function LedgerStateBadge({ label, tone }: { label: string; tone: string }) {
  const colors = tone === "gray" ? "bg-gray-100 text-gray-600 ring-gray-200" : tone === "red" ? "bg-red-50 text-red-700 ring-red-200" : tone === "amber" ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-emerald-50 text-emerald-800 ring-emerald-200";
  return <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${colors}`}><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current"/>{label}</span>;
}
function FilterSelect({ name, label, value, options, onChange }: { name: string; label: string; value: string; options: string[][]; onChange?: (value: string) => void }) {
  return <label className="text-sm"><span className="mb-1 block text-gray-600">{label}</span><select name={name} {...(onChange ? { value, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.target.value) } : { defaultValue: value })} className="w-full rounded-xl border p-3"><option value="">全部</option>{options.map(([optionValue,optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></label>;
}
function PaginationLink({ page, disabled, filters, action, children }: { page: number; disabled: boolean; filters: LedgerFilters; action: string; children: string }) {
  const className = `rounded-lg border px-3 py-2 text-sm font-bold ${disabled ? "cursor-not-allowed bg-gray-100 text-gray-400" : "bg-white text-[#1f5243]"}`;
  const query = new URLSearchParams({ tab: "ledger", ledgerPage: String(page) });
  Object.entries(filters).forEach(([key,value]) => { if (value) query.set(key,value); });
  return disabled ? <span aria-disabled="true" className={className}>{children}</span> : <Link className={className} href={`${action}?${query.toString()}`} prefetch={false}>{children}</Link>;
}

export function InvestmentList(props: React.ComponentProps<typeof InvestmentCenter>) { return <InvestmentCenter {...props}/>; }

export function RecordModal(props: React.ComponentProps<typeof GeneralRecordModal> & { investmentEntries?: Row[]; transfers?: CashTransfer[]; accountBalances?: AccountBalances }) {
 if (props.mode === "investment") {
   const investment = props.investments.find(i => i.id === props.initialInvestmentId);
   return investment ? <InvestmentActionModal investment={investment} householdId={props.household.id} close={props.close} refresh={props.refresh} notify={props.setMessage} readOnly={props.readOnly} entries={props.investmentEntries} transfers={props.transfers} balances={props.accountBalances}/> : null;
 }
 return <GeneralRecordModal {...props}/>;
}

function GeneralRecordModal({ close, household, investments, members, userId, spendingCategories = [], spendingProjects = [], refresh, setMessage, readOnly = false, mode = "general", initialInvestmentId }: { close: () => void; household: Props["household"]; investments: Row[]; members: Row[]; userId: string; spendingCategories?: SpendingDimension[]; spendingProjects?: SpendingDimension[]; refresh: () => void; setMessage: (value: string) => void; readOnly?: boolean; mode?: "general" | "investment"; initialInvestmentId?: string }) {
  const timeZone = useLedgerTimeZone();
  const [occurredAt,setOccurredAt] = useState(() => ledgerToday(timeZone));
  const [type, setType] = useState(mode === "investment" ? "investment_buy" : "expense");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [localCategories, setLocalCategories] = useState(spendingCategories);
  const localProjects = spendingProjects;
  const projectSuggestionsId = useId();
  const [categoryId, setCategoryId] = useState(activeSpendingDimensions(spendingCategories)[0]?.id ?? "");
  const [projectName, setProjectName] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [addingCategory, setAddingCategory] = useState(false);
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
  const [idempotencyKey] = useState(() => createUUID());
  const [submitting, setSubmitting] = useState(false);
  const selectedInvestment = investments.find((item) => item.id === investmentId);
  const activeCategories = activeSpendingDimensions(localCategories);
  const activeProjects = activeSpendingDimensions(localProjects);
  const selectedCategory = activeCategories.find((item) => item.id === categoryId);
  const selectedProject = activeProjects.find((item) => normalizedDimensionName(item.name) === normalizedDimensionName(projectName));

  async function createCategory() {
    const name = newCategory.trim();
    if (!name || name.length > 30) return setMessage("分类名称需为 1—30 个字符。");
    if (["代付", "报销", "成员代付", "报销付款"].includes(name)) return setMessage("代付和报销是事件类型，不能作为消费分类。");
    if (localCategories.some(item => normalizedDimensionName(item.name) === normalizedDimensionName(name))) return setMessage("分类已存在。");
    let item = { id: createUUID() as string, name, isSystem: false };
    if (!readOnly) {
      const response = await fetch("/api/spending-categories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ householdId: household.id, name }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return setMessage(body.error || "新增失败");
      item = { id: String(body.id), name: String(body.name), isSystem: false };
    }
    setLocalCategories(items => [...items,item]); setCategoryId(item.id); setNewCategory(""); setAddingCategory(false);
    if (readOnly) setMessage("已在只读预览中临时新增分类。"); else refresh();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      if (mode === "investment" && !selectedInvestment) throw new Error("投资标的已不存在，请刷新页面");
      if (["expense", "reimbursement"].includes(type) && localProjects.some(item => item.archivedAt && normalizedDimensionName(item.name) === normalizedDimensionName(projectName))) throw new Error("该事项已归档，请在账本设置中恢复后使用。");
      if (occurredAt > ledgerToday(timeZone)) throw new Error("不能提交未来发生的资金记录。");
      const payload = {
        householdId: household.id,
        type,
        amountMinor: type === "investment_valuation" ? 0 : parseFixedDecimal(amount, 2, { allowZero: type === "investment_sell", label: type === "investment_buy" ? "实际总扣款" : type === "investment_sell" ? "实际净到账" : "金额" }),
        currency: mode === "investment" ? recordCurrency(type, household.reportingCurrency as Currency, selectedInvestment ? { currency: selectedInvestment.currency as Currency } : undefined) : currency,
        occurredAt,
        title,
        category: ["expense", "reimbursement"].includes(type) ? selectedCategory?.name : undefined,
        categoryId: ["expense", "reimbursement"].includes(type) ? selectedCategory?.id : undefined,
        project: ["expense", "reimbursement"].includes(type) ? selectedProject?.name ?? (projectName.trim().replace(/\s+/g, " ") || undefined) : undefined,
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
  return <Modal close={close} title={mode === "investment" ? `${String(selectedInvestment?.name ?? "投资标的")} · 投资操作` : "提交账户记录"}><form onSubmit={submit} className="space-y-3"><select disabled={submitting} value={type} onChange={(event) => setType(event.target.value)}>{mode === "investment" ? <><option value="investment_buy">投资买入</option><option value="investment_sell">投资卖出</option><option value="dividend">投资分红</option><option value="investment_valuation">新增投资估值</option></> : <><option value="deposit">共同存入</option><option value="expense">共同账户消费</option><option value="reimbursement">成员代付共同消费</option><option value="account_transfer">银行 / 券商内部划转</option><option value="currency_exchange">实际换汇</option></>}</select>{mode === "investment" && <p className="rounded-xl bg-[#f3f5ef] px-3 py-2 text-sm text-[#385248]">当前标的：<b>{String(selectedInvestment?.name ?? "未知标的")}</b><span className="mt-1 block text-xs">结算账户：共同券商 · {String(selectedInvestment?.currency ?? household.reportingCurrency)}</span></p>}{mode === "general" && <label className="block text-sm"><span className="mb-1 block text-gray-600">{exchange ? "扣除币种" : "币种"}</span><select disabled={submitting} value={currency} onChange={(event) => { const next = event.target.value as Currency; setCurrency(next); if (next === destinationCurrency) setDestinationCurrency(next === "USD" ? "CNY" : "USD"); }}><option>USD</option><option>CNY</option><option>HKD</option></select></label>}{cashAccountEntry && <label className="block text-sm"><span className="mb-1 block text-gray-600">入账账户</span><select disabled={submitting} value={accountKind} onChange={(event) => setAccountKind(event.target.value as CashAccountKind)}><option value="bank">共同银行</option><option value="brokerage">共同券商</option></select></label>}{transfer && <label className="block text-sm"><span className="mb-1 block text-gray-600">划转方向</span><select disabled={submitting} value={sourceAccountKind} onChange={(event) => setSourceAccountKind(event.target.value as CashAccountKind)}><option value="bank">共同银行 → 共同券商</option><option value="brokerage">共同券商 → 共同银行</option></select></label>}{exchange && <div className="grid grid-cols-2 gap-3"><label className="block text-sm"><span className="mb-1 block text-gray-600">扣除账户</span><select disabled={submitting} value={sourceAccountKind} onChange={(event) => setSourceAccountKind(event.target.value as CashAccountKind)}><option value="bank">共同银行</option><option value="brokerage">共同券商</option></select></label><label className="block text-sm"><span className="mb-1 block text-gray-600">到账账户</span><select disabled={submitting} value={destinationAccountKind} onChange={(event) => setDestinationAccountKind(event.target.value as CashAccountKind)}><option value="bank">共同银行</option><option value="brokerage">共同券商</option></select></label></div>}<input disabled={submitting} required value={title} onChange={(event) => setTitle(event.target.value)} placeholder={transfer ? "划转说明" : exchange ? "换汇说明" : "说明"}/>{["deposit", "reimbursement"].includes(type) && <PayerSelect members={members} userId={userId} value={payerMemberId} disabled={submitting} onChange={setPayerMemberId}/>} {trade && <><input disabled={submitting} required value={quantity} onChange={(event) => setQuantity(event.target.value)} type="number" min=".001" step=".001" placeholder="份额"/><input disabled={submitting} required value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min={type === "investment_sell" ? "0" : ".01"} step=".01" placeholder={type === "investment_buy" ? "实际总扣款（含费用）" : "实际净到账（含费用影响）"}/><input disabled={submitting} value={price} onChange={(event) => setPrice(event.target.value)} type="number" min=".0001" step=".0001" placeholder="参考成交单价（可选）"/><p className="text-xs text-gray-500">实际金额是入账依据；参考单价只作备注，不会重新计算扣款或到账。</p></>}{type === "investment_valuation" ? <input disabled={submitting} required value={price} onChange={(event) => setPrice(event.target.value)} type="number" min=".0001" step=".0001" placeholder="单位估值"/> : !trade && <input disabled={submitting} required value={amount} onChange={(event) => setAmount(event.target.value)} type="number" min=".01" step=".01" placeholder={exchange ? "实际扣除金额" : "金额"}/>} {exchange && <><label className="block text-sm"><span className="mb-1 block text-gray-600">到账币种</span><select disabled={submitting} value={destinationCurrency} onChange={(event) => setDestinationCurrency(event.target.value as Currency)}>{(["USD", "CNY", "HKD"] as Currency[]).filter((code) => code !== currency).map((code) => <option key={code}>{code}</option>)}</select></label><input disabled={submitting} required value={destinationAmount} onChange={(event) => setDestinationAmount(event.target.value)} type="number" min=".01" step=".01" placeholder="实际到账金额"/><p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">两端实际金额直接入账；系统不会按参考汇率重算，也不会另行推断手续费。</p></>}{["expense", "reimbursement"].includes(type) && <><label className="block text-sm"><span className="mb-1 block text-gray-600">消费分类</span><select disabled={submitting} required value={categoryId} onChange={(event) => event.target.value === "__new__" ? setAddingCategory(true) : setCategoryId(event.target.value)}><option value="" disabled>请选择分类</option>{activeCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}<option value="__new__">＋ 新增分类</option></select></label>{addingCategory && <div className="flex gap-2"><input value={newCategory} maxLength={30} onChange={(event) => setNewCategory(event.target.value)} placeholder="新分类名称（1—30字）"/><button type="button" onClick={() => createCategory()} className="shrink-0 rounded-xl border px-3 text-sm font-bold">添加</button></div>}<label className="block text-sm"><span className="mb-1 block text-gray-600">具体事项（可选）</span><input disabled={submitting} aria-label="具体事项（可选）" list={projectSuggestionsId} value={projectName} maxLength={60} onChange={event => setProjectName(event.target.value)} placeholder="选择已有事项，或直接输入新名称" aria-describedby={`${projectSuggestionsId}-hint`}/><datalist id={projectSuggestionsId}>{activeProjects.map(item => <option key={item.id} value={item.name}/>)}</datalist><span id={`${projectSuggestionsId}-hint`} className="mt-1 block text-xs leading-relaxed text-gray-500">如一次旅行、装修，可归集不同类别的消费。新名称随记录提交自动保存，下次可直接复用；不需要时留空。</span></label></>}{transfer && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">同币种划转不会改变共同现金总额，也不会自动换汇或补足任一账户。</p>}<label className="block text-sm">发生日期<input disabled={submitting} type="date" required max={ledgerToday(timeZone)} value={occurredAt} onChange={e => setOccurredAt(e.target.value)}/><span className="mt-1 block text-xs text-gray-500">按账本时区 {timeZone}，可补录已发生的记录。</span></label><button disabled={submitting} className="w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-60">{submitting ? "正在提交…" : "提交给对方审批"}</button></form></Modal>;
}

export function LedgerSettings({ close, household, categories, projects, refresh, setMessage, readOnly = false }: { close: () => void; household: Props["household"]; categories: SpendingDimension[]; projects: SpendingDimension[]; refresh: () => void; setMessage: (value: string) => void; readOnly?: boolean }) {
  const [zone,setZone] = useState(household.timeZone ?? "UTC");
  const [zoneBusy,setZoneBusy] = useState(false);
  async function saveZone() {
    if (!isLedgerTimeZone(zone)) return setMessage("请输入有效 IANA 时区，如 Asia/Shanghai。");
    if (readOnly) return setMessage("只读预览不会修改账本时区。");
    setZoneBusy(true);
    try { const r = await fetch("/api/households", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ householdId: household.id, timeZone: zone }) }); const body = await r.json(); if (!r.ok) throw new Error(body.error || "时区保存失败"); setMessage("账本时区已确认，历史发生日期保持原样。"); refresh(); } catch (e) { setMessage(e instanceof Error ? e.message : "保存失败"); } finally { setZoneBusy(false); }
  }
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
    if (readOnly) item = { id: createUUID(), name, isSystem: false };
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

  return <Modal close={close} title="账本设置 · 用途"><div className="mb-4 rounded-xl border bg-[#f7f6f1] p-3"><label className="block text-sm">账本时区<input value={zone} onChange={e => setZone(e.target.value)} placeholder="Asia/Shanghai" className="mt-1 w-full rounded-xl border p-2"/></label><p className="mt-2 text-xs text-gray-600">双方共用；已有记录的已确认时区不能直接修改。旧账本首次确认保留历史发生日。</p><button disabled={zoneBusy} type="button" onClick={saveZone} className="mt-2 rounded-lg border px-3 py-2 text-sm">{zoneBusy ? "保存中…" : "确认时区"}</button></div><div className="space-y-6"><section><b className="text-sm">消费分类</b><p className="mt-1 text-xs text-gray-500">双方共享；代付和报销属于事件类型，不能作为分类。</p><div className="mt-3 flex gap-2"><input value={categoryName} maxLength={30} onChange={(event) => setCategoryName(event.target.value)} placeholder="新增分类（1—30字）"/><button onClick={() => create("category")} className="shrink-0 rounded-xl border px-3 text-sm font-bold">新增</button></div><DimensionList items={localCategories} toggle={(item) => toggle("category",item)}/></section><section><b className="text-sm">具体事项</b><p className="mt-1 text-xs text-gray-500">同一事项可以聚合餐饮、交通等不同类别，例如“2026 香港旅行”。</p><div className="mt-3 flex gap-2"><input value={projectName} maxLength={60} onChange={(event) => setProjectName(event.target.value)} placeholder="新增事项"/><button onClick={() => create("project")} className="shrink-0 rounded-xl border px-3 text-sm font-bold">新增</button></div><DimensionList items={localProjects} toggle={(item) => toggle("project",item)} empty="尚无具体事项。"/></section></div></Modal>;
}

function DimensionList({ items, toggle, empty = "暂无分类。" }: { items: SpendingDimension[]; toggle: (item: SpendingDimension) => void; empty?: string }) {
  return items.length ? <div className="mt-3 divide-y rounded-xl border">{items.map((item) => <div key={item.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm"><span className={item.archivedAt ? "text-gray-400 line-through" : ""}>{item.name}{item.isSystem ? " · 内置" : ""}</span><button onClick={() => toggle(item)} className="rounded-lg border px-2 py-1 text-xs">{item.archivedAt ? "恢复" : "归档"}</button></div>)}</div> : <p className="mt-3 text-sm text-gray-500">{empty}</p>;
}

export function FxRateModal({ close, household, current, refresh, setMessage, readOnly = false }: { close: () => void; household: Props["household"]; current?: FxRateSnapshotView; refresh: () => void; setMessage: (value: string) => void; readOnly?: boolean }) {
  const timeZone = useLedgerTimeZone();
  const localNow = () => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
  const [usdToCny, setUsdToCny] = useState(current ? String(current.usdToCny) : "");
  const [usdToHkd, setUsdToHkd] = useState(current ? String(current.usdToHkd) : "");
  const [sourceNote, setSourceNote] = useState(current?.sourceNote ?? "");
  const [effectiveAt, setEffectiveAt] = useState(localNow);
  const [idempotencyKey] = useState(() => createUUID());
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const effectiveIso = new Date(effectiveAt).toISOString();
      const payload = { householdId: household.id, type: "fx_rate_update", amountMinor: 0, currency: "USD", occurredAt: ledgerToday(timeZone,new Date(effectiveIso)), title: "手动汇率更新", effectiveAt: effectiveIso, usdToCny: usdToCny.trim(), usdToHkd: usdToHkd.trim(), sourceNote: sourceNote.trim(), idempotencyKey };
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

  return <Modal close={close} title="提交手动汇率"><form onSubmit={submit} className="space-y-3"><p className="rounded-xl bg-[#f3f5ef] px-3 py-2 text-sm text-[#385248]">每次提交都保存 USD/CNY 与 USD/HKD 的完整快照。未改动的币种请保留当前值；另一位成员批准后才生效。</p><label className="block text-sm"><span className="mb-1 block text-gray-600">1 USD = 多少 CNY</span><input disabled={submitting} required value={usdToCny} onChange={(event) => setUsdToCny(event.target.value)} inputMode="decimal" placeholder="例如 7.2"/></label><label className="block text-sm"><span className="mb-1 block text-gray-600">1 USD = 多少 HKD</span><input disabled={submitting} required value={usdToHkd} onChange={(event) => setUsdToHkd(event.target.value)} inputMode="decimal" placeholder="例如 7.8"/></label><label className="block text-sm"><span className="mb-1 block text-gray-600">生效时间（当前设备本地时间）</span><input disabled={submitting} required type="datetime-local" value={effectiveAt} max={localNow()} onChange={(event) => setEffectiveAt(event.target.value)}/></label><label className="block text-sm"><span className="mb-1 block text-gray-600">人工来源或说明</span><input disabled={submitting} required value={sourceNote} maxLength={240} onChange={(event) => setSourceNote(event.target.value)} placeholder="例如：银行 App 参考价，人工录入"/></label><p className="text-xs text-gray-500">这是人工维护的参考汇率；系统不会获取实时市场行情。历史记录继续引用原批准快照。</p><button disabled={submitting} className="w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-60">{submitting ? "正在提交…" : "提交给对方审批"}</button></form></Modal>;
}
function InvestmentCreate({ close, household, refresh, setMessage }: { close: () => void; household: Props["household"]; refresh: () => void; setMessage: (value: string) => void }) { return <InvestmentMetadataModal householdId={household.id} close={close} refresh={refresh} notify={setMessage}/>; }
const subscribeToOrigin = () => () => {};
function InviteModal({ close, householdId, setMessage }: { close: () => void; householdId: string; setMessage: (value: string) => void }) {
  const [email,setEmail]=useState(""),[link,setLink]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const lock=useRef(false),linkField=useRef<HTMLTextAreaElement>(null);
  const [copyNotice,setCopyNotice]=useState(""),[existingInvitation,setExistingInvitation]=useState(false),[replaced,setReplaced]=useState(false);
  const origin=useSyncExternalStore(subscribeToOrigin,()=>window.location.origin,()=>"");
  const localOnly=Boolean(origin && ["0.0.0.0","127.0.0.1","localhost","[::1]"].includes(new URL(origin).hostname));
  async function create(replaceExisting = false) {
    if(lock.current || link)return;lock.current=true;setBusy(true);setError("");
    try {
      const response=await fetch(`/api/households/${householdId}/invitations`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,replaceExisting})});
      const body=await response.json().catch(()=>({}));
      if(!response.ok) {
        if(body.code === "active_invitation_exists") {setExistingInvitation(true);return;}
        throw new Error(body.error||"创建邀请失败，请重试");
      }
      setExistingInvitation(false);setReplaced(replaceExisting);
      setLink(`${window.location.origin}/invite/${body.token}`);
    } catch(error) {setError(error instanceof Error ? error.message : "网络连接失败，请重试");}
    finally {lock.current=false;setBusy(false);}
  }
  async function copy() {
    setCopyNotice("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(link);setMessage("邀请链接已复制");
    } catch {
      linkField.current?.focus();linkField.current?.select();
      setCopyNotice("链接已选中，请按 ⌘C（Mac）或 Ctrl+C（Windows）复制。");
    }
  }
  return <Modal close={close} title="邀请伴侣">{localOnly && <p role="status" className="mb-4 rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-900">当前为本机测试，此链接只能在这台电脑的独立浏览器中使用。跨设备邀请请从 HTTPS 测试站打开账本后生成链接。</p>}<form onSubmit={event=>{event.preventDefault();void create();}} className="space-y-3"><p className="text-sm leading-6 text-gray-500">使用对方注册账号的邮箱。链接仅可被该邮箱账号接受，有效期 7 天；生成后请自行分享给对方。</p><label className="block text-sm">伴侣邮箱<input required type="email" autoComplete="email" disabled={busy || Boolean(link)} value={email} onChange={event=>{setEmail(event.target.value);setExistingInvitation(false);setError("");}} className="mt-1 w-full rounded-xl border p-3"/></label><button disabled={busy || Boolean(link) || existingInvitation} className="w-full rounded-xl bg-[#1f5243] py-3 font-bold text-white disabled:opacity-50">{busy ? "正在生成…" : link ? "邀请已生成" : existingInvitation ? "已有有效邀请" : "生成邀请链接"}</button></form>{existingInvitation ? <div className="mt-4 rounded-xl bg-amber-50 p-3"><p role="status" className="text-sm leading-6 text-amber-900">该邮箱已有有效邀请。若原链接丢失或是本地地址，可换发当前站点的新链接；旧链接将立即失效，对方需要使用新链接。</p><button type="button" disabled={busy} onClick={()=>void create(true)} className="mt-3 w-full rounded-xl border border-[#1f5243] bg-white py-3 font-bold text-[#1f5243] disabled:opacity-50">换发邀请链接（旧链接失效）</button></div> : null}{error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}{link && <div className="mt-4 rounded-xl bg-[#f3f5ef] p-3">{replaced && <p role="status" className="mb-3 text-sm text-[#1f5243]">新邀请已生成，旧链接已失效。请分享下方新链接。</p>}<label className="block text-xs">邀请链接<textarea ref={linkField} readOnly value={link} rows={3} onFocus={event=>event.currentTarget.select()} className="mt-2 w-full resize-none rounded-lg border bg-white p-2 text-xs"/></label>{copyNotice && <p role="status" className="mt-2 text-xs leading-5 text-gray-600">{copyNotice}</p>}<button onClick={copy} className="mt-3 rounded-lg border px-3 py-2 text-sm"><Copy size={15} className="mr-1 inline"/>复制链接</button></div>}</Modal>;
}
function Card({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl border bg-white p-4"><p className="text-sm text-gray-500">{label}</p><b className="mt-3 block text-xl">{value}</b></div>; }
function Empty({ text }: { text: string }) { return <p className="rounded-2xl border bg-white p-8 text-center text-sm text-gray-500">{text}</p>; }
function Modal({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) { return <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"><div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6"><div className="mb-4 flex justify-between"><b>{title}</b><button onClick={close}>×</button></div><div className="[&_input]:w-full [&_input]:rounded-xl [&_input]:border [&_input]:p-3 [&_select]:w-full [&_select]:rounded-xl [&_select]:border [&_select]:p-3">{children}</div></div></div>; }
