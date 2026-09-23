import { z } from 'zod';

export const newPropertySchema = z.object({
  name: z.string().trim().min(2).max(160),
});

export const moduleParamsSchema = z.object({ moduleCode: z.string().regex(/^[A-Z_]{2,60}$/) });
export const moduleStateSchema = z.object({ enabled: z.boolean() });
