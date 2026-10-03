import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Execute the same production domain functions against actual authenticated PostgreSQL RPC output.
async function loadDomain() {
  const directory = await mkdtemp(join(process.cwd(), '.p7-runtime-'));
  try {
    const source = new URL('../src/lib/domain/', import.meta.url);
    for (const file of (await readdir(source)).filter(f => f.endsWith('.ts'))) {
      const compiled = ts.transpileModule(await readFile(new URL(file, source), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
      const resolved = compiled.replace(/from (["'])@\/lib\/domain\/([^"']+)\1/g, 'from "$2.mjs"').replace(/from (["'])(\.\/[^"']+)\1/g, 'from "$2.mjs"').replace(/from (["'])([^./][^"']*\.mjs)\1/g, 'from "./$2"');
      await writeFile(join(directory, file.replace(/\.ts$/, '.mjs')), resolved);
    }
    const names = ['ledger-adapter', 'account-adapter', 'account-balances', 'investment-snapshot', 'overview-summary', 'spending-report', 'settlement-batches', 'fx-rates', 'ledger-filters'];
    const modules = await Promise.all(names.map(n => import(pathToFileURL(join(directory, n + '.mjs')).href)));
    return { directory, ...Object.assign({}, ...modules) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
const normalize = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? (["occurred_at", "value_date"].includes(key) ? value.toISOString().slice(0,10) : value.toISOString()) : typeof value === 'string' && /^(version|amount_minor|quantity_milli|quantity_micro|unit_price_minor|unit_price_1e4|unit_price_1e8|unit_value_minor|unit_value_1e4|unit_value_1e8|claimed_minor|payment_minor|claim_version|opening_quantity_milli|opening_cost_minor|total_value_minor|recovery_original_minor)$/.test(key) ? Number(value) : value]));

export async function testP7({ a, b, c, admin, userA, userB, check }) {
  const domain = await loadDomain();
  try {
    const h = (await a.query("select public.create_household('P7 acceptance','USD') id")).rows[0].id;
    await admin.query("insert into public.household_members(household_id,user_id,role) values($1,$2,'member')", [h, userB]);
    const category = (await a.query("select id,name from public.spending_categories where household_id=$1 and name='旅行'", [h])).rows[0];
    const approve = async payload => {
      const id = (await a.query('select public.submit_proposal($1,$2::jsonb,$3) id', [h, JSON.stringify(payload), randomUUID()])).rows[0].id;
      return (await b.query('select public.decide_proposal($1,true,null) id', [id])).rows[0].id;
    };
    const rate = (cny, date) => ({ type: 'fx_rate_update', currency: 'USD', amountMinor: 0, occurredAt: date, title: 'P7 FX', effectiveAt: date + 'T00:00:00Z', usdToCny: String(cny), usdToHkd: '7.8', sourceNote: 'P7 test' });
    await approve(rate(7.2, '2026-09-01'));
    const investment = (await a.query("select public.create_investment_direct($1,'P7 ETF','P7','ETF','USD','份','test','weekly') id", [h])).rows[0].id;
    const payload = (type, amount, date, extra = {}) => ({ type, amountMinor: amount, currency: 'USD', occurredAt: date, title: type, ...extra });
    let sourceEntry, expenseEntry;
    const payment = async amount => {
      const original = (await a.query('select * from public.reimbursement_claims where source_entry_id=$1', [sourceEntry])).rows[0];
      const batch = (await a.query('select public.submit_settlement_batch($1,$2::jsonb,$3) id', [h, JSON.stringify({ payeeMemberId: userA, accountKind: 'bank', currency: 'USD', occurredAt: '2026-09-12', title: 'P7 payment', allocations: [{ claimId: original.id, amountMinor: amount, expectedVersion: Number(original.version) }] }), randomUUID()])).rows[0].id;
      const proposal = (await a.query('select proposal_id from public.settlement_batches where id=$1', [batch])).rows[0].proposal_id;
      await b.query('select public.decide_proposal($1,true,null)', [proposal]);
    };
    const read = async (filters = {}) => {
      const tables = ['ledger_entries', 'cash_transfers', 'investments', 'investment_valuations', 'reimbursement_claims', 'settlement_allocations', 'settlement_batches', 'proposals', 'fx_rate_snapshots_exact'];
      const rows = {};
      for (const table of tables) rows[table] = (await a.query(`select * from public.${table} where household_id=$1`, [h])).rows.map(normalize);
      const events = rows.ledger_entries.map(domain.ledgerEventFromRow), transfers = rows.cash_transfers.map(domain.cashTransferFromRow);
      const balances = domain.accountCashBalances(events, transfers), snapshots = Object.fromEntries(rows.investments.map(i => [i.id, domain.buildInvestmentSnapshot(events, i, rows.investment_valuations)]));
      const projected = domain.projectReimbursements(rows.reimbursement_claims, rows.settlement_allocations, rows.settlement_batches, rows.proposals, events);
      const fx = rows.fx_rate_snapshots_exact.map(domain.fxRateSnapshotFromRow), current = domain.latestEffectiveFxSnapshot(fx);
      return { balances, overview: domain.buildOverviewSummary(balances, rows.investments, snapshots, projected.claims, 'USD', current, projected.unreviewedPaymentCount), report: domain.buildSpendingReport(events, 'USD', Object.fromEntries(fx.map(f => [f.id, domain.ratesFromSnapshot(f)])), domain.normalizeLedgerFilters(filters)) };
    };
    await check('P7 AC29 real RPC ledger matches every PRD15.1 row through assets/net USD435', async () => {
      const stages = [
        [async () => { await approve(payload('deposit', 30000, '2026-09-01', { payerMemberId: userA, accountKind: 'bank' })); await approve(payload('deposit', 30000, '2026-09-01', { payerMemberId: userB, accountKind: 'bank' })); }, [600, 0, 600, 0, 0, 600, 600]],
        [async () => { expenseEntry = await approve(payload('expense', 10000, '2026-09-02', { accountKind: 'bank', categoryId: category.id, category: category.name })); }, [500, 0, 500, 0, 0, 500, 500]],
        [async () => { sourceEntry = await approve(payload('reimbursement', 12000, '2026-09-03', { payerMemberId: userA, categoryId: category.id, category: category.name })); }, [500, 0, 500, 0, 120, 500, 380]],
        [async () => payment(5000), [450, 0, 450, 0, 70, 450, 380]],
        [async () => approve(payload('account_transfer', 20000, '2026-09-04', { sourceAccountKind: 'bank', destinationAccountKind: 'brokerage' })), [250, 200, 450, 0, 70, 450, 380]],
        [async () => approve(payload('investment_buy', 20000, '2026-09-05', { investmentId: investment, quantityMicro: 20000000 })), [250, 0, 250, 200, 70, 450, 380]],
        [async () => approve(payload('investment_valuation', 0, '2026-09-06', { investmentId: investment, valuationMode: 'unit_price', unitValueHundredMillionths: 1200000000, basis: (await a.query('select public.get_investment_basis($1,$2) basis', [investment, '2026-09-06'])).rows[0].basis })), [250, 0, 250, 240, 70, 490, 420]],
        [async () => approve(payload('investment_sell', 7000, '2026-09-07', { investmentId: investment, quantityMicro: 5000000 })), [250, 70, 320, 180, 70, 500, 430]],
        [async () => approve(payload('dividend', 500, '2026-09-08', { investmentId: investment })), [250, 75, 325, 180, 70, 505, 435]],
        [async () => payment(7000), [180, 75, 255, 180, 0, 435, 435]],
      ];
      for (const [work, expected] of stages) {
        await work(); const { balances, overview } = await read();
        assert.deepEqual([balances.bank.USD, balances.brokerage.USD, overview.cashMinor, overview.investmentMinor, overview.payablesMinor, overview.assetsMinor, overview.netMinor].map(n => n / 100), expected);
      }
      assert.equal((await read()).report.grossMinor, 22000);
    });
    await check('P7 AC30/31 approved refunds remain traceable when period net is negative; repayments never recount spending', async () => {
      for (const [source, amount, recipient] of [[expenseEntry, 2500, 'common'], [sourceEntry, 10000, 'member']]) {
        const id = (await a.query('select public.submit_correction($1,$2::jsonb,$3) id', [h, JSON.stringify({ type: 'expense_refund', sourceEntryId: source, amountMinor: amount, recipient, occurredAt: '2026-09-15', title: 'P7 refund', ...(recipient === 'common' ? { accountKind: 'bank' } : {}) }), randomUUID()])).rows[0].id;
        await b.query('select public.decide_proposal($1,true,null)', [id]);
      }
      const { overview, report } = await read({ start: '2026-09-14', end: '2026-09-16' });
      assert.equal(overview.receivablesMinor, 10000); assert.equal(overview.netMinor, 56000);
      assert.equal(report.grossMinor, 0); assert.equal(report.netMinor, -12500); assert.equal(report.refunds.links.reduce((s, e) => s + e.value, 0), 12500); assert.equal(report.records.length, 2);
      assert.equal((await c.query('select count(*) from public.ledger_entries where household_id=$1', [h])).rows[0].count, '0');
    });
    await check('P7 AC61/68 new FX changes current net only, not historical spending or original allocations', async () => {
      await approve(payload('expense', 72000, '2026-09-16', { currency: 'CNY', accountKind: 'bank', categoryId: category.id, category: category.name }));
      const before = await read(); await approve(rate(8, '2026-09-17')); const after = await read();
      assert.equal(after.overview.netMinor - before.overview.netMinor, 1000); assert.equal(before.report.netMinor, after.report.netMinor); assert.equal(after.report.netMinor, 19500);
      const previousVersion = (await a.query('select ledger_version from public.households where id=$1', [h])).rows[0].ledger_version;
      await admin.query("update public.households set reporting_currency='CNY' where id=$1", [h]);
      assert.equal(BigInt((await a.query('select ledger_version from public.households where id=$1', [h])).rows[0].ledger_version), BigInt(previousVersion) + 1n);
      assert.equal((await a.query("select sum(amount_minor) amount from public.settlement_allocations where household_id=$1 and status='posted'", [h])).rows[0].amount, '12000');
    });
  } finally { await rm(domain.directory, { recursive: true, force: true }); }
}
