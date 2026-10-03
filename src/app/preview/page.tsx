import { buildLedgerRecordStates } from "@/lib/domain/ledger-record-states";
import { notFound } from "next/navigation";
import PreviewClient from "./preview-client";
import { ledgerEventFromRow } from "@/lib/domain/ledger-adapter";
import { cashTransferFromRow } from "@/lib/domain/account-adapter";
import { accountCashBalances } from "@/lib/domain/account-balances";
import { fxRateSnapshotFromRow, ratesFromSnapshot } from "@/lib/domain/fx-rates";
import { defaultSpendingCategoryNames, type SpendingDimension } from "@/lib/domain/spending-dimensions";
import { filterLedgerActivity, normalizeLedgerFilters } from "@/lib/domain/ledger-filters";
import { buildOverviewSummary } from "@/lib/domain/overview-summary";
import { buildSpendingReport } from "@/lib/domain/spending-report";
import { buildInvestmentSnapshot } from "@/lib/domain/investment-snapshot";
import { projectReimbursements } from "@/lib/domain/settlement-batches";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const ETF = "00000000-0000-4000-8000-000000000101";
const FUND = "00000000-0000-4000-8000-000000000102";
const FX = "00000000-0000-4000-8000-000000000601";
const PROJECT_TRIP = "00000000-0000-4000-8000-000000000801";
const at = (day: string, minute: string) => `${day}T${minute}:00Z`;

export default async function PreviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV !== "development") notFound();
  const query = await searchParams;
  const spendingCategories: SpendingDimension[] = defaultSpendingCategoryNames.map((name, index) => ({ id: `00000000-0000-4000-8000-${String(900 + index).padStart(12, "0")}`, name, isSystem: true }));
  const categoryId = (name: string) => spendingCategories.find((item) => item.name === name)!.id;
  const spendingProjects: SpendingDimension[] = [
    { id: PROJECT_TRIP, name: "2026 香港旅行", isSystem: false },
    { id: "00000000-0000-4000-8000-000000000802", name: "旧家翻新", archivedAt: "2026-08-31T00:00:00Z", isSystem: false },
  ];
  const entries: Record<string, unknown>[] = [
    { id: "00000000-0000-4000-8000-000000000211", status: "posted", entry_type: "expense_refund", amount_minor: 10000, currency: "USD", occurred_at: "2026-09-12", created_at: at("2026-09-12", "10:00"), effective_sequence: "14", title: "旅行交通退款给 A", refund_source_entry_id: "00000000-0000-4000-8000-000000000204", refund_recipient: "member", payer_member_id: A, category: "交通", category_id: categoryId("交通"), project_id: PROJECT_TRIP, project_name: "2026 香港旅行" },
    { id: "00000000-0000-4000-8000-000000000212", status: "posted", entry_type: "member_return", amount_minor: 1000, currency: "USD", occurred_at: "2026-09-13", created_at: at("2026-09-13", "10:00"), effective_sequence: "15", title: "A 返还已多报销部分", recovery_claim_id: "00000000-0000-4000-8000-000000000701", recovery_original_minor: 1000, payer_member_id: A, account_kind: "bank" },
    { id: "00000000-0000-4000-8000-000000000201", status: "posted", entry_type: "deposit", amount_minor: 300000, currency: "USD", occurred_at: "2026-09-01", created_at: at("2026-09-01", "09:00"), effective_sequence: "1", title: "A 九月共同存入", payer_member_id: A, account_kind: "bank" },
    { id: "00000000-0000-4000-8000-000000000202", status: "posted", entry_type: "deposit", amount_minor: 300000, currency: "USD", occurred_at: "2026-09-01", created_at: at("2026-09-01", "09:01"), effective_sequence: "2", title: "B 九月共同存入", payer_member_id: B, account_kind: "bank" },
    { id: "00000000-0000-4000-8000-000000000203", status: "posted", entry_type: "expense", amount_minor: 10000, currency: "USD", occurred_at: "2026-09-02", created_at: at("2026-09-02", "18:00"), effective_sequence: "3", title: "共同晚餐", category_id: categoryId("餐饮"), category: "餐饮", project_id: PROJECT_TRIP, project_name: "2026 香港旅行", account_kind: "bank" },
    { id: "00000000-0000-4000-8000-000000000204", status: "posted", entry_type: "reimbursement", amount_minor: 12000, currency: "USD", occurred_at: "2026-09-03", created_at: at("2026-09-03", "11:00"), effective_sequence: "4", title: "A 代付旅行交通", category_id: categoryId("交通"), category: "交通", project_id: PROJECT_TRIP, project_name: "2026 香港旅行", payer_member_id: A },
    { id: "00000000-0000-4000-8000-000000000205", status: "posted", entry_type: "settlement", amount_minor: 5000, currency: "USD", occurred_at: "2026-09-04", created_at: at("2026-09-04", "10:00"), effective_sequence: "5", title: "向 A 部分报销", payee_member_id: A, account_kind: "bank" },
    { id: "00000000-0000-4000-8000-000000000206", status: "posted", entry_type: "investment_buy", amount_minor: 100000, currency: "USD", occurred_at: "2026-09-05", created_at: at("2026-09-05", "09:00"), effective_sequence: "7", title: "ETF 买入 100 份", investment_id: ETF, quantity_milli: 100000, account_kind: "brokerage" },
    { id: "00000000-0000-4000-8000-000000000207", status: "posted", entry_type: "investment_sell", amount_minor: 60000, currency: "USD", occurred_at: "2026-09-05", created_at: at("2026-09-05", "09:05"), effective_sequence: "8", title: "ETF 卖出 40 份", investment_id: ETF, quantity_milli: 40000, account_kind: "brokerage" },
    { id: "00000000-0000-4000-8000-000000000208", status: "posted", entry_type: "investment_buy", amount_minor: 72000, currency: "CNY", occurred_at: "2026-09-06", created_at: at("2026-09-06", "13:00"), effective_sequence: "10", title: "人民币基金买入", investment_id: FUND, quantity_milli: 10000, account_kind: "brokerage" },
    { id: "00000000-0000-4000-8000-000000000209", status: "posted", entry_type: "reimbursement", amount_minor: 72000, currency: "CNY", occurred_at: "2026-09-08", created_at: at("2026-09-08", "10:00"), effective_sequence: "12", title: "B 代付旅行住宿", category_id: categoryId("居住"), category: "居住", project_id: PROJECT_TRIP, project_name: "2026 香港旅行", payer_member_id: B, fx_snapshot_id: FX },
    { id: "00000000-0000-4000-8000-000000000210", status: "posted", entry_type: "reimbursement", amount_minor: 78000, currency: "HKD", occurred_at: "2026-09-08", created_at: at("2026-09-08", "11:00"), effective_sequence: "13", title: "B 代付旅行门票", category_id: categoryId("玩乐"), category: "玩乐", project_id: PROJECT_TRIP, project_name: "2026 香港旅行", payer_member_id: B, fx_snapshot_id: FX },
  ];
  entries.push(
    { id: "00000000-0000-4000-8000-000000000213", status: "posted", entry_type: "expense_refund", amount_minor: 2500, currency: "USD", occurred_at: "2026-09-15", created_at: at("2026-09-15", "10:00"), effective_sequence: "16", title: "晚餐退款回共同银行", category: "餐饮", project_name: "2026 香港旅行", account_kind: "bank", refund_source_entry_id: "00000000-0000-4000-8000-000000000203", refund_recipient: "common" },
  );
  const transfers = [
    { id: "00000000-0000-4000-8000-000000000501", status: "posted", amount_minor: 150000, currency: "USD", destination_amount_minor: 150000, destination_currency: "USD", movement_type: "same_currency", occurred_at: "2026-09-04", created_at: at("2026-09-04", "16:00"), effective_sequence: "6", title: "转入券商准备投资", source_account_kind: "bank", destination_account_kind: "brokerage" },
    { id: "00000000-0000-4000-8000-000000000502", status: "posted", amount_minor: 10000, currency: "USD", destination_amount_minor: 72000, destination_currency: "CNY", movement_type: "currency_exchange", fx_snapshot_id: FX, occurred_at: "2026-09-06", created_at: at("2026-09-06", "12:00"), effective_sequence: "9", title: "换成人民币并转入券商", source_account_kind: "bank", destination_account_kind: "brokerage" },
    { id: "00000000-0000-4000-8000-000000000503", status: "posted", amount_minor: 10000, currency: "USD", destination_amount_minor: 78000, destination_currency: "HKD", movement_type: "currency_exchange", fx_snapshot_id: FX, occurred_at: "2026-09-07", created_at: at("2026-09-07", "11:00"), effective_sequence: "11", title: "实际换汇用于旅行", source_account_kind: "bank", destination_account_kind: "bank" },
  ];
  const accounts = [{ kind: "bank", name: "共同银行" }, { kind: "brokerage", name: "共同券商" }];
  const cashTransfers = transfers.map(cashTransferFromRow);
  const accountBalances = accountCashBalances(entries.map(ledgerEventFromRow), cashTransfers);
  const activity = [...entries, ...transfers.map((transfer) => ({ ...transfer, entry_type: transfer.movement_type === "currency_exchange" ? "currency_exchange" : "account_transfer" }))].sort((left, right) => Number(right.effective_sequence ?? 0) - Number(left.effective_sequence ?? 0));
  const ledgerFilters = normalizeLedgerFilters(query);
  const filteredActivity = filterLedgerActivity(activity,ledgerFilters).filter(entry => typeof query.entry !== "string" || entry.id === query.entry);
  const proposals = [
    { id: "00000000-0000-4000-8000-000000000306", status: "pending_approval", submitter_id: B, payload: { type: "expense_refund", sourceEntryId: "00000000-0000-4000-8000-000000000203", recipient: "common", accountKind: "bank", amountMinor: 2500, currency: "USD", category: "餐饮", project: "2026 香港旅行", title: "晚餐部分退款", occurredAt: "2026-09-14" } },
    { id: "00000000-0000-4000-8000-000000000301", status: "pending_approval", submitter_id: B, payload: { type: "expense", title: "周末采购", amountMinor: 8650, currency: "USD", categoryId: categoryId("购物"), category: "购物", projectId: PROJECT_TRIP, project: "2026 香港旅行", accountKind: "bank" } },
    { id: "00000000-0000-4000-8000-000000000302", status: "overdue_pending", submitter_id: A, payload: { type: "deposit", title: "补录共同存入", amountMinor: 30000, currency: "USD", payerMemberId: B } },
    { id: "00000000-0000-4000-8000-000000000304", status: "pending_approval", submitter_id: B, fx_snapshot_id: FX, payload: { type: "settlement", title: "旅行代付合并报销", amountMinor: 15000, currency: "USD", accountKind: "bank", occurredAt: "2026-09-09", payeeMemberId: B } },
    { id: "00000000-0000-4000-8000-000000000303", status: "pending_approval", submitter_id: B, payload: { type: "fx_rate_update", title: "手动汇率更新", amountMinor: 0, currency: "USD", effectiveAt: "2026-09-14T12:00:00Z", usdToCny: "7.5", usdToHkd: "7.85", sourceNote: "银行 App 参考价，人工录入" } },
  ];
  const approvedProposal = { id: "00000000-0000-4000-8000-000000000305", status: "approved", submitter_id: B, decided_at: at("2026-09-04", "10:00"), payload: { title: "向 A 部分报销", occurredAt: "2026-09-04" } };
  const claimRows = [
    { id: "00000000-0000-4000-8000-000000000701", source_entry_id: "00000000-0000-4000-8000-000000000204", claimant_id: A, currency: "USD", claimed_minor: 12000, status: "settled", version: 2, created_at: at("2026-09-03", "11:00") },
    { id: "00000000-0000-4000-8000-000000000702", source_entry_id: "00000000-0000-4000-8000-000000000209", claimant_id: B, currency: "CNY", claimed_minor: 72000, status: "open", version: 1, created_at: at("2026-09-08", "10:00") },
    { id: "00000000-0000-4000-8000-000000000703", source_entry_id: "00000000-0000-4000-8000-000000000210", claimant_id: B, currency: "HKD", claimed_minor: 78000, status: "open", version: 1, created_at: at("2026-09-08", "11:00") },
  ];
  const batchRows = [
    { id: "00000000-0000-4000-8000-000000001001", proposal_id: approvedProposal.id, claimant_id: A, account_kind: "bank", currency: "USD", amount_minor: 5000, fx_snapshot_id: null, ledger_entry_id: "00000000-0000-4000-8000-000000000205", status: "posted", created_at: at("2026-09-04", "09:00") },
    { id: "00000000-0000-4000-8000-000000001002", proposal_id: "00000000-0000-4000-8000-000000000304", claimant_id: B, account_kind: "bank", currency: "USD", amount_minor: 15000, fx_snapshot_id: FX, ledger_entry_id: null, status: "reserved", created_at: at("2026-09-09", "09:00") },
  ];
  const allocationRows = [
    { id: "00000000-0000-4000-8000-000000001101", household_id: "00000000-0000-4000-8000-000000000010", batch_id: batchRows[0].id, claim_id: claimRows[0].id, settlement_entry_id: batchRows[0].ledger_entry_id, amount_minor: 5000, payment_minor: 5000, claim_version: 1, status: "posted", created_at: batchRows[0].created_at },
    { id: "00000000-0000-4000-8000-000000001102", household_id: "00000000-0000-4000-8000-000000000010", batch_id: batchRows[1].id, claim_id: claimRows[1].id, settlement_entry_id: null, amount_minor: 36000, payment_minor: 5000, claim_version: 1, status: "reserved", created_at: batchRows[1].created_at },
    { id: "00000000-0000-4000-8000-000000001103", household_id: "00000000-0000-4000-8000-000000000010", batch_id: batchRows[1].id, claim_id: claimRows[2].id, settlement_entry_id: null, amount_minor: 78000, payment_minor: 10000, claim_version: 1, status: "reserved", created_at: batchRows[1].created_at },
  ];
  const { claims: reimbursementClaims, batches: settlementBatches } = projectReimbursements(claimRows, allocationRows, batchRows, [...proposals, approvedProposal], entries.map(ledgerEventFromRow));
  const investments = [
    { id: ETF, name: "标普 500 ETF", asset_type: "基金 / ETF", unit_name: "份", valuation_cadence: "weekly", currency: "USD", opening_quantity_milli: 0, opening_cost_minor: 0 },
    { id: FUND, name: "人民币指数基金", asset_type: "基金 / ETF", unit_name: "份", valuation_cadence: "monthly", currency: "CNY", opening_quantity_milli: 0, opening_cost_minor: 0 },
  ];
  const valuations = [{ id: "00000000-0000-4000-8000-000000000401", investment_id: ETF, currency: "USD", note: "ETF 人工估值", status: "posted", value_date: "2026-09-07", created_at: at("2026-09-07", "09:00"), unit_value_minor: 1200, unit_value_1e4: 120000 }];
  const members = [{ user_id: A, role: "owner", profiles: { display_name: "顾言" } }, { user_id: B, role: "member", profiles: { display_name: "林知夏" } }];
  const fx = fxRateSnapshotFromRow({ id: FX, usd_to_cny: "7.2", usd_to_hkd: "7.8", effective_at: "2026-09-07T10:00:00Z", source_note: "银行 App 参考价，人工录入", created_by: A, approved_by: B, approved_at: "2026-09-14T12:05:00Z" });
  const fxSnapshot = { ...fx, stale: false };
  const events = entries.map(ledgerEventFromRow);
  const investmentSnapshots = Object.fromEntries(investments.map(investment => [investment.id, buildInvestmentSnapshot(events, investment, valuations)]));
  const overviewSummary = buildOverviewSummary(accountBalances, investments, investmentSnapshots, reimbursementClaims, "USD", fx);
  const spendingReport = buildSpendingReport(events, "USD", { [FX]: ratesFromSnapshot(fx) }, ledgerFilters, { [A]: "顾言", [B]: "林知夏" });
  return <PreviewClient ledgerRecordStates={buildLedgerRecordStates(entries.map(ledgerEventFromRow), proposals, reimbursementClaims, activity.map(row => ({ id: String(row.id), status: String(row.status) })))} overviewSummary={overviewSummary} spendingReport={spendingReport} key={`${query.tab??"overview"}:${query.entry??""}:${query.batch??""}`} initialBatchId={typeof query.batch === "string" ? query.batch : undefined} entries={filteredActivity} totalEntries={filteredActivity.length} investmentEntries={entries} transfers={cashTransfers} proposals={proposals} reimbursementClaims={reimbursementClaims} settlementBatches={settlementBatches} investments={investments} valuations={valuations} members={members} accounts={accounts} accountBalances={accountBalances} fxSnapshot={fxSnapshot} rates={ratesFromSnapshot(fx)} spendingCategories={spendingCategories} spendingProjects={spendingProjects} ledgerFilters={ledgerFilters} initialTab={query.tab === "ledger" ? "流水" : query.tab === "approvals" ? "审批中心" : query.tab === "investments" ? "投资" : query.tab === "reimbursements" ? "代付与报销" : "总览"}/>;
}
