import { describe, expect, it } from "vitest";
import { accountCashBalances, combinedCashBalances, type CashTransfer } from "@/lib/domain/account-balances";
import { calculateInvestmentPosition } from "@/lib/domain/investment-calculations";
import { type Currency, type LedgerEvent } from "@/lib/domain/balance-calculations";
import { fetchAllPages } from "@/lib/server/ledger-snapshot";
import { buildSpendingReport } from "@/lib/domain/spending-report";
import { projectReimbursements } from "@/lib/domain/settlement-batches";
import { normalizeLedgerFilters } from "@/lib/domain/ledger-filters";

function random(seed: number) { let s = seed; return (max: number) => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) % max; }; }
function sample(seed: number, count: number) {
  const rng = random(seed), events: LedgerEvent[] = [], transfers: CashTransfer[] = [];
  const balance = { bank: { USD: 0, CNY: 0, HKD: 0 }, brokerage: { USD: 0, CNY: 0, HKD: 0 } };
  let quantity = 0, cost = 0, realized = 0, dividend = 0, spending = 0;
  for (let n = 0; n < count; n++) {
    const currency = (["USD", "CNY", "HKD"] as Currency[])[rng(3)], amount = rng(100_000) + 1;
    const e: LedgerEvent = { id: `${seed}-${n}`, occurredAt: "2026-09-01", effectiveSequence: String(n + 1), type: "deposit", status: "posted", amountMinor: amount, currency, accountKind: "bank" };
    switch (rng(7)) {
      case 0: balance.bank[currency] += amount; events.push(e); break;
      case 1: e.type = "expense"; balance.bank[currency] -= amount; if (currency === "USD") spending += amount; events.push(e); break;
      case 2: {
        const q = rng(2_000_000) + 1; e.type = "investment_buy"; e.currency = "USD"; e.accountKind = "brokerage"; e.investmentId = "fund"; e.quantityMicro = q;
        quantity += q; cost += amount; balance.brokerage.USD -= amount; events.push(e); break;
      }
      case 3: {
        if (!quantity) break;
        const q = rng(quantity) + 1;
        // Independent integer reference, including final-lot residual costs.
        const carried = Number((2n * BigInt(cost) * BigInt(q) + BigInt(quantity)) / (2n * BigInt(quantity)));
        quantity -= q; cost -= carried; realized += amount - carried;
        e.type = "investment_sell"; e.currency = "USD"; e.accountKind = "brokerage"; e.investmentId = "fund"; e.quantityMicro = q;
        balance.brokerage.USD += amount; events.push(e); break;
      }
      case 4: e.type = "dividend"; e.currency = "USD"; e.accountKind = "brokerage"; e.investmentId = "fund"; balance.brokerage.USD += amount; dividend += amount; events.push(e); break;
      case 5: balance.bank[currency] -= amount; balance.brokerage[currency] += amount; transfers.push({ id: e.id, occurredAt: e.occurredAt, currency, amountMinor: amount, sourceAccountKind: "bank", destinationAccountKind: "brokerage", status: "posted" }); break;
      case 6: e.status = "voided"; events.push(e); break;
    }
  }
  return { events, transfers, balance, position: { quantityMicro: quantity, quantityMilli: quantity / 1000, remainingCostMinor: cost, realizedGainMinor: realized, dividendMinor: dividend }, spending };
}

describe("AC-77 reproducible valid financial histories", () => {
  it("100 seeded histories preserve cash, nonnegative cost/holdings and results under arbitrary display order", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const data = sample(seed, 200), shuffled = [...data.events].sort((a, b) => a.id.localeCompare(b.id));
      expect(accountCashBalances(shuffled, [...data.transfers].reverse()), `seed ${seed}`).toEqual(data.balance);
      expect(calculateInvestmentPosition(shuffled, "fund"), `seed ${seed}`).toEqual(data.position);
      expect(data.position.remainingCostMinor).toBeGreaterThanOrEqual(0); expect(data.position.quantityMicro).toBeGreaterThanOrEqual(0);
      expect(combinedCashBalances(accountCashBalances([], data.transfers))).toEqual({ USD: 0, CNY: 0, HKD: 0 });
    }
  });
  it("random partial payments and reservations never double count original debt or exceed quota", () => {
    const rng=random(80477), id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`, at="2026-09-01T12:00:00Z";
    const claims: Record<string,unknown>[]=[],allocations:Record<string,unknown>[]=[],batches:Record<string,unknown>[]=[],proposals:Record<string,unknown>[]=[],events:LedgerEvent[]=[],expected=new Map<string,{remainingMinor:number;availableMinor:number;reservedMinor:number}>();
    for(let n=0;n<200;n++) {
      const claimant=id(1+rng(2)),currency=(["USD","CNY","HKD"] as Currency[])[rng(3)], original=rng(100000)+1, claimId=id(1000+n),sourceId=id(2000+n);
      claims.push({id:claimId,source_entry_id:sourceId,claimant_id:claimant,currency,claimed_minor:original,status:"open",version:1,created_at:at});
      events.push({id:sourceId,type:"reimbursement",currency,amountMinor:original,payerMemberId:claimant,status:"posted",occurredAt:"2026-09-01"});
      let posted=0,reserved=0;
      for(let step=0;step<3;step++) {
        const available=original-posted-reserved;if(!available)break;
        const amount=rng(available)+1, state=(["posted","reserved","released"] as const)[rng(3)], entryId=state==="posted"?id(3000+n*3+step):null, proposalId=id(4000+n*3+step),batchId=id(5000+n*3+step);
        if(state==="posted")posted+=amount;if(state==="reserved")reserved+=amount;
        if(entryId)events.push({id:entryId,type:"settlement",currency,amountMinor:amount,payeeMemberId:claimant,accountKind:"bank",status:"posted",occurredAt:"2026-09-02"});
        proposals.push({id:proposalId,submitter_id:id(1),status:state==="posted"?"approved":state==="reserved"?"pending_approval":"withdrawn",payload:{title:"Random payment",occurredAt:"2026-09-02"}});
        batches.push({id:batchId,proposal_id:proposalId,claimant_id:claimant,account_kind:"bank",currency,amount_minor:amount,status:state,fx_snapshot_id:null,ledger_entry_id:entryId,created_at:at});
        allocations.push({id:id(6000+n*3+step),household_id:id(9000),batch_id:batchId,claim_id:claimId,settlement_entry_id:entryId,amount_minor:amount,payment_minor:amount,claim_version:1,status:state,created_at:at});
      }
      expected.set(claimId,{remainingMinor:original-posted,availableMinor:original-posted-reserved,reservedMinor:reserved});
    }
    const projection=projectReimbursements(claims.reverse(),allocations.reverse(),batches.reverse(),proposals.reverse(),events.reverse());
    expect(projection.unreviewedPaymentCount).toBe(0);
    for(const claim of projection.claims) {expect(claim).toMatchObject(expected.get(claim.id)!);expect(claim.availableMinor).toBeGreaterThanOrEqual(0);}
  });
  it("10,000 rows reconcile across different page sizes, without chart/list truncation", async () => {
    const data = sample(20261004, 14_000);
    const events = data.events.slice(0, 10_000);
    expect(events).toHaveLength(10_000);
    const reference = accountCashBalances(events, data.transfers);
    const position = calculateInvestmentPosition(events, "fund");
    for (const size of [97, 500, 1000]) {
      const paged = await fetchAllPages(async (from, to) => ({ data: events.slice(from, to + 1), error: null }), size);
      expect(accountCashBalances(paged.reverse(), data.transfers)).toEqual(reference);
      expect(calculateInvestmentPosition(paged, "fund")).toEqual(position);
    }
    const report = buildSpendingReport(events.filter(e => e.currency === "USD"), "USD", {}, normalizeLedgerFilters({ start: "2026-09-01", end: "2026-09-01" }));
    const expenses = events.filter(e => e.currency === "USD" && e.type === "expense" && e.status === "posted");
    expect(report.grossMinor).toBe(expenses.reduce((s, e) => s + e.amountMinor, 0));
    expect(report.records).toHaveLength(expenses.length);
  });
});
