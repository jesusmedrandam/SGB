import { z } from 'zod';

export const brandIdSchema = z.object({ id: z.uuid() });
export const createBrandSchema = z.object({ name: z.string().trim().min(1).max(160),
  ownerIds: z.array(z.uuid()).min(1).max(30)
    .refine((ids) => new Set(ids).size === ids.length).optional() });
export const brandStateSchema = z.object({ active: z.boolean() });
