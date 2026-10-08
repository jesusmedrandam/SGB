import { Router, type Request } from 'express';
import { asyncHandler } from '../../core/async-handler.js';
import { authenticate, requirePermission, requirePropertyContext } from '../auth/auth.middleware.js';
import type { RequestMetadata } from '../auth/auth.types.js';
import {
  catalogItemParamsSchema, catalogItemStateSchema, catalogParamsSchema, createCatalogItemSchema,
} from './catalogs.schemas.js';
import { createCatalogItem, getCatalogReference, listCatalogItems, updateCatalogItem } from './catalogs.service.js';
import {createProduct,listProducts,updateProduct} from '../cleanings/cleanings.service.js';
import {productSchema,productUpdateSchema} from '../cleanings/cleanings.schemas.js';
import {createMedicine,listMedicines,updateMedicine} from '../health/health.service.js';
import {medicineSchema,medicineUpdateSchema,idSchema} from '../health/health.schemas.js';

const metadata = (request: Request): RequestMetadata => ({
  ipAddress: request.ip || null, userAgent: request.header('user-agent')?.slice(0, 1000) ?? null,
});

export const catalogsRouter = Router();
catalogsRouter.use(authenticate, requirePropertyContext);
catalogsRouter.get('/products',requirePermission('CATALOG_VIEW'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await listProducts(request.propertyContext!)});
}));
catalogsRouter.post('/products',requirePermission('CATALOG_MANAGE'),asyncHandler(async(request,response)=>{
  response.status(201).json({ok:true,data:await createProduct(request.auth!,request.propertyContext!,
    productSchema.parse(request.body),metadata(request),'CATALOG_MANAGE')});
}));
catalogsRouter.patch('/products/:id',requirePermission('CATALOG_MANAGE'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await updateProduct(request.auth!,request.propertyContext!,idSchema.parse(request.params).id,
    productUpdateSchema.parse(request.body),metadata(request))});
}));
catalogsRouter.get('/medicines',requirePermission('CATALOG_VIEW'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await listMedicines(request.propertyContext!)});
}));
catalogsRouter.post(['/medicines','/medicines/classification'],requirePermission('CATALOG_MANAGE'),asyncHandler(async(request,response)=>{
  response.status(201).json({ok:true,data:await createMedicine(request.auth!,request.propertyContext!,
    medicineSchema.parse(request.body),metadata(request),'CATALOG_MANAGE')});
}));
catalogsRouter.patch('/medicines/:id',requirePermission('CATALOG_MANAGE'),asyncHandler(async(request,response)=>{
  response.json({ok:true,data:await updateMedicine(request.auth!,request.propertyContext!,idSchema.parse(request.params).id,
    medicineUpdateSchema.parse(request.body),metadata(request))});
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
  const input = catalogItemStateSchema.parse(request.body);
  response.json({ ok: true, data: await updateCatalogItem(
    request.auth!, request.propertyContext!, catalogCode, id, input, metadata(request),
  ) });
}));
