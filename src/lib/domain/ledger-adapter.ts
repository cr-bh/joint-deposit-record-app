import { z } from "zod";
import type { LedgerEvent } from "./balance-calculations";

// Database reads are untrusted too: a bad row must not turn into NaN or zero.
const integer = z.number().int().safe();
const ledgerRow = z.object({
  id: z.string().uuid(),
  entry_type: z.enum(["opening_balance", "deposit", "expense", "expense_refund", "reimbursement", "settlement", "investment_buy", "investment_sell", "dividend"]),
  status: z.enum(["posted", "voided"]),
  amount_minor: integer.nonnegative(),
  currency: z.enum(["USD", "CNY", "HKD"]),
  occurred_at: z.string().date(),
  created_at: z.string().datetime({ offset: true }),
  effective_sequence: z.union([z.string().regex(/^\d+$/), integer.nonnegative().transform(String)]).nullish(),
  member_id: z.string().uuid().nullish(),
  submitter_id: z.string().uuid().nullish(),
  payer_member_id: z.string().uuid().nullish(),
  payee_member_id: z.string().uuid().nullish(),
  account_kind: z.enum(["bank", "brokerage"]).nullish(),
  fx_snapshot_id: z.string().uuid().nullish(),
  investment_id: z.string().uuid().nullish(),
  quantity_milli: integer.nullish(),
  unit_price_1e4: integer.nullish(),
  unit_price_minor: integer.nullish(),
  category: z.string().nullish(),
  title: z.string(),
});

export function ledgerEventFromRow(input: unknown): LedgerEvent {
  const row = ledgerRow.parse(input);
  return {
    id: row.id, type: row.entry_type, status: row.status,
    amountMinor: row.amount_minor, currency: row.currency,
    occurredAt: row.occurred_at, createdAt: row.created_at,
    effectiveSequence: row.effective_sequence ?? undefined,
    // Legacy member_id records the submitter, not verified payer/payee facts.
    submitterId: row.submitter_id ?? row.member_id ?? undefined,
    payerMemberId: row.payer_member_id ?? undefined,
    payeeMemberId: row.payee_member_id ?? undefined,
    accountKind: row.account_kind ?? undefined,
    fxSnapshotId: row.fx_snapshot_id ?? undefined,
    investmentId: row.investment_id ?? undefined,
    quantityMilli: row.quantity_milli ?? undefined,
    unitPriceTenThousandths: row.unit_price_1e4 ?? (row.unit_price_minor == null ? undefined : row.unit_price_minor * 100),
    category: row.category ?? undefined, title: row.title,
  };
}
