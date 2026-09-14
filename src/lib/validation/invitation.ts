import { z } from "zod";

export const householdIdSchema = z.string().uuid();
export const invitationCreateSchema = z.object({ email: z.string().trim().email().max(254) }).strict();
export const invitationAcceptSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
