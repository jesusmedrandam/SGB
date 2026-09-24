import { Router, type Request } from 'express';
import { asyncHandler } from '../../core/async-handler.js';
import { authenticate, requirePermission, requirePropertyContext } from '../auth/auth.middleware.js';
import type { RequestMetadata } from '../auth/auth.types.js';
import { animalIdSchema, animalListSchema, createAnimalSchema, updateAnimalBrandsSchema, updateAnimalCatalogSchema, updateAnimalDescriptionSchema, updateAnimalParentsSchema } from './animals.schemas.js';
import { createAnimal, getAnimal, listAnimals, updateAnimalBrands, updateAnimalCatalogs } from './animals.service.js';
import { updateAnimalParents } from './parents.service.js';
import { updateAnimalDescription } from './description.service.js';
import { setAnimalOwners } from './owners.service.js';
import { z } from 'zod';
import {getAnimalSummary,getClassificationPolicy,updateClassificationPolicy}
  from './classification.service.js';

const classificationSchema=z.object({femaleAdultMonths:z.number().int().min(1).max(120),
  maleAdultMonths:z.number().int().min(1).max(120),
  names:z.object({VACA:z.string().trim().min(2).max(80),VACONA:z.string().trim().min(2).max(80),
    TERNERA:z.string().trim().min(2).max(80),TORO:z.string().trim().min(2).max(80),
    TORETE:z.string().trim().min(2).max(80),TERNERO:z.string().trim().min(2).max(80)})});

const metadata = (request: Request): RequestMetadata => ({
  ipAddress: request.ip || null, userAgent: request.header('user-agent')?.slice(0, 1000) ?? null,
});

export const animalsRouter = Router();
animalsRouter.use(authenticate, requirePropertyContext);
animalsRouter.get('/summary',requirePermission('ANIMAL_VIEW'),asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await getAnimalSummary(req.propertyContext!)});
}));
animalsRouter.get('/classification',requirePermission('ANIMAL_VIEW'),asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await getClassificationPolicy(req.propertyContext!)});
}));
animalsRouter.put('/classification',requirePermission('CATALOG_MANAGE'),asyncHandler(async(req,res)=>{
  res.json({ok:true,data:await updateClassificationPolicy(req.auth!,req.propertyContext!,
    classificationSchema.parse(req.body),metadata(req))});
}));
animalsRouter.get('/', requirePermission('ANIMAL_VIEW'), asyncHandler(async (request, response) => {
  const filters = animalListSchema.parse(request.query);
  response.json({ ok: true, data: await listAnimals(request.propertyContext!, filters) });
}));
animalsRouter.get('/:id', requirePermission('ANIMAL_VIEW'), asyncHandler(async (request, response) => {
  const { id } = animalIdSchema.parse(request.params);
  response.json({ ok: true, data: await getAnimal(request.propertyContext!, id) });
}));
animalsRouter.post('/', requirePermission('ANIMAL_CREATE'), asyncHandler(async (request, response) => {
  const input = createAnimalSchema.parse(request.body);
  response.status(201).json({ ok: true, data: await createAnimal(
    request.auth!, request.propertyContext!, input, metadata(request),
  ) });
}));
animalsRouter.patch('/:id/catalogs', requirePermission('ANIMAL_UPDATE'), asyncHandler(async (request, response) => {
  const { id } = animalIdSchema.parse(request.params);
  const { breedId, breedIds, colorIds, expectedVersion } = updateAnimalCatalogSchema.parse(request.body);
  response.json({ ok: true, data: await updateAnimalCatalogs(
    request.auth!, request.propertyContext!, id, { breedId, breedIds, colorIds }, expectedVersion, metadata(request),
  ) });
}));
animalsRouter.patch('/:id/brands', requirePermission('ANIMAL_UPDATE'), asyncHandler(async (request, response) => {
  const { id } = animalIdSchema.parse(request.params);
  const { brandIds, expectedVersion } = updateAnimalBrandsSchema.parse(request.body);
  response.json({ ok: true, data: await updateAnimalBrands(
    request.auth!, request.propertyContext!, id, brandIds, expectedVersion, metadata(request),
  ) });
}));
animalsRouter.patch('/:id/parents', requirePermission('ANIMAL_UPDATE'), asyncHandler(async (request, response) => {
  const { id } = animalIdSchema.parse(request.params);
  const input = updateAnimalParentsSchema.parse(request.body);
  response.json({ ok: true, data: await updateAnimalParents(
    request.auth!, request.propertyContext!, id, input, metadata(request),
  ) });
}));
animalsRouter.patch('/:id/description', requirePermission('ANIMAL_UPDATE'), asyncHandler(async (request, response) => {
  const { id } = animalIdSchema.parse(request.params);
  const input = updateAnimalDescriptionSchema.parse(request.body);
  response.json({ ok: true, data: await updateAnimalDescription(
    request.auth!, request.propertyContext!, id, input, metadata(request),
  ) });
}));

animalsRouter.put('/:id/owners', requirePermission('ANIMAL_UPDATE'), asyncHandler(async (request, response) => {
  const { id } = animalIdSchema.parse(request.params);
  const { owners, expectedVersion } = z.object({ expectedVersion: z.number().int().positive(),
    owners: z.array(z.object({ partyId: z.uuid(), percent: z.number().positive().max(100),
      isPrimary: z.boolean() })).min(1).max(30)
      .refine((entries) => new Set(entries.map((entry) => entry.partyId)).size === entries.length)
      .refine((entries) => entries.filter((entry) => entry.isPrimary).length === 1)
      .refine((entries) => Math.abs(entries.reduce((sum, entry) => sum + entry.percent, 0) - 100) < 0.001),
  }).parse(request.body);
  response.json({ ok: true, data: await setAnimalOwners(request.auth!, request.propertyContext!,
    id, owners, expectedVersion, metadata(request)) });
}));
