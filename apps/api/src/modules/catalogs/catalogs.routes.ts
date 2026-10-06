import { Router, type Request } from 'express';
import { asyncHandler } from '../../core/async-handler.js';
import { authenticate, requirePermission, requirePropertyContext } from '../auth/auth.middleware.js';
import type { RequestMetadata } from '../auth/auth.types.js';
import {
  catalogItemParamsSchema, catalogItemStateSchema, catalogParamsSchema, createCatalogItemSchema,
} from './catalogs.schemas.js';
import { createCatalogItem, getCatalogReference, listCatalogItems, setCatalogItemActive } from './catalogs.service.js';
import {createMedicine,listMedicines} from '../health/health.service.js';
import {medicineSchema} from '../health/health.schemas.js';

const metadata = (request: Request): RequestMetadata => ({
  ipAddress: request.ip || null, userAgent: request.header('user-agent')?.slice(0, 1000) ?? null,
});

export const catalogsRouter = Router();
catalogsRouter.use(authenticate, requirePropertyContext);
catalogsRouter.get('/medicines',requirePermission('CATALOG_VIEW'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await listMedicines(request.propertyContext!)});
}));
catalogsRouter.post('/medicines',requirePermission('CATALOG_MANAGE'),asyncHandler(async(request,response)=>{
  response.status(201).json({ok:true,data:await createMedicine(request.auth!,request.propertyContext!,
    medicineSchema.parse(request.body),metadata(request),'CATALOG_MANAGE')});
}));
catalogsRouter.get('/reference', requirePermission('CATALOG_VIEW'), asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await getCatalogReference(request.propertyContext!) });
}));
catalogsRouter.get('/:catalogCode/items', requirePermission('CATALOG_VIEW'), asyncHandler(async (request, response) => {
  const { catalogCode } = catalogParamsSchema.parse(request.params);
  response.json({ ok: true, data: await listCatalogItems(request.propertyContext!, catalogCode) });
}));
catalogsRouter.post('/:catalogCode/items', requirePermission('CATALOG_MANAGE'), asyncHandler(async (request, response) => {
  const { catalogCode } = catalogParamsSchema.parse(request.params);
  const input = createCatalogItemSchema.parse(request.body);
  response.status(201).json({ ok: true, data: await createCatalogItem(
    request.auth!, request.propertyContext!, catalogCode, input, metadata(request),
  ) });
}));
catalogsRouter.patch('/:catalogCode/items/:id', requirePermission('CATALOG_MANAGE'), asyncHandler(async (request, response) => {
  const { catalogCode, id } = catalogItemParamsSchema.parse(request.params);
  const { active } = catalogItemStateSchema.parse(request.body);
  response.json({ ok: true, data: await setCatalogItemActive(
    request.auth!, request.propertyContext!, catalogCode, id, active, metadata(request),
  ) });
}));
