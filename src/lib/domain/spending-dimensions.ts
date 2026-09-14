import { z } from "zod";

const dimensionRow = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  archived_at: z.string().datetime({ offset: true }).nullish(),
  is_system: z.boolean().optional().default(false),
});

export type SpendingDimension = {
  id: string;
  name: string;
  archivedAt?: string;
  isSystem: boolean;
};

export const defaultSpendingCategoryNames = ["日常生活", "餐饮", "居住", "家居", "交通", "旅行", "医疗健康", "礼物", "订阅服务", "宠物", "教育", "其他", "玩乐", "日用", "购物"] as const;

export function spendingDimensionFromRow(input: unknown): SpendingDimension {
  const row = dimensionRow.parse(input);
  return { id: row.id, name: row.name, archivedAt: row.archived_at ?? undefined, isSystem: row.is_system };
}

export function activeSpendingDimensions(dimensions: SpendingDimension[]) {
  return dimensions.filter((dimension) => !dimension.archivedAt);
}
