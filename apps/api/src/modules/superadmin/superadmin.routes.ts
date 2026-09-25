import { Router, type Request } from 'express';
import {z} from 'zod';
import { asyncHandler } from '../../core/async-handler.js';
import { authenticate, requireSuperadmin } from '../auth/auth.middleware.js';
import type { RequestMetadata } from '../auth/auth.types.js';
import {
  accountParamsSchema,
  accountUpdateSchema,
  moduleParamsSchema,
  moduleUpdateSchema,
  quotaParamsSchema,
  quotaUpdateSchema,
} from './superadmin.schemas.js';
import {
  getAccountDetails,
  getPlatformOverview,
  updateAccount,
  updateAccountModule,
  updateAccountQuota,
} from './superadmin.service.js';
import {listSystemCatalog,saveSystemCatalogItem,systemCatalogCodes,
  updateSystemCatalogItem} from './system-catalog.service.js';

export const superadminRouter = Router();

function metadata(request: Request): RequestMetadata {
  return {
    ipAddress: request.ip || null,
    userAgent: request.header('user-agent')?.slice(0, 1000) ?? null,
  };
}

superadminRouter.use(authenticate, requireSuperadmin);
const catalogParams=z.object({code:z.enum(systemCatalogCodes)});
const catalogItemParams=catalogParams.extend({id:z.uuid()});
const createSystemItem=z.object({name:z.string().trim().min(2).max(160)});
const updateSystemItem=z.object({name:z.string().trim().min(2).max(160).optional(),
  active:z.boolean().optional()}).refine(value=>value.name!==undefined||value.active!==undefined);

superadminRouter.get('/catalogs/:code/items',asyncHandler(async(request,response)=>{
  const {code}=catalogParams.parse(request.params);
  response.json({ok:true,data:await listSystemCatalog(request.auth!,code)});
}));
superadminRouter.post('/catalogs/:code/items',asyncHandler(async(request,response)=>{
  const {code}=catalogParams.parse(request.params);
  response.status(201).json({ok:true,data:await saveSystemCatalogItem(request.auth!,code,
    createSystemItem.parse(request.body),metadata(request))});
}));
superadminRouter.patch('/catalogs/:code/items/:id',asyncHandler(async(request,response)=>{
  const {code,id}=catalogItemParams.parse(request.params);
  response.json({ok:true,data:await updateSystemCatalogItem(request.auth!,code,id,
    updateSystemItem.parse(request.body),metadata(request))});
}));

superadminRouter.get('/overview', asyncHandler(async (request, response) => {
  const data = await getPlatformOverview(request.auth!, metadata(request));
  response.json({ ok: true, data });
}));

superadminRouter.get('/accounts/:accountId', asyncHandler(async (request, response) => {
  const { accountId } = accountParamsSchema.parse(request.params);
  const data = await getAccountDetails(request.auth!, accountId, metadata(request));
  response.json({ ok: true, data });
}));

superadminRouter.patch('/accounts/:accountId', asyncHandler(async (request, response) => {
  const { accountId } = accountParamsSchema.parse(request.params);
  const input = accountUpdateSchema.parse(request.body);
  const data = await updateAccount(request.auth!, accountId, input, metadata(request));
  response.json({ ok: true, data });
}));

superadminRouter.put('/accounts/:accountId/quotas/:quotaCode', asyncHandler(async (request, response) => {
  const { accountId, quotaCode } = quotaParamsSchema.parse(request.params);
  const { limitValue } = quotaUpdateSchema.parse(request.body);
  const data = await updateAccountQuota(request.auth!, accountId, quotaCode, limitValue, metadata(request));
  response.json({ ok: true, data });
}));

superadminRouter.put('/accounts/:accountId/modules/:moduleCode', asyncHandler(async (request, response) => {
  const { accountId, moduleCode } = moduleParamsSchema.parse(request.params);
  const { enabled } = moduleUpdateSchema.parse(request.body);
  const data = await updateAccountModule(request.auth!, accountId, moduleCode, enabled, metadata(request));
  response.json({ ok: true, data });
}));
