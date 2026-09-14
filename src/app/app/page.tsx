import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ledgerEventFromRow } from "@/lib/domain/ledger-adapter";
import { summarizeLedger } from "@/lib/domain/ledger-summary";
import { calculateInvestmentPosition, latestValuation, valuePosition } from "@/lib/domain/investment-calculations";
import type { Currency } from "@/lib/domain/balance-calculations";
import { fetchAllPages, readConsistentSnapshot } from "@/lib/server/ledger-snapshot";
import AppClient, { type InvestmentSnapshot } from "./app-client";

type Row = Record<string, unknown>;
const LIST_PAGE_SIZE = 100;

export default async function LedgerPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: memberships, error: membershipError } = await supabase.from("household_members").select("household_id, role, households(id,name,reporting_currency)").eq("user_id", user.id).eq("active", true).limit(1);
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

  const { version, snapshot } = await readConsistentSnapshot(readVersion, async () => {
    const [entries, proposals, investments, valuations, members] = await Promise.all([
      fetchAllPages<Row>(async (from, to) => {
        const result = await supabase.from("ledger_entries").select("*").eq("household_id", householdId).eq("status", "posted").order("occurred_at", { ascending: false }).order("effective_sequence", { ascending: false }).range(from, to);
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
    ]);
    return { entries, proposals, investments, valuations, members };
  });

  const events = snapshot.entries.map(ledgerEventFromRow);
  const reportingCurrency = household.reporting_currency as Currency;
  const ledgerSummary = summarizeLedger(events, reportingCurrency);
  const investmentSnapshots = Object.fromEntries(snapshot.investments.map((investment) => {
    const id = String(investment.id);
    try {
      const position = calculateInvestmentPosition(events, id, Number(investment.opening_quantity_milli), Number(investment.opening_cost_minor));
      const latest = latestValuation(snapshot.valuations.filter((value) => value.investment_id === id).map((value) => ({ id: String(value.id), valueDate: String(value.value_date), createdAt: String(value.created_at), unitValueTenThousandths: Number(value.unit_value_1e4 ?? Number(value.unit_value_minor) * 100) })));
      return [id, { position, valuation: valuePosition(position, latest), latestValueDate: latest?.valueDate } satisfies InvestmentSnapshot];
    } catch (error) {
      return [id, { error: error instanceof Error ? error.message : "投资流水需核对" }];
    }
  })) as Record<string, InvestmentSnapshot>;

  return <AppClient
    household={{ id: householdId, name: household.name, reportingCurrency, ledgerVersion: version }}
    userId={user.id}
    role={membership.role}
    entries={snapshot.entries.slice(0, LIST_PAGE_SIZE)}
    proposals={snapshot.proposals}
    investments={snapshot.investments}
    valuations={[]}
    members={snapshot.members}
    ledgerSummary={ledgerSummary}
    postedEntryCount={events.filter((event) => event.status === "posted").length}
    investmentSnapshots={investmentSnapshots}
  />;
}
