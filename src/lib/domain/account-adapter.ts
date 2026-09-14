import { z } from "zod";
import type { CashTransfer } from "./account-balances";

const integer = z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)]).refine(Number.isSafeInteger);

const cashTransferRow = z.object({
  id: z.string().uuid(),
  amount_minor: integer,
  currency: z.enum(["USD", "CNY", "HKD"]),
  source_account_kind: z.enum(["bank", "brokerage"]),
  destination_account_kind: z.enum(["bank", "brokerage"]),
  status: z.enum(["posted", "voided"]),
});

export function cashTransferFromRow(input: unknown): CashTransfer {
  const row = cashTransferRow.parse(input);
  return {
    id: row.id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    sourceAccountKind: row.source_account_kind,
    destinationAccountKind: row.destination_account_kind,
    status: row.status,
  };
}
