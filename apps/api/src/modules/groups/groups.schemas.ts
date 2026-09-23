import { z } from 'zod';

export const idSchema = z.object({ id: z.uuid() });
const name = z.string().trim().min(1).max(160);
const description = z.string().trim().max(5000).nullable().optional();
export const createGroupSchema = z.object({
  name, description, locationId: z.uuid().nullable().optional(),
});
export const updateGroupSchema = z.object({
  name, description, expectedVersion: z.number().int().positive(),
});
export const groupStateSchema = z.object({
  active: z.boolean(), expectedVersion: z.number().int().positive(),
});
export const groupLocationSchema = z.object({
  locationId: z.uuid().nullable(), expectedVersion: z.number().int().positive(),
});
const grass = z.object({
  name: name, percent: z.number().min(0).max(100).nullable().optional(),
  area: z.number().positive().nullable().optional(),
  areaUnitCode: z.string().nullable().optional(),
  sowingDate: z.iso.date().nullable().optional(),
  notes: z.string().trim().max(300).nullable().optional(),
});
const locationDetails = z.object({
  name, description, kind: z.enum(['PASTURE', 'CORRAL']),
  area: z.number().positive().nullable().optional(),
  areaUnitCode: z.string().nullable().optional(),
  pastureUse: z.string().trim().max(80).nullable().optional(),
  capacityEstimate: z.number().int().min(0).nullable().optional(),
  waterAvailable: z.boolean().nullable().optional(),
  lastRestDate: z.iso.date().nullable().optional(),
  floorMaterial: z.string().trim().max(100).nullable().optional(),
  covered: z.boolean().nullable().optional(),
  grasses: z.array(grass).max(30).optional(),
}).superRefine((value, ctx) => {
  if ((value.area == null) !== (value.areaUnitCode == null))
    ctx.addIssue({ code: 'custom', message: 'Indica juntos el área y su unidad.' });
  if (value.kind === 'CORRAL' && (value.pastureUse || value.lastRestDate || value.grasses?.length))
    ctx.addIssue({ code: 'custom', message: 'Los pastos y usos solo corresponden a potreros.' });
  if ((value.grasses ?? []).reduce((sum, entry) => sum + (entry.percent ?? 0), 0) > 100)
    ctx.addIssue({ code: 'custom', message: 'Los porcentajes de pastos no pueden superar el 100%.' });
  if (new Set((value.grasses ?? []).map((entry) => entry.name.toLowerCase())).size !== value.grasses?.length && value.grasses?.length)
    ctx.addIssue({ code: 'custom', message: 'No repitas un pasto en el mismo potrero.' });
});
export const createLocationSchema = locationDetails;
export const updateLocationSchema = locationDetails.safeExtend({ expectedVersion: z.number().int().positive() });
export const assignAnimalSchema = z.object({
  animalId: z.uuid(), expectedAnimalVersion: z.number().int().positive(),
});
