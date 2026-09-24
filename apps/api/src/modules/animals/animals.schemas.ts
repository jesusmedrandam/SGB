import { z } from 'zod';

export const animalIdSchema = z.object({ id: z.uuid() });
export const updateAnimalDescriptionSchema = z.object({
  description: z.string().trim().max(5000).nullable(),
  expectedVersion: z.number().int().positive(),
});
export const animalListSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  search: z.string().trim().max(80).default(''),
  classification:z.enum(['VACA','VACONA','TERNERA','TORO','TORETE','TERNERO']).optional(),
  sex:z.enum(['FEMALE','MALE']).optional(),
  status:z.enum(['ACTIVE','INACTIVE','DEAD','MISSING']).optional(),
  groupId:z.uuid().optional(),locationId:z.uuid().optional(),ownerId:z.uuid().optional(),
  breedId:z.uuid().optional(),colorId:z.uuid().optional(),brandId:z.uuid().optional(),
  birthFrom:z.iso.date().optional(),birthTo:z.iso.date().optional(),
}).refine(value=>!value.birthFrom||!value.birthTo||value.birthFrom<=value.birthTo,
  {message:'La fecha inicial debe ser anterior a la fecha final.',path:['birthTo']});

const catalogSelectionSchema = z.object({
  breedId: z.uuid().nullable().optional(),
  breedIds: z.array(z.uuid()).max(12).refine((ids) => new Set(ids).size === ids.length).optional(),
  colorIds: z.array(z.uuid()).max(12).refine((ids) => new Set(ids).size === ids.length,
    'No se puede seleccionar el mismo color dos veces.'),
});

const ownerEntriesSchema = z.array(z.object({ partyId: z.uuid(),
  percent: z.number().positive().max(100), isPrimary: z.boolean() })).min(1).max(30)
  .refine((entries) => new Set(entries.map((entry) => entry.partyId)).size === entries.length)
  .refine((entries) => entries.filter((entry) => entry.isPrimary).length === 1)
  .refine((entries) => Math.abs(entries.reduce((sum, entry) => sum + entry.percent, 0) - 100) < 0.001);

const brandIdsSchema = z.array(z.uuid()).max(12).refine((ids) => new Set(ids).size === ids.length,
  'No se puede elegir dos veces la misma marquilla.');
export const updateAnimalBrandsSchema = z.object({
  brandIds: brandIdsSchema,
  expectedVersion: z.number().int().positive(),
});

const parentSchema = z.union([
  z.strictObject({ animalId: z.uuid() }),
  z.strictObject({ reportedName: z.string().trim().min(1).max(160) }),
]).nullable();
export const updateAnimalParentsSchema = z.object({
  mother: parentSchema,
  father: parentSchema,
  expectedVersion: z.number().int().positive(),
});
export type ParentSelection = z.infer<typeof parentSchema>;

export const updateAnimalCatalogSchema = catalogSelectionSchema.extend({
  expectedVersion: z.number().int().positive(),
});
export type AnimalCatalogSelection = z.infer<typeof catalogSelectionSchema>;

export const createAnimalSchema = z.object({
  groupId: z.uuid().optional(),
  mother: parentSchema.optional(),
  father: parentSchema.optional(),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(5000).nullable().optional(),
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
  breedIds: catalogSelectionSchema.shape.breedIds,
  colorIds: catalogSelectionSchema.shape.colorIds.optional(),
  brandIds: brandIdsSchema.optional(),
  owners: ownerEntriesSchema.optional(),
}).superRefine((value, ctx) => {
  if (!value.groupId) ctx.addIssue({ code: 'custom', path: ['groupId'],
    message: 'Selecciona un grupo para el animal.' });
  if ((value.initialWeight === undefined) !== (value.initialWeightUnitCode === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['initialWeight'],
      message: 'Indica juntos el peso y su unidad.' });
  }
});
export type CreateAnimalInput = z.infer<typeof createAnimalSchema>;
