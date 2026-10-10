import { z } from 'zod';

export const newPropertySchema = z.object({
  name: z.string().trim().min(2).max(160),
});

export const propertyInformationSchema=newPropertySchema.extend({ownerName:z.string().trim().min(2).max(160),
 areaValue:z.number().positive().max(999999999),
 areaUnitCode:z.enum(['HECTARE','SQUARE_METER']),address:z.string().trim().min(2).max(500)});
export const moduleParamsSchema = z.object({ moduleCode: z.string().regex(/^[A-Z_]{2,60}$/) });
export const moduleStateSchema = z.object({ enabled: z.boolean() });
