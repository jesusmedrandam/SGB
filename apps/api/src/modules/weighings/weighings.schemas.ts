import {z} from 'zod';

export const weighingIdSchema=z.object({id:z.uuid()});
export const weighingListSchema=z.object({animalId:z.uuid().optional()});
export const weighingInputSchema=z.strictObject({
  animalId:z.uuid(),
  weighedOn:z.iso.date(),
  weight:z.number().positive().max(999999999.999),
  unitCode:z.enum(['KILOGRAM','POUND']),
  method:z.string().trim().max(160).nullable(),
  notes:z.string().trim().max(3000).nullable(),
  expectedVersion:z.number().int().positive().optional(),
});
export type WeighingInput=z.infer<typeof weighingInputSchema>;
export const weighingVersionSchema=z.strictObject({expectedVersion:z.number().int().positive()});
