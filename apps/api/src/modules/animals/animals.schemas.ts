import { z } from 'zod';

export const animalIdSchema = z.object({ id: z.uuid() });
export const animalListSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  search: z.string().trim().max(80).default(''),
});

const catalogSelectionSchema = z.object({
  breedId: z.uuid().nullable(),
  colorIds: z.array(z.uuid()).max(12).refine((ids) => new Set(ids).size === ids.length,
    'No se puede seleccionar el mismo color dos veces.'),
});

const brandIdsSchema = z.array(z.uuid()).max(12).refine((ids) => new Set(ids).size === ids.length,
  'No se puede elegir dos veces la misma marquilla.');
export const updateAnimalBrandsSchema = z.object({
  brandIds: brandIdsSchema,
  expectedVersion: z.number().int().positive(),
});

export const updateAnimalCatalogSchema = catalogSelectionSchema.extend({
  expectedVersion: z.number().int().positive(),
});
export type AnimalCatalogSelection = z.infer<typeof catalogSelectionSchema>;

export const createAnimalSchema = z.object({
  name: z.string().trim().min(1).max(160),
  sex: z.enum(['FEMALE', 'MALE']),
  speciesCode: z.literal('BOVINE'),
  earTagCode: z.string().trim().min(1).max(80).optional(),
  birthDate: z.iso.date().optional(),
  entryDate: z.iso.date().optional(),
  initialWeight: z.number().positive().max(999999999).refine(
    (value) => /^\d+(\.\d{1,3})?$/.test(String(value)),
    'El peso admite como máximo tres decimales.',
  ).optional(),
  initialWeightUnitCode: z.string().regex(/^[A-Z_]{2,30}$/).optional(),
  breedId: z.uuid().nullable().optional(),
  colorIds: catalogSelectionSchema.shape.colorIds.optional(),
  brandIds: brandIdsSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.initialWeight === undefined) !== (value.initialWeightUnitCode === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['initialWeight'],
      message: 'Indica juntos el peso y su unidad.' });
  }
});
export type CreateAnimalInput = z.infer<typeof createAnimalSchema>;
