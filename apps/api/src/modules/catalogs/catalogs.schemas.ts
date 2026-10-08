import { z } from 'zod';

export const catalogCodeSchema = z.enum(['BREEDS', 'COLORS', 'GRASS_TYPES',
  'HEALTH_CONDITION_TYPES', 'AGROCHEMICAL_CATEGORIES', 'MEDIA_TAGS',
  'MOVEMENT_REASONS', 'TREATMENT_TYPES', 'ADMINISTRATION_ROUTES', 'BUYERS', 'SALE_PRODUCTS']);
export type EditableCatalogCode = z.infer<typeof catalogCodeSchema>;
export const catalogParamsSchema = z.object({ catalogCode: catalogCodeSchema });
export const catalogItemParamsSchema = catalogParamsSchema.extend({ id: z.uuid() });
export const createCatalogItemSchema = z.object({
  name: z.string().trim().min(2).max(160),
  speciesCode: z.literal('BOVINE').nullable().optional(),
});
export const catalogItemStateSchema = z.object({active:z.boolean().optional(),
  name:z.string().trim().min(2).max(160).optional(),expectedVersion:z.number().int().positive().optional()})
  .refine(value=>value.active!==undefined||value.name!==undefined,'Indica los cambios de la opción.')
  .refine(value=>value.name===undefined||value.expectedVersion!==undefined,'Actualiza la opción antes de editar su nombre.');
