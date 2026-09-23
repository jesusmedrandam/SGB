import { z } from 'zod';

export const accountParamsSchema = z.object({ accountId: z.uuid() });

export const quotaParamsSchema = accountParamsSchema.extend({
  quotaCode: z.string().trim().min(1).max(60).transform((value) => value.toUpperCase()),
});

export const moduleParamsSchema = accountParamsSchema.extend({
  moduleCode: z.string().trim().min(1).max(60).transform((value) => value.toUpperCase()),
});

export const accountUpdateSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
  maxProperties: z.number().int().min(1).max(1000).optional(),
}).refine((value) => value.status !== undefined || value.maxProperties !== undefined, {
  message: 'Incluye al menos un cambio.',
});

export const quotaUpdateSchema = z.object({
  limitValue: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
});

export const moduleUpdateSchema = z.object({ enabled: z.boolean() });

export type AccountUpdateInput = z.infer<typeof accountUpdateSchema>;
