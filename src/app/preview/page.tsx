import { notFound } from "next/navigation";
import PreviewClient from "./preview-client";
import { ledgerEventFromRow } from "@/lib/domain/ledger-adapter";
import { cashTransferFromRow } from "@/lib/domain/account-adapter";
import { accountCashBalances } from "@/lib/domain/account-balances";
import { fxRateSnapshotFromRow, ratesFromSnapshot } from "@/lib/domain/fx-rates";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const ETF = "00000000-0000-4000-8000-000000000101";
const FUND = "00000000-0000-4000-8000-000000000102";
const FX = "00000000-0000-4000-8000-000000000601";
const at = (day: string, minute: string) => `${day}T${minute}:00Z`;

export default function PreviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  const entries = [
    { id: "00000000-0000-4000-8000-000000000201", status: "posted", entry_type: "deposit", amount_minor: 300000, currency: "USD", occurred_at: "2026-09-01", created_at: at("2026-09-01", "09:00"), effective_sequence: "1", title: "A 九月共同存入", payer_member_id: A, account_kind: "bank" },
    { id: "00000000-0000-4000-8000-000000000202", status: "posted", entry_type: "deposit", amount_minor: 300000, currency: "USD", occurred_at: "2026-09-01", created_at: at("2026-09-01", "09:01"), effective_sequence: "2", title: "B 九月共同存入", payer_member_id: B, account_kind: "bank" },
    { id: "00000000-0000-4000-8000-000000000203", status: "posted", entry_type: "expense", amount_minor: 10000, currency: "USD", occurred_at: "2026-09-02", created_at: at("2026-09-02", "18:00"), effective_sequence: "3", title: "共同晚餐", category: "餐饮", account_kind: "bank" },
    { id: "00000000-0000-4000-8000-000000000204", status: "posted", entry_type: "reimbursement", amount_minor: 12000, currency: "USD", occurred_at: "2026-09-03", created_at: at("2026-09-03", "11:00"), effective_sequence: "4", title: "A 代付旅行交通", category: "旅行", payer_member_id: A },
    { id: "00000000-0000-4000-8000-000000000205", status: "posted", entry_type: "settlement", amount_minor: 5000, currency: "USD", occurred_at: "2026-09-04", created_at: at("2026-09-04", "10:00"), effective_sequence: "5", title: "向 A 部分报销", payee_member_id: A, account_kind: "bank" },
    { id: "00000000-0000-4000-8000-000000000206", status: "posted", entry_type: "investment_buy", amount_minor: 100000, currency: "USD", occurred_at: "2026-09-05", created_at: at("2026-09-05", "09:00"), effective_sequence: "7", title: "ETF 买入 100 份", investment_id: ETF, quantity_milli: 100000, account_kind: "brokerage" },
    { id: "00000000-0000-4000-8000-000000000207", status: "posted", entry_type: "investment_sell", amount_minor: 60000, currency: "USD", occurred_at: "2026-09-05", created_at: at("2026-09-05", "09:05"), effective_sequence: "8", title: "ETF 卖出 40 份", investment_id: ETF, quantity_milli: 40000, account_kind: "brokerage" },
    { id: "00000000-0000-4000-8000-000000000208", status: "posted", entry_type: "investment_buy", amount_minor: 72000, currency: "CNY", occurred_at: "2026-09-06", created_at: at("2026-09-06", "13:00"), effective_sequence: "9", title: "人民币基金买入", investment_id: FUND, quantity_milli: 10000, account_kind: "brokerage" },
  ];
  const transfers = [
    { id: "00000000-0000-4000-8000-000000000501", status: "posted", amount_minor: 150000, currency: "USD", destination_amount_minor: 150000, destination_currency: "USD", movement_type: "same_currency", occurred_at: "2026-09-04", created_at: at("2026-09-04", "16:00"), effective_sequence: "6", title: "转入券商准备投资", source_account_kind: "bank", destination_account_kind: "brokerage" },
    { id: "00000000-0000-4000-8000-000000000502", status: "posted", amount_minor: 10000, currency: "USD", destination_amount_minor: 78000, destination_currency: "HKD", movement_type: "currency_exchange", fx_snapshot_id: FX, occurred_at: "2026-09-07", created_at: at("2026-09-07", "11:00"), effective_sequence: "10", title: "实际换汇用于旅行", source_account_kind: "bank", destination_account_kind: "bank" },
  ];
  const accounts = [{ kind: "bank", name: "共同银行" }, { kind: "brokerage", name: "共同券商" }];
  const cashTransfers = transfers.map(cashTransferFromRow);
  const accountBalances = accountCashBalances(entries.map(ledgerEventFromRow), cashTransfers);
  const activity = [...entries, ...transfers.map((transfer) => ({ ...transfer, entry_type: transfer.movement_type === "currency_exchange" ? "currency_exchange" : "account_transfer" }))].sort((left, right) => Number(right.effective_sequence ?? 0) - Number(left.effective_sequence ?? 0));
  const proposals = [
    { id: "00000000-0000-4000-8000-000000000301", status: "pending_approval", submitter_id: B, payload: { type: "expense", title: "周末采购", amountMinor: 8650, currency: "USD" } },
    { id: "00000000-0000-4000-8000-000000000302", status: "overdue_pending", submitter_id: A, payload: { type: "deposit", title: "补录共同存入", amountMinor: 30000, currency: "USD", payerMemberId: B } },
    { id: "00000000-0000-4000-8000-000000000303", status: "pending_approval", submitter_id: B, payload: { type: "fx_rate_update", title: "手动汇率更新", amountMinor: 0, currency: "USD", effectiveAt: "2026-09-14T12:00:00Z", usdToCny: "7.5", usdToHkd: "7.85", sourceNote: "银行 App 参考价，人工录入" } },
  ];
  const investments = [
    { id: ETF, name: "标普 500 ETF", currency: "USD", opening_quantity_milli: 0, opening_cost_minor: 0 },
    { id: FUND, name: "人民币指数基金", currency: "CNY", opening_quantity_milli: 0, opening_cost_minor: 0 },
  ];
  const valuations = [{ id: "00000000-0000-4000-8000-000000000401", investment_id: ETF, value_date: "2026-09-07", created_at: at("2026-09-07", "09:00"), unit_value_minor: 1200, unit_value_1e4: 120000 }];
  const members = [{ user_id: A, role: "owner", profiles: { display_name: "顾言" } }, { user_id: B, role: "member", profiles: { display_name: "林知夏" } }];
  const fx = fxRateSnapshotFromRow({ id: FX, usd_to_cny: "7.2", usd_to_hkd: "7.8", effective_at: "2026-09-07T10:00:00Z", source_note: "银行 App 参考价，人工录入", created_by: A, approved_by: B, approved_at: "2026-09-14T12:05:00Z" });
  const fxSnapshot = { ...fx, stale: false };
  return <PreviewClient entries={activity} investmentEntries={entries} transfers={cashTransfers} proposals={proposals} investments={investments} valuations={valuations} members={members} accounts={accounts} accountBalances={accountBalances} fxSnapshot={fxSnapshot} rates={ratesFromSnapshot(fx)}/>;
}
