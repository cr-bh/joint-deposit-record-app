export type LedgerFilters = {
  account: string;
  currency: string;
  category: string;
  project: string;
  payment: string;
  payer?: string;
  consumer?: string;
  start?: string;
  end?: string;
};

type SearchValue = string | string[] | undefined;
type LedgerRow = Record<string, unknown>;

export const emptyLedgerFilters: LedgerFilters = { account: "", currency: "", category: "", project: "", payment: "", payer: "", consumer: "", start: "", end: "" };

export function ledgerDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01") return "";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : "";
}

const scalar = (value: SearchValue) => typeof value === "string" ? value : "";

const personFilter = (value: SearchValue) => {
  const text = scalar(value);
  return ["common", "unrecorded"].includes(text) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text) ? text.toLowerCase() : "";
};

export function normalizeLedgerFilters(query: Record<string, SearchValue>): LedgerFilters {
  return {
    account: ["bank", "brokerage"].includes(scalar(query.account)) ? scalar(query.account) : "",
    currency: ["USD", "CNY", "HKD"].includes(scalar(query.currency)) ? scalar(query.currency) : "",
    category: scalar(query.category).trim().slice(0, 30),
    project: scalar(query.project).trim().slice(0, 60),
    payment: ["joint", "member"].includes(scalar(query.payment)) ? scalar(query.payment) : "",
    payer: personFilter(query.payer),
    consumer: personFilter(query.consumer),
    start: ledgerDate(query.start),
    end: ledgerDate(query.end),
  };
}

export function filterLedgerActivity<T extends LedgerRow>(rows: T[], filters: LedgerFilters) {
  return rows.filter((entry) => {
    const consumption = ["expense", "reimbursement", "expense_refund"].includes(String(entry.entry_type));
    const commonPayer = entry.entry_type === "expense" || (entry.entry_type === "expense_refund" && !entry.payer_member_id);
    if (filters.payer === "common" && !commonPayer) return false;
    if (filters.payer === "unrecorded" && !(["deposit", "reimbursement", "member_return"].includes(String(entry.entry_type)) && !entry.payer_member_id)) return false;
    if (filters.payer && !["common", "unrecorded"].includes(filters.payer) && entry.payer_member_id !== filters.payer) return false;
    if (filters.consumer && !consumption) return false;
    if (filters.consumer === "common" && entry.consumer_scope !== "common") return false;
    if (filters.consumer === "unrecorded" && entry.consumer_scope != null) return false;
    if (filters.consumer && !["common", "unrecorded"].includes(filters.consumer) && !(entry.consumer_scope === "member" && entry.consumer_member_id === filters.consumer)) return false;
    if (filters.start && String(entry.occurred_at) < filters.start) return false;
    if (filters.end && String(entry.occurred_at) > filters.end) return false;
    if (filters.account && ![entry.account_kind,entry.source_account_kind,entry.destination_account_kind].includes(filters.account)) return false;
    if (filters.currency && ![entry.currency,entry.destination_currency].includes(filters.currency)) return false;
    if (filters.category && entry.category !== filters.category) return false;
    if (filters.project && entry.project_name !== filters.project) return false;
    if (filters.payment === "joint" && !(entry.entry_type === "expense" || (entry.entry_type === "expense_refund" && !entry.payer_member_id))) return false;
    if (filters.payment === "member" && !(entry.entry_type === "reimbursement" || (entry.entry_type === "expense_refund" && entry.payer_member_id))) return false;
    return true;
  });
}
