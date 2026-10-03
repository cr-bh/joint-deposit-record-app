import {z} from 'zod';
const money=z.number().int().positive().max(9_999_999_999),uuid=z.string().uuid();
const common={title:z.string().trim().min(1).max(160),occurredAt:z.string().date()};
export const correctionSchema=z.discriminatedUnion('type',[
 z.object({...common,type:z.literal('expense_refund'),sourceEntryId:uuid,recipient:z.enum(['member','common']),amountMinor:money,accountKind:z.enum(['bank','brokerage']).optional()}).strict(),
 z.object({...common,type:z.literal('member_return'),claimId:uuid,originalAmountMinor:money,expectedVersion:z.number().int().positive().safe(),currency:z.enum(['USD','CNY','HKD']),accountKind:z.enum(['bank','brokerage'])}).strict(),
 z.object({type:z.literal('void_record'),targetKind:z.enum(['entry','transfer','valuation']),targetId:uuid,reason:z.string().trim().min(1).max(500),replacementPayload:z.record(z.unknown()).optional()}).strict(),
]).superRefine((v,c)=>{if(v.type==='expense_refund'&&((v.recipient==='common')!==Boolean(v.accountKind)))c.addIssue({code:'custom',message:'共同退款需选择账户；个人退款不进入共同账户'});});
export const correctionRequestSchema=z.object({householdId:uuid,idempotencyKey:uuid,payload:correctionSchema}).strict();
