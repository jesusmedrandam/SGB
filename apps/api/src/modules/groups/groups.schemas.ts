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
export const createLocationSchema = z.object({
  name, description, kind: z.enum(['PASTURE', 'CORRAL']),
});
export const assignAnimalSchema = z.object({
  animalId: z.uuid(), expectedAnimalVersion: z.number().int().positive(),
});
