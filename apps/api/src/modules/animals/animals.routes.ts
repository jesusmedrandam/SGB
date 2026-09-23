import { Router, type Request } from 'express';
import { asyncHandler } from '../../core/async-handler.js';
import { authenticate, requirePermission, requirePropertyContext } from '../auth/auth.middleware.js';
import type { RequestMetadata } from '../auth/auth.types.js';
import { animalIdSchema, animalListSchema, createAnimalSchema, updateAnimalBrandsSchema, updateAnimalCatalogSchema, updateAnimalParentsSchema } from './animals.schemas.js';
import { createAnimal, getAnimal, listAnimals, updateAnimalBrands, updateAnimalCatalogs } from './animals.service.js';
import { updateAnimalParents } from './parents.service.js';

const metadata = (request: Request): RequestMetadata => ({
  ipAddress: request.ip || null, userAgent: request.header('user-agent')?.slice(0, 1000) ?? null,
});

export const animalsRouter = Router();
animalsRouter.use(authenticate, requirePropertyContext);
animalsRouter.get('/', requirePermission('ANIMAL_VIEW'), asyncHandler(async (request, response) => {
  const { page, search } = animalListSchema.parse(request.query);
  response.json({ ok: true, data: await listAnimals(request.propertyContext!, page, search) });
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
  const { breedId, colorIds, expectedVersion } = updateAnimalCatalogSchema.parse(request.body);
  response.json({ ok: true, data: await updateAnimalCatalogs(
    request.auth!, request.propertyContext!, id, { breedId, colorIds }, expectedVersion, metadata(request),
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
