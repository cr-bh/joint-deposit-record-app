import { z } from "zod";
import { ledgerEventFromRow } from "./ledger-adapter";
import { cashTransferFromRow } from "./account-adapter";
import { accountCashBalances } from "./account-balances";
import { buildInvestmentSnapshot } from "./investment-snapshot";
import { fxRateSnapshotFromRow, latestEffectiveFxSnapshot } from "./fx-rates";
import { projectReimbursements } from "./settlement-batches";
import { buildOverviewSummary } from "./overview-summary";

const rows = z.array(z.record(z.unknown()));
export const frozenLedgerSchema = z.object({
  configuration: z.object({ name: z.string(), reporting_currency: z.enum(["USD","CNY","HKD"]), time_zone: z.string(), time_zone_confirmed: z.boolean(), status: z.enum(["active","archived"]), archived_at: z.string().nullable().optional() }).passthrough(),
  capturedAt: z.string().datetime({ offset: true }), currentFxId: z.string().uuid().nullable(),
  entries: rows, proposals: rows, investments: rows, valuations: rows, members: rows, accounts: rows, transfers: rows, fxSnapshots: rows,
  spendingCategories: rows, spendingProjects: rows, reimbursementClaims: rows, settlementAllocations: rows, settlementBatches: rows, voidRequests: rows,
});
export const managementPlanSchema = z.object({ status: z.enum(["active","archived"]), version: z.number().int().safe().nonnegative(), snapshot: frozenLedgerSchema,
  blockers: z.array(z.string()), migrationIssues: rows, pendingCount: z.number().int().nonnegative(), reservationCount: z.number().int().nonnegative(), archivedAt: z.string().nullable() });
export type ManagementPlan = z.infer<typeof managementPlanSchema>;

export function managementOverview(input: unknown) {
  const data = frozenLedgerSchema.parse(input), events = data.entries.map(ledgerEventFromRow);
  const balances = accountCashBalances(events,data.transfers.map(cashTransferFromRow));
  const investments = Object.fromEntries(data.investments.map(investment => {
    try { return [String(investment.id), buildInvestmentSnapshot(events,investment,data.valuations)]; }
    catch (error) { return [String(investment.id), { error: error instanceof Error ? error.message : "持仓待核对" }]; }
  }));
  const { claims, unreviewedPaymentCount } = projectReimbursements(data.reimbursementClaims,data.settlementAllocations,data.settlementBatches,data.proposals,events);
  const fx = latestEffectiveFxSnapshot(data.fxSnapshots.map(fxRateSnapshotFromRow),data.capturedAt);
  const summary = buildOverviewSummary(balances,data.investments,investments,claims,data.configuration.reporting_currency,fx,unreviewedPaymentCount,events.filter(e => e.type === "reimbursement" && e.status === "posted" && !claims.some(c => c.sourceEntryId === e.id)).length);
  if (data.configuration.status === "archived" && !data.configuration.archive_snapshot_id) {
    summary.assetsMinor = null; summary.netMinor = null;
    summary.issues.push("历史归档缺冻结快照，资产待核对；双人恢复后再核对。");
  }
  return { balances, ...summary };
}
