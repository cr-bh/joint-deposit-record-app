"use client";
import { createUUID } from "@/lib/uuid";
import { useLedgerTimeZone } from "./ledger-clock";
import { ledgerToday, ledgerTimestamp } from "@/lib/domain/ledger-time";

import CorrectionModal, {type CorrectionTarget} from "./correction-modal";
import { useState } from "react";
import Link from "next/link";
import type { Currency } from "@/lib/domain/balance-calculations";
import { claimStateLabel, type ReimbursementClaimView } from "@/lib/domain/reimbursement-claims";
import { paymentStatusLabel, type SettlementBatchView } from "@/lib/domain/settlement-batches";
import { calculateSettlement } from "@/lib/domain/settlement-calculations";
import type { FxRateSnapshot } from "@/lib/domain/fx-rates";
import { parseFixedDecimal } from "@/lib/domain/fixed-decimal";

type Row = Record<string, unknown>;
const currencies: Currency[] = ["USD", "CNY", "HKD"];
const money = (minor: number, currency: Currency) => `${currency} ${new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100)}`;
const pending = (status: string) => ["pending_approval", "overdue_pending"].includes(status);
export function reimbursementMemberName(members: Row[], id: string) {
  const member = members.find(item => item.user_id === id);
  const profile = Array.isArray(member?.profiles) ? member.profiles[0] : member?.profiles;
  return profile && typeof profile === "object" ? String((profile as Row).display_name) : `成员 ${id.slice(0, 8)}`;
}
function currencyTotals(items: { currency: Currency; amount: number }[]) {
  return currencies.map(code => [code, items.filter(item => item.currency === code).reduce((sum, item) => sum + item.amount, 0)] as const)
    .filter(([, amount]) => amount !== 0).map(([code, amount]) => money(amount, code)).join(" · ") || "0";
}
type Props = {
  householdId: string; userId: string; members: Row[]; claims: ReimbursementClaimView[];
  batches: SettlementBatchView[]; proposals: Row[]; fxSnapshot?: FxRateSnapshot; fxSnapshots?: FxRateSnapshot[];
  archived?: boolean; readOnly?: boolean; refresh: () => void; notify: (message: string) => void; initialBatchId?: string;
  unreviewedPaymentCount?: number;
};

export default function ReimbursementCenter({ householdId, userId, members, claims, batches, proposals, fxSnapshot, fxSnapshots = [], archived = false, readOnly, refresh, notify, initialBatchId, unreviewedPaymentCount = 0 }: Props) {
  const timeZone = useLedgerTimeZone();
  const [correction,setCorrection]=useState<CorrectionTarget>();
  const [page, setPage] = useState(initialBatchId ? "payments" : "claims");
  const [member, setMember] = useState(""); const [currency, setCurrency] = useState("");
  const [category, setCategory] = useState(""); const [project, setProject] = useState(""); const [state, setState] = useState("");
  const [selectedClaim, setSelectedClaim] = useState<string>(); const [selectedBatch, setSelectedBatch] = useState(initialBatchId);
  const [draft, setDraft] = useState<{ payee: string; claimId?: string }>(); const [busy, setBusy] = useState(false);
  const categories = [...new Set(claims.flatMap(claim => claim.category ? [claim.category] : []))];
  const projects = [...new Set(claims.flatMap(claim => claim.project ? [claim.project] : []))];
  const filtered = claims.filter(claim => (!member || claim.claimantId === member) && (!currency || claim.currency === currency) && (!category || claim.category === category) && (!project || claim.project === project) && (!state || claim.state === state) && (!selectedClaim || claim.id === selectedClaim));
  async function act(batch: SettlementBatchView, action: "approve" | "reject" | "withdraw") {
    if (readOnly) return notify("本地只读预览不会写入数据。");
    setBusy(true);
    try {
      const response = await fetch(`/api/proposals/${batch.proposalId}/${action === "withdraw" ? "withdraw" : "decision"}`, {
        method: "POST", headers: { "content-type": "application/json" }, ...(action === "withdraw" ? {} : { body: JSON.stringify({ approve: action === "approve" }) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "操作失败");
      refresh(); notify(action === "approve" ? "打款已入账，原单已核销。" : "操作成功，预留额度已释放。");
    } catch (error) { notify(error instanceof Error ? error.message : "操作失败，请重试"); }
    finally { setBusy(false); }
  }
  const openBatch = (id: string) => { setPage("payments"); setSelectedBatch(id); setSelectedClaim(undefined); };
  const openClaim = (id: string) => { setPage("claims"); setSelectedClaim(id); setSelectedBatch(undefined); setMember(""); setCurrency(""); setCategory(""); setProject(""); setState(""); };
  return <div className="space-y-5">{correction&&<CorrectionModal target={correction} householdId={householdId} snapshot={fxSnapshot} close={()=>setCorrection(undefined)} refresh={refresh} notify={notify} readOnly={readOnly}/>}
    {unreviewedPaymentCount > 0 && <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">有 {unreviewedPaymentCount} 笔历史打款缺少完整原单关联，需迁移核对；下方已打款卡片仅汇总可追溯批次。账户现金保留历史流水，不猜测核销。</p>}
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-bold">代付与报销</h2><p className="mt-1 text-sm text-gray-600">每次打款关联具体原单；待审批只预留额度，批准后扣现金并核销。</p></div><button disabled={archived} className="rounded-xl bg-[#1f5243] px-4 py-2 text-sm font-bold text-white disabled:opacity-40" onClick={() => setDraft({ payee: member || String(members[0]?.user_id ?? "") })}>发起报销打款</button></div>
    <section className="grid gap-3 md:grid-cols-2">{members.map(item => {
      const id = String(item.user_id), own = claims.filter(claim => claim.claimantId === id && claim.state !== "voided");
      const awaiting = proposals.filter(proposal => pending(String(proposal.status)) && (proposal.payload as Row)?.type === "reimbursement" && (proposal.payload as Row).payerMemberId === id);
      const paidBatches = batches.filter(batch => batch.claimantId === id && batch.status === "approved");
      return <article key={id} className="rounded-2xl border bg-white p-5"><b>{reimbursementMemberName(members, id)}</b><dl className="mt-3 space-y-2 text-sm">
        <div><dt className="text-gray-500">待审代付（尚未形成债权）</dt><dd>{currencyTotals(awaiting.map(proposal => ({ currency: (proposal.payload as Row).currency as Currency, amount: Number((proposal.payload as Row).amountMinor) })))}</dd></div>
        <div><dt className="text-gray-500">未结清原币</dt><dd>{currencyTotals(own.map(claim => ({ currency: claim.currency, amount: claim.remainingMinor })))}</dd></div>
        <div><dt className="text-gray-500">其中待审批打款预留</dt><dd>{currencyTotals(own.map(claim => ({ currency: claim.currency, amount: claim.reservedMinor ?? 0 })))}</dd></div>
        <div><dt className="text-gray-500">成员应返共同款（不抵销其他原单）</dt><dd>{currencyTotals(own.map(claim=>({currency:claim.currency,amount:claim.recoveryMinor??0})))}</dd></div><div><dt className="text-gray-500">已打款（实际支付币种）</dt><dd>{currencyTotals(paidBatches.map(batch => ({ currency: batch.currency, amount: batch.amountMinor })))}</dd></div>
      </dl><p className="mt-4 text-xs text-gray-500">核销进度按原币分组 · 绿色已核销 / 灰色未结清</p>{currencies.map(code => {
        const rows = own.filter(claim => claim.currency === code), settled = rows.reduce((sum, claim) => sum + Math.min(claim.settledMinor,claim.effectiveMinor??claim.originalMinor), 0), outstanding = rows.reduce((sum, claim) => sum + claim.remainingMinor, 0), total = settled + outstanding;
        return total > 0 && <div key={code} className="mt-2"><div className="flex justify-between gap-2 text-xs"><span>{code} · 已核销 {money(settled, code)}</span><span>未结清 {money(outstanding, code)}</span></div><div className="mt-1 flex h-3 overflow-hidden rounded-full bg-gray-200" role="img" aria-label={`${code} 已核销 ${settled / 100}，未结清 ${outstanding / 100}`}><span style={{ width: `${settled / total * 100}%` }} className="bg-[#1f5243]"/></div></div>;
      })}</article>;
    })}</section>
    <nav className="flex gap-2" aria-label="代付与报销子页面">{[["claims", "代付明细"], ["payments", "打款明细"]].map(([value, label]) => <button key={value} onClick={() => { setPage(value); setSelectedClaim(undefined); setSelectedBatch(undefined); }} className={`rounded-xl border px-4 py-2 text-sm font-bold ${page === value ? "bg-[#1f5243] text-white" : "bg-white"}`}>{label}</button>)}</nav>
    {page === "claims" ? <>
      <section className="grid gap-3 rounded-2xl border bg-white p-4 md:grid-cols-5">
        <Select label="实际垫付人" value={member} change={setMember} options={members.map(item => [String(item.user_id), reimbursementMemberName(members, String(item.user_id))])}/>
        <Select label="币种" value={currency} change={setCurrency} options={currencies.map(code => [code, code])}/>
        <Select label="类别" value={category} change={setCategory} options={categories.map(value => [value, value])}/>
        <Select label="事项" value={project} change={setProject} options={projects.map(value => [value, value])}/>
        <Select label="状态" value={state} change={setState} options={Object.entries(claimStateLabel)}/>
      </section>
      {selectedClaim && <button className="text-sm underline" onClick={() => setSelectedClaim(undefined)}>查看全部原单</button>}
      {proposals.filter(proposal => pending(String(proposal.status)) && (proposal.payload as Row)?.type === "reimbursement").map(proposal => { const p = proposal.payload as Row; return <article key={String(proposal.id)} className="rounded-2xl border border-amber-200 bg-amber-50 p-4"><b>{String(p.title)}</b><p className="mt-1 text-sm">{money(Number(p.amountMinor), p.currency as Currency)} · {String(p.category)} · {reimbursementMemberName(members, String(p.payerMemberId))}</p><p className="mt-2 text-xs">待审代付 · 批准前不计入债权</p></article>; })}
      <div className="space-y-3">{filtered.map(claim => {
        const related = batches.filter(batch => batch.allocations.some(allocation => allocation.claimId === claim.id));
        return <article key={claim.id} className="rounded-2xl border bg-white p-5"><div className="flex flex-wrap justify-between gap-3"><div><b>{claim.title}</b><p className="mt-1 text-sm text-gray-600">{claim.occurredAt} · {claim.category ?? "其他"}{claim.project ? ` · ${claim.project}` : ""} · {reimbursementMemberName(members, claim.claimantId)}</p></div><span className="text-xs">{claimStateLabel[claim.state]}</span></div><div className="mt-4 flex flex-wrap gap-4 text-sm"><span>原额 {money(claim.originalMinor, claim.currency)}</span><span>已核销 {money(claim.settledMinor, claim.currency)}</span><span>退给成员 {money(claim.refundedMemberMinor??0,claim.currency)}</span><span>有效原额 {money(claim.effectiveMinor??claim.originalMinor,claim.currency)}</span><span>应返总额 {money((claim.recoveryMinor??0)+(claim.returnedMinor??0),claim.currency)}</span><b>尚需返还 {money(claim.recoveryMinor??0,claim.currency)}</b><span>待审返还预留 {money(claim.returnReservedMinor??0,claim.currency)}</span><span>可返还 {money(claim.returnAvailableMinor??0,claim.currency)}</span><span>已返 {money(claim.returnedMinor??0,claim.currency)}</span><span>未结清 {money(claim.remainingMinor, claim.currency)}</span><span>预留 {money(claim.reservedMinor ?? 0, claim.currency)}</span><b>可报销 {money(claim.availableMinor ?? claim.remainingMinor, claim.currency)}</b></div><progress className="mt-3 h-2 w-full accent-[#1f5243]" value={Math.min(claim.settledMinor,claim.effectiveMinor??claim.originalMinor)} max={Math.max(claim.effectiveMinor??claim.originalMinor,1)} aria-label={`${claim.title} 核销进度`}/><div className="mt-3 flex flex-wrap gap-3">{claim.state !== "voided" && (claim.availableMinor ?? claim.remainingMinor) > 0 && <button disabled={archived} onClick={() => setDraft({ payee: claim.claimantId, claimId: claim.id })} className="rounded-lg border border-[#1f5243] px-3 py-2 text-sm font-bold">报销这笔</button>}{claim.state!=="voided"&&<button disabled={archived} className="rounded-lg border px-3 py-2 text-sm" onClick={()=>setCorrection({mode:"refund",entry:{id:claim.sourceEntryId,title:claim.title,entry_type:"reimbursement",currency:claim.currency,amount_minor:claim.originalMinor,category:claim.category,project_name:claim.project}})}>关联退款</button>}{(claim.returnAvailableMinor??claim.recoveryMinor??0)>0&&<button disabled={archived} className="rounded-lg border px-3 py-2 text-sm font-bold" onClick={()=>setCorrection({mode:"return",claim})}>返还这笔</button>}<span className="self-center text-xs text-gray-500"><Link className="underline" href={`${readOnly?"/preview":"/app"}?tab=ledger&entry=${claim.sourceEntryId}`}>查看来源消费 {claim.sourceEntryId.slice(0, 8)}</Link> · 原币债权，不重复计消费</span></div>{claim.financialHistory?.map(event=><p key={event.id} className="mt-2 text-xs text-gray-500">{event.occurredAt} · {event.type==="member_return"?"成员返还":event.refundRecipient==="member"?"退款给成员":"退款回共同账户"} · {money(event.amountMinor,event.currency)} · {event.status==="voided"?"已作废，历史已重算":"已确认"}</p>)}{related.length > 0 && <details className="mt-4 border-t pt-3"><summary className="cursor-pointer text-sm">打款时间线（{related.length} 个批次）</summary><ol className="mt-2 space-y-2">{related.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(batch => {
          const allocation = batch.allocations.find(item => item.claimId === claim.id)!;
          return <li key={batch.id} className="text-sm"><button onClick={() => openBatch(batch.id)} className="underline">{batch.occurredAt} · {batch.title}</button><p className="text-xs text-gray-500">{paymentStatusLabel[batch.status]} · 原币核销 {money(allocation.amountMinor, allocation.currency)} · 实付分摊 {money(allocation.paymentMinor, batch.currency)}</p></li>;
        })}</ol></details>}</article>;
      })}{filtered.length === 0 && <p className="rounded-2xl border bg-white p-8 text-center text-sm text-gray-500">当前筛选下暂无代付原单。</p>}</div>
    </> : <>
      {selectedBatch && <button className="text-sm underline" onClick={() => setSelectedBatch(undefined)}>查看全部打款</button>}
      <div className="space-y-3">{batches.filter(batch => !selectedBatch || batch.id === selectedBatch).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(batch => <article key={batch.id} className="rounded-2xl border bg-white p-5"><div className="flex flex-wrap justify-between gap-3"><div><b>{batch.title}</b><p className="mt-1 text-sm">{money(batch.amountMinor, batch.currency)} · {batch.accountKind === "bank" ? "共同银行" : "共同券商"} → {reimbursementMemberName(members, batch.claimantId)}</p><p className="mt-1 text-xs text-gray-500">{batch.occurredAt} · 提交于 {ledgerTimestamp(batch.createdAt,timeZone)}{batch.decidedAt ? ` · 决定于 ${ledgerTimestamp(batch.decidedAt,timeZone)}` : ""}（{timeZone}）</p></div><span className="text-xs">{paymentStatusLabel[batch.status]}</span></div>{batch.status==="approved"&&batch.ledgerEntryId&&<button disabled={archived} className="mb-3 text-sm underline" onClick={()=>setCorrection({mode:"void",kind:"entry",entry:{id:batch.ledgerEntryId,title:batch.title,currency:batch.currency},previewPlan:readOnly?{entries:[{id:batch.ledgerEntryId,title:batch.title,occurred_at:batch.occurredAt,currency:batch.currency,amount_minor:batch.amountMinor,entry_type:"settlement"}],transfers:[],valuations:[]}:undefined})}>申请作废打款</button>}<SettlementAllocationDetails batch={batch} claims={claims} onClaim={openClaim}/>{batch.fxSnapshotId && <p className="mt-3 text-xs text-gray-500">锁定汇率：{(() => { const fx = fxSnapshots.find(item => item.id === batch.fxSnapshotId); return fx ? `1 USD = ${fx.usdToCny} CNY / ${fx.usdToHkd} HKD · ${fx.sourceNote}` : batch.fxSnapshotId; })()} · 后续汇率更新不会改写本次打款</p>}{pending(batch.status) && <div className="mt-4 flex flex-wrap gap-2">{batch.submitterId === userId ? <button disabled={busy || archived} onClick={() => act(batch, "withdraw")} className="rounded-lg border px-3 py-2 text-sm">撤回并释放额度</button> : <><button disabled={busy || archived} onClick={() => act(batch, "reject")} className="rounded-lg border px-3 py-2 text-sm">驳回</button><button disabled={busy || archived} onClick={() => act(batch, "approve")} className="rounded-lg bg-[#1f5243] px-3 py-2 text-sm text-white">批准打款</button></>}</div>}</article>)}{batches.length === 0 && <p className="rounded-2xl border bg-white p-8 text-center text-sm text-gray-500">暂无打款批次。请从已确认的代付原单发起。</p>}</div>
    </>}
    {draft && <SettlementModal householdId={householdId} members={members} claims={claims} initialPayee={draft.payee} initialClaimId={draft.claimId} snapshot={fxSnapshot} readOnly={readOnly} close={() => setDraft(undefined)} refresh={refresh} notify={notify}/>}
  </div>;
}
function Select({ label, value, change, options }: { label: string; value: string; change: (value: string) => void; options: string[][] }) {
  return <label className="text-sm"><span className="mb-1 block text-gray-600">{label}</span><select value={value} onChange={event => change(event.target.value)}><option value="">全部</option>{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>;
}
export function SettlementAllocationDetails({ batch, claims, onClaim }: { batch: SettlementBatchView; claims: ReimbursementClaimView[]; onClaim?: (id: string) => void }) {
  return <div className="mt-4 space-y-2 rounded-xl bg-[#f3f6f1] p-3 text-sm"><p className="font-bold">原单核销明细</p>{batch.allocations.map(allocation => {
    const claim = claims.find(item => item.id === allocation.claimId);
    const remainingAfter = claim ? Math.max(0, claim.remainingMinor - (pending(batch.status) ? allocation.amountMinor : 0)) : null;
    return <div key={allocation.id} className="border-t pt-2"><button type="button" disabled={!onClaim} onClick={() => onClaim?.(allocation.claimId)} className={onClaim ? "underline" : "text-left"}>{allocation.title}</button><p className="mt-1 text-xs">原币核销 {money(allocation.amountMinor, allocation.currency)} · 实付分摊 {money(allocation.paymentMinor, batch.currency)}{remainingAfter !== null && <span> · {pending(batch.status) ? "批准后未结清" : "当前未结清"} {money(remainingAfter, allocation.currency)}</span>}</p></div>;
  })}</div>;
}

export function SettlementModal({ householdId, members, claims, initialPayee, initialClaimId, snapshot, readOnly, close, refresh, notify }: {
  householdId: string; members: Row[]; claims: ReimbursementClaimView[]; initialPayee: string; initialClaimId?: string;
  snapshot?: FxRateSnapshot; readOnly?: boolean; close: () => void; refresh: () => void; notify: (message: string) => void;
}) {
  const [payee, setPayee] = useState(initialPayee), [currency, setCurrency] = useState<Currency>("USD"), [account, setAccount] = useState("bank");
  const initialClaim = claims.find(claim => claim.id === initialClaimId);
  const [amounts, setAmounts] = useState<Record<string, string>>(initialClaim ? { [initialClaim.id]: ((initialClaim.availableMinor ?? initialClaim.remainingMinor) / 100).toFixed(2) } : {});
  const timeZone = useLedgerTimeZone();
  const [date, setDate] = useState(() => ledgerToday(timeZone)), [title, setTitle] = useState("成员报销打款");
  const [key] = useState(() => createUUID()), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const available = claims.filter(claim => claim.claimantId === payee && claim.state !== "voided" && (claim.availableMinor ?? claim.remainingMinor) > 0);
  let calculation: ReturnType<typeof calculateSettlement> | undefined, issue = "";
  try {
    const chosen = available.filter(claim => Object.hasOwn(amounts, claim.id)).map(claim => {
      const amountMinor = parseFixedDecimal(amounts[claim.id], 2);
      if (amountMinor > (claim.availableMinor ?? claim.remainingMinor)) throw new Error("原币核销额超过可报销额度");
      return { claimId: claim.id, currency: claim.currency, amountMinor };
    });
    calculation = calculateSettlement(chosen, currency, snapshot ? { USD: "1", CNY: snapshot.usdToCnyExact ?? snapshot.usdToCny.toFixed(10), HKD: snapshot.usdToHkdExact ?? snapshot.usdToHkd.toFixed(10) } : undefined);
  } catch (failure) { issue = failure instanceof Error ? failure.message : "核销额度无效"; }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!calculation) return;
    if (readOnly) return notify("本地只读预览不会写入数据。");
    setBusy(true); setError("");
    try {
      const payload = { householdId, idempotencyKey: key, payeeMemberId: payee, accountKind: account, currency, occurredAt: date, title,
        allocations: calculation.allocations.map(allocation => ({ claimId: allocation.claimId, amountMinor: allocation.amountMinor, expectedVersion: available.find(claim => claim.id === allocation.claimId)?.version ?? 1 })) };
      const response = await fetch("/api/settlement-batches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "提交失败");
      refresh(); close(); notify("报销已提交审批，原单额度已预留。");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "网络异常，草稿已保留，可重试"); }
    finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><section role="dialog" aria-modal="true" aria-labelledby="settlement-title" className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl bg-[#fbfaf6] p-5"><div className="flex justify-between"><h2 id="settlement-title" className="text-lg font-bold">发起报销打款</h2><button disabled={busy} onClick={close} aria-label="关闭">✕</button></div><p className="mt-2 text-sm text-gray-500">同一批次只能向一位成员打款，原单可部分或合并核销。</p><form onSubmit={submit} className="mt-4 space-y-4"><fieldset disabled={busy} className="space-y-4"><div className="grid gap-3 sm:grid-cols-3"><label className="text-sm">收款成员<select value={payee} onChange={event => { setPayee(event.target.value); setAmounts({}); }}>{members.map(member => <option key={String(member.user_id)} value={String(member.user_id)}>{reimbursementMemberName(members, String(member.user_id))}</option>)}</select></label><label className="text-sm">付款账户<select value={account} onChange={event => setAccount(event.target.value)}><option value="bank">共同银行</option><option value="brokerage">共同券商</option></select></label><label className="text-sm">打款币种<select value={currency} onChange={event => setCurrency(event.target.value as Currency)}>{currencies.map(code => <option key={code}>{code}</option>)}</select></label></div><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">发生日<input type="date" required max={ledgerToday(timeZone)} value={date} onChange={event => setDate(event.target.value)}/></label><label className="text-sm">说明<input required maxLength={160} value={title} onChange={event => setTitle(event.target.value)}/></label></div><div className="space-y-3">{available.map(claim => <div key={claim.id} className="rounded-xl border bg-white p-3"><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="!w-auto" checked={Object.hasOwn(amounts, claim.id)} onChange={event => setAmounts(previous => { const next = { ...previous }; if (event.target.checked) next[claim.id] = ((claim.availableMinor ?? claim.remainingMinor) / 100).toFixed(2); else delete next[claim.id]; return next; })}/><b>{claim.title}</b></label><p className="mt-1 text-xs text-gray-500">可报销 {money(claim.availableMinor ?? claim.remainingMinor, claim.currency)} · 预留 {money(claim.reservedMinor ?? 0, claim.currency)}</p>{Object.hasOwn(amounts, claim.id) && <label className="mt-2 block text-sm">本次原币核销额（{claim.currency}）<input required inputMode="decimal" value={amounts[claim.id]} onChange={event => setAmounts(previous => ({ ...previous, [claim.id]: event.target.value }))}/></label>}</div>)}{available.length === 0 && <p className="text-sm text-gray-500">该成员暂无可报销的已确认原单。</p>}</div></fieldset><div className="rounded-xl bg-[#edf7ed] p-4">{calculation ? <><b>本次实际打款 {money(calculation.amountMinor, currency)}</b>{calculation.allocations.map(allocation => <p key={allocation.claimId} className="mt-2 text-xs">{available.find(claim => claim.id === allocation.claimId)?.title} · {money(allocation.amountMinor, allocation.currency)} → {money(allocation.paymentMinor, currency)}</p>)}<p className="mt-3 text-xs text-gray-500">总额仅舍入一次，分摊按尾差及原单稳定键排序。最终金额以提交时服务器锁定的已确认汇率为准。</p>{snapshot && <p className="mt-1 text-xs text-gray-500">当前参考：1 USD = {snapshot.usdToCny} CNY / {snapshot.usdToHkd} HKD</p>}</> : <p className="text-sm text-amber-800">{issue}</p>}</div>{error && <p role="alert" className="text-sm text-red-700">{error}</p>}<button disabled={busy || !calculation} type="submit" className="w-full rounded-xl bg-[#1f5243] px-4 py-3 font-bold text-white disabled:opacity-50">{busy ? "正在提交…" : "提交审批并预留额度"}</button></form></section></div>;
}
