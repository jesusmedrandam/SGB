import { z } from 'zod';
import {pastureConditionsSchema} from './grazing.js';

export const idSchema = z.object({ id: z.uuid() });
const name = z.string().trim().min(1).max(160);
const description = z.string().trim().max(5000).nullable().optional();
const followup={externalPhone:z.string().trim().max(50).nullable().optional(),departedOn:z.iso.date().nullable().optional(),
  expectedReturnOn:z.iso.date().nullable().optional(),externalNotes:z.string().trim().max(2000).nullable().optional()};
export const createGroupSchema = z.strictObject({
  ...followup,name, description,kind:z.enum(['INTERNAL','EXTERNAL']).default('INTERNAL'),locationId:z.uuid().nullable().optional(),
  externalPlace:name.nullable().optional(),externalContact:name.nullable().optional(),
}).refine(value=>value.kind==='EXTERNAL'?Boolean(value.externalPlace)&&!value.locationId:Boolean(value.locationId)&&!value.externalPlace&&!value.externalContact,
  'Selecciona un potrero o corral para el grupo interno, o indica el lugar del grupo externo sin asignar potrero.');
export const updateGroupSchema = z.object({
  ...followup,name, description,externalPlace:name.nullable().optional(),externalContact:name.nullable().optional(), expectedVersion: z.number().int().positive(),
});
export const groupStateSchema = z.object({
  active: z.boolean(), expectedVersion: z.number().int().positive(),locationId:z.uuid().optional(),
});
export const groupLocationSchema = z.object({
  locationId: z.uuid(), expectedVersion: z.number().int().positive(),pastureConditions:pastureConditionsSchema.optional(),
});
const grass = z.object({
  name: name, percent: z.number().min(0).max(100).nullable().optional(),
  catalogItemId:z.uuid().nullable().optional(),
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
