import { z } from "zod";
import { frozenLedgerSchema } from "./household-management";
import { ledgerEventFromRow } from "./ledger-adapter";
import { cashTransferFromRow } from "./account-adapter";
import { accountCashBalances, combinedCashBalances, type AccountBalances } from "./account-balances";
import { cashImpact, currencies } from "./balance-calculations";
import { calculateInvestmentPosition } from "./investment-calculations";
import { safeInteger } from "./integer-math";

type Issue = { id: string; reason: string; category: "member" | "allocation" | "account" | "precision" | "fx" | "investment" | "data" };
const integer = z.number().int().safe();
const balances = z.object({ USD: integer, CNY: integer, HKD: integer }).strict();
export const migrationRehearsalSchema = z.object({
  cutoffDate: z.string().date(),
  cash: z.object({ bank: balances, brokerage: balances }).strict(),
  investments: z.array(z.discriminatedUnion("mode", [
    z.object({ id: z.string().uuid(), mode: z.literal("full_history") }).strict(),
    z.object({ id: z.string().uuid(), mode: z.literal("opening"), quantityMilli: integer.nonnegative(), costMinor: integer.nonnegative() }).strict(),
  ])),
}).strict();

/** Inventory never changes rows, infers payers from submitters or assigns FIFO payments. */
export function migrationInventory(input: unknown) {
  const data = frozenLedgerSchema.parse(input), issues: Issue[] = [];
  const add = (id: string, category: Issue["category"], reason: string) => issues.push({ id, category, reason });
  const claims = new Set(data.reimbursementClaims.map(c => String(c.source_entry_id)));
  const batches = new Set(data.settlementBatches.filter(b => b.status === "posted").map(b => String(b.ledger_entry_id)));
  const rates = new Map(data.fxSnapshots.map(f => [String(f.id), f]));
  const validEvents = [];
  const proposalPayloads = new Map(data.proposals.map(p => [String(p.id), p.payload as Record<string,unknown> | undefined]));
  for (const row of data.entries) {
    const id = String(row.id);
    let event;
    try { event = ledgerEventFromRow(row); } catch { add(id, "data", "币种、原金额、日期或精度无效；保留原始行待核对"); continue; }
    validEvents.push(event);
    if (event.status !== "posted") continue;
    if (event.type === "deposit" && !event.payerMemberId) add(id, "member", "存入缺实际出资成员；提交者不能代替付款人");
    if (event.type === "reimbursement" && (!event.payerMemberId || !claims.has(id))) add(id, "member", "代付缺实际垫付成员或债权原单");
    if (event.type === "settlement" && (!event.payeeMemberId || !batches.has(id))) add(id, "allocation", "历史打款缺收款人或原单分配；不自动核销");
    if (event.type === "expense_refund" && !event.refundSourceEntryId) add(id, "allocation", "退款缺关联原消费和退款去向");
    if (cashImpact(event) && !event.accountKind) add(id, "account", "历史共同现金缺银行/券商归属，需切换日期初拆分");
    if (["expense", "reimbursement", "expense_refund"].includes(event.type) && event.currency !== data.configuration.reporting_currency) {
      const snapshot = event.fxSnapshotId ? rates.get(event.fxSnapshotId) : undefined;
      if (!snapshot || snapshot.status !== "approved" || !String(snapshot.source_note ?? "").trim()) add(id, "fx", "历史外币消费缺有来源的已确认汇率，折算保持待核对");
    }
    const payload = proposalPayloads.get(String(row.proposal_id));
    if (payload?.quantityMilli != null && payload.quantityMicro == null && row.quantity_micro != null && row.quantity_milli != null && Number(row.quantity_micro) !== Number(row.quantity_milli) * 1000) add(id, "precision", "旧milli数量与升级值不一致，不恢复不存在的历史精度");
  }
  for (const investment of data.investments) {
    const id = String(investment.id);
    if (Number(investment.opening_quantity_milli ?? 0) || Number(investment.opening_cost_minor ?? 0)) add(id, "investment", "旧期初需双方确认，并与全历史重放明确选择核算模式");
    try { calculateInvestmentPosition(validEvents, id, Number(investment.opening_quantity_milli ?? 0), Number(investment.opening_cost_minor ?? 0)); }
    catch { add(id, "investment", "持仓历史不能合法重放，需核对数量、成本和交易顺序"); }
  }
  for (const value of data.valuations) {
    if (value.input_mode === "legacy" && value.unit_value_1e4 != null && value.unit_value_minor != null && Number(value.unit_value_1e4) !== Number(value.unit_value_minor) * 100) add(String(value.id), "precision", "旧minor与高精度单价不同，请核对报价来源；不得补造历史小数");
  }
  return { issues, entries: data.entries.length, investments: data.investments.length, policy: "原币、原额和提交者保留；未确认事实继续待核对" };
}

/** A pure rehearsal: old history stays available for queries and spending charts.
 * It intentionally has no database write path. NewNiu does not import old data. */
export function rehearseMigration(snapshot: unknown, plan: unknown) {
  const data = frozenLedgerSchema.parse(snapshot), input = migrationRehearsalSchema.parse(plan);
  const events = data.entries.map(ledgerEventFromRow), transfers = data.transfers.map(cashTransferFromRow);
  if (transfers.some(t => !t.occurredAt)) throw new Error("划转缺发生日，无法确定切换日期初");
  const before = events.filter(e => e.occurredAt < input.cutoffDate), after = events.filter(e => e.occurredAt >= input.cutoffDate);
  const oldCash = combinedCashBalances(accountCashBalances(before, transfers.filter(t => t.occurredAt! < input.cutoffDate)));
  const openingCash = combinedCashBalances(input.cash);
  for (const currency of currencies) if (oldCash[currency] !== openingCash[currency]) throw new Error(`${currency} 期初合计必须等于旧共同现金，不能新增贡献或收入`);
  const ids = new Set(input.investments.map(i => i.id));
  if (ids.size !== input.investments.length || ids.size !== data.investments.length || data.investments.some(i => !ids.has(String(i.id)))) throw new Error("每个标的必须且只能选择一种核算模式");
  const following = accountCashBalances(after, transfers.filter(t => t.occurredAt! >= input.cutoffDate));
  const cash = structuredClone(input.cash) as AccountBalances;
  for (const account of ["bank", "brokerage"] as const) for (const currency of currencies) cash[account][currency] = safeInteger(cash[account][currency] + following[account][currency], "迁移现金");
  const positions = input.investments.map(mode => {
    const row = data.investments.find(i => i.id === mode.id)!;
    const oldPosition = calculateInvestmentPosition(events, mode.id, Number(row.opening_quantity_milli ?? 0), Number(row.opening_cost_minor ?? 0));
    const newPosition = mode.mode === "full_history" ? oldPosition : calculateInvestmentPosition(after, mode.id, mode.quantityMilli, mode.costMinor);
    return { id: mode.id, mode: mode.mode, oldPosition, newPosition, quantityDeltaMicro: (newPosition.quantityMicro ?? newPosition.quantityMilli * 1000) - (oldPosition.quantityMicro ?? oldPosition.quantityMilli * 1000), costDeltaMinor: newPosition.remainingCostMinor - oldPosition.remainingCostMinor };
  });
  return { cutoffDate: input.cutoffDate, oldCash, openingCash, cash, positions, inventory: migrationInventory(data), retainedHistoryCount: before.length, contributionAddedMinor: 0, dryRun: true as const };
}
