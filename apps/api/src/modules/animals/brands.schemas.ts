import { z } from 'zod';

export const brandIdSchema = z.object({ id: z.uuid() });
export const createBrandSchema = z.object({ name: z.string().trim().min(1).max(160) });
export const brandStateSchema = z.object({ active: z.boolean() });
