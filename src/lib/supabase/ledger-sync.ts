export type SyncState = "connecting" | "connected" | "reconnecting" | "offline";

/** Realtime is a notification channel, never the source of financial balances. */
export function ledgerSyncController(refresh: () => void, report: (state: SyncState) => void) {
  let disposed = false, online = true, joined = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue = () => {
    if (disposed || !online || timer) return;
    timer = setTimeout(() => { timer = undefined; if (!disposed && online) refresh(); }, 180);
  };
  return {
    changed: queue,
    status(status: string) {
      if (disposed) return;
      joined = status === "SUBSCRIBED";
      report(!online ? "offline" : joined ? "connected" : "reconnecting");
      // The initial join and every rejoin fetch an authoritative snapshot. Events
      // lost while disconnected cannot be reconstructed from the socket alone.
      if (joined) queue();
    },
    connectivity(value: boolean) {
      if (disposed) return;
      online = value;
      report(!online ? "offline" : joined ? "connected" : "reconnecting");
      if (online) queue();
    },
    foreground: queue,
    reconcile: queue,
    dispose() { disposed = true; if (timer) clearTimeout(timer); timer = undefined; },
  };
}

export const householdSyncTables = ["proposals", "ledger_entries", "reimbursement_claims", "settlement_batches", "settlement_allocations", "cash_transfers", "cash_accounts", "fx_rate_snapshots", "spending_categories", "spending_projects", "investments", "investment_valuations", "household_members", "household_archives", "void_requests"] as const;
