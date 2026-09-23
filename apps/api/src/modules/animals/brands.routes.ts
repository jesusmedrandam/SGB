import { Router, type Request } from 'express';
import { asyncHandler } from '../../core/async-handler.js';
import { authenticate, requirePermission, requirePropertyContext } from '../auth/auth.middleware.js';
import type { RequestMetadata } from '../auth/auth.types.js';
import { brandIdSchema, brandStateSchema, createBrandSchema } from './brands.schemas.js';
import { createBrand, listBrands, setBrandActive } from './brands.service.js';

const metadata = (request: Request): RequestMetadata => ({
  ipAddress: request.ip || null, userAgent: request.header('user-agent')?.slice(0, 1000) ?? null,
});

export const brandsRouter = Router();
brandsRouter.use(authenticate, requirePropertyContext);
brandsRouter.get('/', requirePermission('ANIMAL_VIEW'), asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await listBrands(request.propertyContext!) });
}));
brandsRouter.post('/', requirePermission('CATALOG_MANAGE'), asyncHandler(async (request, response) => {
  const { name } = createBrandSchema.parse(request.body);
  response.status(201).json({ ok: true, data: await createBrand(request.auth!, request.propertyContext!,
    name, metadata(request)) });
}));
brandsRouter.patch('/:id', requirePermission('CATALOG_MANAGE'), asyncHandler(async (request, response) => {
  const { id } = brandIdSchema.parse(request.params);
  const { active } = brandStateSchema.parse(request.body);
  response.json({ ok: true, data: await setBrandActive(request.auth!, request.propertyContext!,
    id, active, metadata(request)) });
}));
