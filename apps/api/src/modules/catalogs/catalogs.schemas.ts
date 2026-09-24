import { z } from 'zod';

export const catalogCodeSchema = z.enum(['BREEDS', 'COLORS', 'GRASS_TYPES',
  'HEALTH_CONDITION_TYPES', 'AGROCHEMICAL_CATEGORIES', 'MEDIA_TAGS',
  'MOVEMENT_REASONS', 'TREATMENT_TYPES']);
export type EditableCatalogCode = z.infer<typeof catalogCodeSchema>;
export const catalogParamsSchema = z.object({ catalogCode: catalogCodeSchema });
export const catalogItemParamsSchema = catalogParamsSchema.extend({ id: z.uuid() });
export const createCatalogItemSchema = z.object({
  name: z.string().trim().min(2).max(160),
  speciesCode: z.literal('BOVINE').nullable().optional(),
});
export const catalogItemStateSchema = z.object({ active: z.boolean() });
