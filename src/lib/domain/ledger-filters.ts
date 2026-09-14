export type LedgerFilters = {
  account: string;
  currency: string;
  category: string;
  project: string;
  payment: string;
};

type SearchValue = string | string[] | undefined;
type LedgerRow = Record<string, unknown>;

export const emptyLedgerFilters: LedgerFilters = { account: "", currency: "", category: "", project: "", payment: "" };

const scalar = (value: SearchValue) => typeof value === "string" ? value : "";

export function normalizeLedgerFilters(query: Record<string, SearchValue>): LedgerFilters {
  return {
    account: ["bank", "brokerage"].includes(scalar(query.account)) ? scalar(query.account) : "",
    currency: ["USD", "CNY", "HKD"].includes(scalar(query.currency)) ? scalar(query.currency) : "",
    category: scalar(query.category).trim().slice(0, 30),
    project: scalar(query.project).trim().slice(0, 60),
    payment: ["joint", "member"].includes(scalar(query.payment)) ? scalar(query.payment) : "",
  };
}

export function filterLedgerActivity<T extends LedgerRow>(rows: T[], filters: LedgerFilters) {
  return rows.filter((entry) => {
    if (filters.account && ![entry.account_kind,entry.source_account_kind,entry.destination_account_kind].includes(filters.account)) return false;
    if (filters.currency && ![entry.currency,entry.destination_currency].includes(filters.currency)) return false;
    if (filters.category && entry.category !== filters.category) return false;
    if (filters.project && entry.project_name !== filters.project) return false;
    if (filters.payment === "joint" && !["expense","expense_refund"].includes(String(entry.entry_type))) return false;
    if (filters.payment === "member" && entry.entry_type !== "reimbursement") return false;
    return true;
  });
}
