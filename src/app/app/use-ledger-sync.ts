"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { householdSyncTables, ledgerSyncController, type SyncState } from "@/lib/supabase/ledger-sync";

export function useLedgerSync(householdId: string): SyncState {
  const router = useRouter();
  const [state, setState] = useState<SyncState>("connecting");
  useEffect(() => {
    const client = createClient();
    const sync = ledgerSyncController(() => router.refresh(), setState);
    const channel = client.channel(`household:${householdId}`);
    for (const table of householdSyncTables) channel.on("postgres_changes", { event: "*", schema: "public", table, filter: `household_id=eq.${householdId}` }, sync.changed);
    channel.on("postgres_changes", { event: "*", schema: "public", table: "households", filter: `id=eq.${householdId}` }, sync.changed).subscribe(sync.status);
    const connectivity = () => sync.connectivity(navigator.onLine);
    const foreground = () => { if (document.visibilityState === "visible") sync.foreground(); };
    connectivity();
    window.addEventListener("online", connectivity);
    window.addEventListener("offline", connectivity);
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    // Reconcile even a seemingly healthy socket: browsers can suspend network
    // callbacks during sleep or drop a publication event during recovery.
    const reconciliation = setInterval(foreground, 30_000);
    return () => {
      sync.dispose(); clearInterval(reconciliation);
      window.removeEventListener("online", connectivity); window.removeEventListener("offline", connectivity);
      window.removeEventListener("focus", foreground); document.removeEventListener("visibilitychange", foreground);
      void client.removeChannel(channel);
    };
  }, [householdId, router]);
  return state;
}
