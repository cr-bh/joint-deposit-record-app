import { z } from "zod";
import type { FxRates } from "./balance-calculations";

const numeric = z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number)]).refine((value) => Number.isFinite(value) && value > 0);

const snapshotRow = z.object({
  id: z.string().uuid(),
  usd_to_cny: numeric,
  usd_to_hkd: numeric,
  effective_at: z.string().datetime({ offset: true }),
  source_note: z.string().min(1),
  created_by: z.string().uuid(),
  approved_by: z.string().uuid(),
  approved_at: z.string().datetime({ offset: true }),
});

export type FxRateSnapshot = {
  id: string;
  usdToCny: number;
  usdToHkd: number;
  effectiveAt: string;
  sourceNote: string;
  createdBy: string;
  approvedBy: string;
  approvedAt: string;
};

export function fxRateSnapshotFromRow(input: unknown): FxRateSnapshot {
  const row = snapshotRow.parse(input);
  return {
    id: row.id,
    usdToCny: row.usd_to_cny,
    usdToHkd: row.usd_to_hkd,
    effectiveAt: row.effective_at,
    sourceNote: row.source_note,
    createdBy: row.created_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  };
}

export function latestEffectiveFxSnapshot(snapshots: FxRateSnapshot[], at: string | Date = new Date()) {
  const cutoff = new Date(at).getTime();
  if (!Number.isFinite(cutoff)) throw new Error("汇率查询时间无效");
  return snapshots.filter((snapshot) => new Date(snapshot.effectiveAt).getTime() <= cutoff).sort((left, right) =>
    left.effectiveAt.localeCompare(right.effectiveAt) || left.approvedAt.localeCompare(right.approvedAt) || left.id.localeCompare(right.id)
  ).at(-1);
}

export function ratesFromSnapshot(snapshot?: FxRateSnapshot): Partial<FxRates> {
  return snapshot ? { USD: 1, CNY: snapshot.usdToCny, HKD: snapshot.usdToHkd } : { USD: 1 };
}

export function isFxSnapshotStale(snapshot: FxRateSnapshot, at: string | Date = new Date(), hours = 24) {
  const current = new Date(at).getTime();
  const approved = new Date(snapshot.approvedAt).getTime();
  if (![current, approved].every(Number.isFinite) || !Number.isFinite(hours) || hours <= 0) throw new Error("汇率时效参数无效");
  return current - approved > hours * 60 * 60 * 1000;
}
