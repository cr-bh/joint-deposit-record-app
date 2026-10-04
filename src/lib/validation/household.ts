import { z } from "zod";
import { isLedgerTimeZone } from "../domain/ledger-time";
export const timeZoneSchema = z.string().max(80).refine(isLedgerTimeZone, "请选择有效的 IANA 时区，例如 Asia/Shanghai");
export const householdCreateSchema = z.object({ name: z.string().trim().min(1).max(80), reportingCurrency: z.enum(["USD", "CNY", "HKD"]).default("USD"), timeZone: timeZoneSchema }).strict();
export const householdTimeZoneSchema = z.object({ householdId: z.string().uuid(), timeZone: timeZoneSchema }).strict();

export const householdOnboardingSchema = householdCreateSchema.extend({ idempotencyKey: z.string().uuid() }).strict();
