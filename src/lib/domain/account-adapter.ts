import { z } from "zod";
import type { CashTransfer } from "./account-balances";

const integer = z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)]).refine(Number.isSafeInteger);

const cashTransferRow = z.object({
  id: z.string().uuid(),
  amount_minor: integer,
  currency: z.enum(["USD", "CNY", "HKD"]),
  source_account_kind: z.enum(["bank", "brokerage"]),
  destination_account_kind: z.enum(["bank", "brokerage"]),
  destination_amount_minor: integer.nullish(),
  destination_currency: z.enum(["USD", "CNY", "HKD"]).nullish(),
  movement_type: z.enum(["same_currency", "currency_exchange"]).nullish(),
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
    destinationAmountMinor: row.destination_amount_minor ?? undefined,
    destinationCurrency: row.destination_currency ?? undefined,
    movementType: row.movement_type ?? undefined,
    status: row.status,
  };
}
