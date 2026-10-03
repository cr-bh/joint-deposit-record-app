import { reportBalances, type Currency, type FxRates, type LedgerEvent } from "./balance-calculations";
import { filterLedgerActivity, type LedgerFilters } from "./ledger-filters";
import { safeInteger } from "./integer-math";

export type SpendingRecord = { id: string; date: string; title: string; currency: Currency; originalMinor: number; amountMinor: number | null; source: string; category: string; project: string; refund: boolean; recipient: string; originalId?: string };
export type FlowNode = { id: string; name: string; layer: number };
export type FlowEdge = { id: string; source: string; target: string; value: number; recordIds: string[] };
export type FlowGraph = { nodes: FlowNode[]; links: FlowEdge[] };

function graph(records: SpendingRecord[], refund: boolean): FlowGraph {
  const nodes = new Map<string, FlowNode>(), links = new Map<string, FlowEdge>();
  for (const record of records.filter(r => r.refund === refund && r.amountMinor !== null && r.amountMinor > 0)) {
    const names = refund ? [record.category, record.recipient] : [record.source, record.category, record.project];
    const ids = names.map((name, layer) => { const id = JSON.stringify([layer, name]); nodes.set(id, { id, name, layer }); return id; });
    for (let layer = 0; layer < ids.length - 1; layer++) {
      const id = JSON.stringify([ids[layer], ids[layer + 1]]);
      const edge = links.get(id) ?? { id, source: ids[layer], target: ids[layer + 1], value: 0, recordIds: [] };
      edge.value = safeInteger(edge.value + record.amountMinor!, "消费流量"); edge.recordIds.push(record.id); links.set(id, edge);
    }
  }
  return { nodes: [...nodes.values()], links: [...links.values()] };
}

/** occurredAt is already the ledger's business date. Do not regroup by browser or server time zone. */
export function buildSpendingReport(events: LedgerEvent[], reporting: Currency, historicalRates: Record<string, Partial<FxRates>>, filters: LedgerFilters, memberNames: Record<string, string> = {}) {
  const sources = new Map(events.map(e => [e.id, e]));
  const issues: string[] = [];
  const candidates = events.filter(e => e.status === "posted" && ["expense", "reimbursement", "expense_refund"].includes(e.type)).map(event => {
    const original = event.type === "expense_refund" ? sources.get(event.refundSourceEntryId ?? "") : event;
    // Source facts govern category/payment filters; refund dates and currencies remain their own facts.
    return { event, original, occurred_at: event.occurredAt, entry_type: event.type, account_kind: event.accountKind, currency: event.currency, category: original?.category ?? event.category, project_name: original?.project ?? event.project, payer_member_id: original?.payerMemberId };
  });
  const selected = filterLedgerActivity(candidates, filters);
  const records: SpendingRecord[] = selected.map(({ event, original, category, project_name }) => {
    const refund = event.type === "expense_refund";
    const member = original?.payerMemberId ? memberNames[original.payerMemberId] ?? `成员 ${original.payerMemberId.slice(0, 8)}` : "待核对成员";
    const converted = reportBalances({ USD: 0, CNY: 0, HKD: 0, [event.currency]: event.amountMinor }, reporting, event.fxSnapshotId ? historicalRates[event.fxSnapshotId] ?? {} : {});
    if (converted.amountMinor === null) issues.push(`缺少 ${converted.missingCurrencies.join(" / ")} 历史锁定汇率，消费折算待完善`);
    if (refund && !original) issues.push("退款缺少可追溯原消费，退款流向待核对");
    return { id: event.id, date: event.occurredAt, title: event.title ?? "共同消费", currency: event.currency, originalMinor: event.amountMinor, amountMinor: converted.amountMinor, source: original?.type === "reimbursement" ? `成员代付 · ${member}` : original?.accountKind === "brokerage" ? "共同券商" : "共同银行", category: category || "其他", project: project_name || "未指定事项", refund, recipient: event.refundRecipient === "member" ? `原垫付成员 · ${member}` : event.accountKind === "brokerage" ? "共同券商" : "共同银行", originalId: refund ? event.refundSourceEntryId : undefined };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const start = filters.start || records[0]?.date || "", end = filters.end || records.at(-1)?.date || start;
  if (start && end && start > end) issues.push("开始日期不能晚于结束日期");
  const unavailable = issues.length > 0;
  const sum = (refund: boolean) => records.filter(r => r.refund === refund).reduce((total, r) => safeInteger(total + (r.amountMinor ?? 0), "消费总额"), 0);
  const grossMinor = unavailable ? null : sum(false), refundMinor = unavailable ? null : sum(true);
  const daily = new Map<string, { date: string; accountMinor: number; memberMinor: number; refundMinor: number; netMinor: number }>();
  // Long ranges use calendar months, keeping zero filling bounded without silently truncating records.
  const monthly = Boolean(start && end && (Date.parse(end) - Date.parse(start)) / 86400000 > 366);
  if (start && end && start <= end) {
    const cursor = new Date(`${start}T00:00:00Z`);
    if (monthly) cursor.setUTCDate(1);
    const boundary = new Date(`${end}T00:00:00Z`);
    while (cursor.getTime() <= boundary.getTime()) {
      const date = cursor.toISOString().slice(0, monthly ? 7 : 10);
      daily.set(date, { date, accountMinor: 0, memberMinor: 0, refundMinor: 0, netMinor: 0 });
      if (monthly) cursor.setUTCMonth(cursor.getUTCMonth() + 1); else cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  for (const record of records) {
    const day = daily.get(record.date.slice(0, monthly ? 7 : 10)); if (!day) continue;
    const amount = record.amountMinor ?? 0;
    if (record.refund) day.refundMinor = safeInteger(day.refundMinor + amount, "当期退款");
    else if (record.source.startsWith("成员代付")) day.memberMinor = safeInteger(day.memberMinor + amount, "成员代付");
    else day.accountMinor = safeInteger(day.accountMinor + amount, "共同账户消费");
    day.netMinor = safeInteger(day.accountMinor + day.memberMinor - day.refundMinor, "净消费");
  }
  return { start, end, monthly, grossMinor, refundMinor, netMinor: grossMinor === null || refundMinor === null ? null : safeInteger(grossMinor - refundMinor, "净消费"), records, trend: unavailable ? [] : [...daily.values()], consumption: unavailable ? { nodes: [], links: [] } : graph(records, false), refunds: unavailable ? { nodes: [], links: [] } : graph(records, true), issues: [...new Set(issues)] };
}
export type SpendingReport = ReturnType<typeof buildSpendingReport>;
