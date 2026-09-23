import { Router, type Request } from 'express';
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

export const superadminRouter = Router();

function metadata(request: Request): RequestMetadata {
  return {
    ipAddress: request.ip || null,
    userAgent: request.header('user-agent')?.slice(0, 1000) ?? null,
  };
}

superadminRouter.use(authenticate, requireSuperadmin);

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
