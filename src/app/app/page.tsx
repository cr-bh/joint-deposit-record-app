import { frozenLedgerSchema } from "@/lib/domain/household-management";
import { buildLedgerRecordStates } from "@/lib/domain/ledger-record-states";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ledgerEventFromRow } from "@/lib/domain/ledger-adapter";
import { cashTransferFromRow } from "@/lib/domain/account-adapter";
import { accountCashBalances, combinedCashBalances } from "@/lib/domain/account-balances";
import { buildOverviewSummary } from "@/lib/domain/overview-summary";
import { buildSpendingReport } from "@/lib/domain/spending-report";
import { summarizeLedger } from "@/lib/domain/ledger-summary";
import { buildInvestmentSnapshot } from "@/lib/domain/investment-snapshot";
import { fxRateSnapshotFromRow, isFxSnapshotStale, latestEffectiveFxSnapshot, ratesFromSnapshot } from "@/lib/domain/fx-rates";
import { spendingDimensionFromRow } from "@/lib/domain/spending-dimensions";
import { filterLedgerActivity, normalizeLedgerFilters } from "@/lib/domain/ledger-filters";
import { projectReimbursements } from "@/lib/domain/settlement-batches";
import type { Currency } from "@/lib/domain/balance-calculations";
import { fetchAllPages, paginateLedgerRows, parseLedgerPage, readConsistentSnapshot } from "@/lib/server/ledger-snapshot";
import AppClient, { type InvestmentSnapshot } from "./app-client";

type Row = Record<string, unknown>;
const LIST_PAGE_SIZE = 100;

type SearchParams = Promise<{ household?: string | string[]; tab?: string | string[]; entry?: string | string[]; batch?: string | string[]; start?: string | string[]; end?: string | string[]; ledgerPage?: string | string[]; account?: string | string[]; currency?: string | string[]; category?: string | string[]; project?: string | string[]; payment?: string | string[] }>;

export default async function LedgerPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  let membershipQuery = supabase.from("household_members").select("household_id, role, households(id,name,reporting_currency)").eq("user_id", user.id).eq("active", true);
  if (typeof query.household === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.household)) membershipQuery = membershipQuery.eq("household_id",query.household);
  const { data: memberships, error: membershipError } = await membershipQuery.order("joined_at",{ascending:false}).limit(1);
  if (membershipError) throw new Error("账本成员资料读取失败，请重试");
  const membership = memberships?.[0];
  if (!membership) redirect("/onboarding");
  const household = Array.isArray(membership.households) ? membership.households[0] : membership.households;
  if (!household) redirect("/onboarding");
  const householdId = membership.household_id;

  const readVersion = async () => {
    const { data, error } = await supabase.from("households").select("ledger_version").eq("id", householdId).single();
    const version = Number((data as Row | null)?.ledger_version);
    if (error || !Number.isSafeInteger(version) || version < 0) throw new Error("账本版本读取失败，请重试");
    return version;
  };

  const { version, snapshot: liveSnapshot } = await readConsistentSnapshot(readVersion, async () => {
    const { data: configuration, error: configurationError } = await supabase.from("households").select("id,name,reporting_currency,time_zone,time_zone_confirmed,status,archived_at,archive_snapshot_id").eq("id", householdId).single();
    if (configurationError || !configuration) throw new Error("账本配置读取失败，请重试");
    const [entries, proposals, investments, valuations, members, accounts, transfers, fxSnapshots, spendingCategories, spendingProjects, reimbursementClaims, settlementAllocations, settlementBatches, voidRequests] = await Promise.all([
      fetchAllPages<Row>(async (from, to) => {
        const result = await supabase.from("ledger_entries").select("*").eq("household_id", householdId).order("occurred_at", { ascending: false }).order("effective_sequence", { ascending: false }).range(from, to);
        return { data: result.data as Row[] | null, error: result.error };
      }),
      fetchAllPages<Row>(async (from, to) => {
        const result = await supabase.from("proposals").select("*").eq("household_id", householdId).order("submitted_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
        return { data: result.data as Row[] | null, error: result.error };
      }),
      fetchAllPages<Row>(async (from, to) => {
        const result = await supabase.from("investments").select("*").eq("household_id", householdId).order("created_at").order("id").range(from, to);
        return { data: result.data as Row[] | null, error: result.error };
      }),
      fetchAllPages<Row>(async (from, to) => {
        const result = await supabase.from("investment_valuations").select("*").eq("household_id", householdId).order("value_date").order("created_at").order("id").range(from, to);
        return { data: result.data as Row[] | null, error: result.error };
      }),
      fetchAllPages<Row>(async (from, to) => {
        const result = await supabase.from("household_members").select("user_id, role, profiles(display_name)").eq("household_id", householdId).eq("active", true).order("user_id").range(from, to);
        return { data: result.data as Row[] | null, error: result.error };
      }),
      fetchAllPages<Row>(async (from, to) => {
        const result = await supabase.from("cash_accounts").select("household_id, kind, name").eq("household_id", householdId).order("kind").range(from, to);
        return { data: result.data as Row[] | null, error: result.error };
      }),
      fetchAllPages<Row>(async (from, to) => {
        const result = await supabase.from("cash_transfers").select("*").eq("household_id", householdId).order("occurred_at", { ascending: false }).order("effective_sequence", { ascending: false }).range(from, to);
        return { data: result.data as Row[] | null, error: result.error };
      }),
      fetchAllPages<Row>(async (from, to) => {
        const result = await supabase.from("fx_rate_snapshots_exact").select("*").eq("household_id", householdId).eq("status", "approved").order("effective_at", { ascending: false }).order("approved_at", { ascending: false }).range(from, to);
        return { data: result.data as Row[] | null, error: result.error };
      }),
      fetchAllPages<Row>(async (from, to) => {
        const result = await supabase.from("spending_categories").select("id,name,archived_at,is_system").eq("household_id", householdId).order("created_at").order("id").range(from, to);
        return { data: result.data as Row[] | null, error: result.error };
      }),
      fetchAllPages<Row>(async (from, to) => {
        const result = await supabase.from("spending_projects").select("id,name,archived_at").eq("household_id", householdId).order("created_at").order("id").range(from, to);
        return { data: result.data as Row[] | null, error: result.error };
      }),
      fetchAllPages<Row>(async (from, to) => {
        const result = await supabase.from("reimbursement_claims").select("*").eq("household_id", householdId).order("created_at", { ascending: false }).order("id").range(from, to);
        return { data: result.data as Row[] | null, error: result.error };
      }),
      fetchAllPages<Row>(async (from, to) => {
        const result = await supabase.from("settlement_allocations").select("*").eq("household_id", householdId).order("created_at").order("id").range(from, to);
        return { data: result.data as Row[] | null, error: result.error };
      }),
      fetchAllPages<Row>(async (from, to) => {
        const result = await supabase.from("settlement_batches").select("*").eq("household_id", householdId).order("created_at", { ascending: false }).order("id").range(from, to);
        return { data: result.data as Row[] | null, error: result.error };
      }),
      fetchAllPages<Row>(async (from, to) => {
        const result = await supabase.from("void_requests").select("*").eq("household_id", householdId).order("created_at").order("id").range(from, to);
        return { data: result.data as Row[] | null, error: result.error };
      }),
    ]);
    return { configuration, entries, proposals, investments, valuations, members, accounts, transfers, fxSnapshots, spendingCategories, spendingProjects, reimbursementClaims, settlementAllocations, settlementBatches, voidRequests };
  });

  let snapshot = liveSnapshot;
  let valuationTime: string | undefined;
  if (liveSnapshot.configuration.status === "archived" && liveSnapshot.configuration.archive_snapshot_id) {
    const { data, error } = await supabase.from("household_archives").select("snapshot").eq("id",liveSnapshot.configuration.archive_snapshot_id).eq("household_id",householdId).single();
    if (error || !data) throw new Error("归档快照读取失败，请重试");
    const frozen = frozenLedgerSchema.parse(data.snapshot);
    valuationTime = frozen.capturedAt;
    const { configuration, capturedAt: _capturedAt, ...rows } = frozen;
    void _capturedAt;
    snapshot = { ...liveSnapshot, ...rows,
      proposals: [...frozen.proposals, ...liveSnapshot.proposals.filter(p => ["household_archive","household_restore"].includes(String((p.payload as Row).type)))],
      configuration: { ...liveSnapshot.configuration, name: configuration.name, reporting_currency: configuration.reporting_currency, time_zone: configuration.time_zone, time_zone_confirmed: configuration.time_zone_confirmed } };
  }

  const events = snapshot.entries.map(ledgerEventFromRow);
  const transfers = snapshot.transfers.map(cashTransferFromRow);
  const accountBalances = accountCashBalances(events, transfers);
  const combinedBalances = combinedCashBalances(accountBalances);
  const reportingCurrency = snapshot.configuration.reporting_currency as Currency;
  const fxSnapshots = snapshot.fxSnapshots.map(fxRateSnapshotFromRow);
  const currentFxSnapshot = latestEffectiveFxSnapshot(fxSnapshots,valuationTime ?? new Date());
  const historicalRates = Object.fromEntries(fxSnapshots.map((fxSnapshot) => [fxSnapshot.id, ratesFromSnapshot(fxSnapshot)]));
  const ledgerSummary = summarizeLedger(events, reportingCurrency, ratesFromSnapshot(currentFxSnapshot), transfers, historicalRates);
  if ((["USD", "CNY", "HKD"] as Currency[]).some((currency) => combinedBalances[currency] !== ledgerSummary.cashByCurrency[currency])) {
    throw new Error("账户现金与共同现金核算不一致，请重试");
  }
  const investmentSnapshots = Object.fromEntries(snapshot.investments.map((investment) => {
    const id = String(investment.id);
    try {
      return [id, buildInvestmentSnapshot(events, investment, snapshot.valuations) satisfies InvestmentSnapshot];
    } catch (error) {
      return [id, { error: error instanceof Error ? error.message : "投资流水需核对" }];
    }
  })) as Record<string, InvestmentSnapshot>;
  const activity: Row[] = [
    ...snapshot.entries,
    ...snapshot.transfers.map((transfer) => ({ ...transfer, entry_type: "account_transfer" }) as Row),
  ].sort((left, right) => {
    const dateOrder = String(right.occurred_at).localeCompare(String(left.occurred_at));
    if (dateOrder) return dateOrder;
    const leftSequence = BigInt(String(left.effective_sequence));
    const rightSequence = BigInt(String(right.effective_sequence));
    return leftSequence < rightSequence ? 1 : leftSequence > rightSequence ? -1 : 0;
  });
  const ledgerFilters = normalizeLedgerFilters(query);
  const filteredActivity = filterLedgerActivity(activity,ledgerFilters).filter(entry => typeof query.entry !== "string" || entry.id === query.entry);
  const ledgerPage = paginateLedgerRows(filteredActivity, parseLedgerPage(query.ledgerPage), LIST_PAGE_SIZE);
  const spendingCategories = snapshot.spendingCategories.map(spendingDimensionFromRow);
  const spendingProjects = snapshot.spendingProjects.map(spendingDimensionFromRow);
  const { claims: reimbursementClaims, batches: settlementBatches, unreviewedPaymentCount } = projectReimbursements(snapshot.reimbursementClaims, snapshot.settlementAllocations, snapshot.settlementBatches, snapshot.proposals, events);

  const overviewSummary = buildOverviewSummary(accountBalances, snapshot.investments, investmentSnapshots, reimbursementClaims, reportingCurrency, currentFxSnapshot, unreviewedPaymentCount, events.filter(e => e.type === "reimbursement" && e.status === "posted" && !reimbursementClaims.some(c => c.sourceEntryId === e.id)).length);
  if (snapshot.configuration.status === "archived" && !snapshot.configuration.archive_snapshot_id) { overviewSummary.assetsMinor = null; overviewSummary.netMinor = null; overviewSummary.issues.push("历史归档缺冻结快照，资产待核对；可申请双人恢复后核对。"); }
  const memberNames = Object.fromEntries(snapshot.members.map(member => {
    const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
    return [String(member.user_id), String((profile as Row | null)?.display_name ?? `成员 ${String(member.user_id).slice(0,8)}`)];
  }));
  const spendingReport = buildSpendingReport(events, reportingCurrency, historicalRates, ledgerFilters, memberNames);

  return <AppClient
    ledgerRecordStates={buildLedgerRecordStates(events, snapshot.proposals, reimbursementClaims, activity.map(row => ({ id: String(row.id), status: String(row.status), proposalId: typeof row.proposal_id === "string" ? row.proposal_id : undefined })))}
    key={`${query.tab ?? "overview"}:${query.entry ?? ""}:${query.batch ?? ""}`}
    household={{ id: householdId, name: snapshot.configuration.name, reportingCurrency, ledgerVersion: version, timeZone: snapshot.configuration.time_zone, timeZoneConfirmed: snapshot.configuration.time_zone_confirmed, status: snapshot.configuration.status, archivedAt: snapshot.configuration.archived_at ?? undefined, hasArchiveSnapshot: Boolean(snapshot.configuration.archive_snapshot_id) }}
    userId={user.id}
    role={membership.role}
    entries={ledgerPage.rows}
    recentEntries={snapshot.entries.filter(entry => entry.status === "posted").sort((a,b) => String(b.occurred_at).localeCompare(String(a.occurred_at)) || String(b.effective_sequence).localeCompare(String(a.effective_sequence),undefined,{numeric:true}) || String(b.id).localeCompare(String(a.id))).slice(0, LIST_PAGE_SIZE)}
    proposals={snapshot.proposals.map(p => ({...p, replacement_proposal_id: snapshot.voidRequests.find(v => v.proposal_id === p.id)?.replacement_proposal_id, replaces_void_proposal_id: snapshot.voidRequests.find(v => v.replacement_proposal_id === p.id)?.proposal_id}))}
    investments={snapshot.investments}
    valuations={snapshot.valuations}
    members={snapshot.members}
    accounts={snapshot.accounts}
    accountBalances={accountBalances}
    fxSnapshot={currentFxSnapshot ? { ...currentFxSnapshot, stale: isFxSnapshotStale(currentFxSnapshot) } : undefined}
    fxSnapshots={fxSnapshots}
    spendingCategories={spendingCategories}
    spendingProjects={spendingProjects}
    reimbursementClaims={reimbursementClaims}
    settlementBatches={settlementBatches}
    unreviewedPaymentCount={unreviewedPaymentCount}
    initialBatchId={typeof query.batch === "string" ? query.batch : undefined}
    overviewSummary={overviewSummary}
    spendingReport={spendingReport}
    ledgerSummary={ledgerSummary}
    postedEntryCount={events.filter((event) => event.status === "posted").length + transfers.filter((transfer) => transfer.status === "posted").length}
    initialTab={query.tab === "ledger" ? "流水" : query.tab === "approvals" ? "审批中心" : query.tab === "investments" ? "投资" : query.tab === "reimbursements" ? "代付与报销" : "总览"}
    ledgerPage={ledgerPage.page}
    ledgerPageCount={ledgerPage.pageCount}
    ledgerTotalEntries={filteredActivity.length}
    ledgerFilters={ledgerFilters}
    investmentSnapshots={investmentSnapshots}
    investmentTransfers={transfers}
  />;
}
