import { z } from 'zod';
export const investmentMetadataSchema = z.object({ name: z.string().trim().min(1).max(120), ticker: z.string().trim().max(30).optional(), assetType: z.string().trim().min(1).max(40), unitName: z.string().trim().min(1).max(20).default('份'), note: z.string().max(500).default(''), valuationCadence: z.enum(['weekly','monthly']).default('weekly') }).strict();
export const investmentCreateSchema = investmentMetadataSchema.extend({householdId: z.string().uuid(), currency: z.enum(['USD','CNY','HKD'])});
