import { Router, type Request } from 'express';
import { asyncHandler } from '../../core/async-handler.js';
import { authenticate, requirePermission, requirePropertyContext } from '../auth/auth.middleware.js';
import type { RequestMetadata } from '../auth/auth.types.js';
import { moduleParamsSchema, moduleStateSchema, newPropertySchema } from './properties.schemas.js';
import {
  createAccountProperty,
  createOwnAccount,
  getPropertySettings,
  updatePropertyModule,
} from './properties.service.js';

function metadata(request: Request): RequestMetadata {
  return { ipAddress: request.ip || null, userAgent: request.header('user-agent')?.slice(0, 1000) ?? null };
}

export const ownAccountRouter = Router();
ownAccountRouter.post('/', authenticate, asyncHandler(async (request, response) => {
  const { name } = newPropertySchema.parse(request.body);
  response.status(201).json({ ok: true, data: await createOwnAccount(request.auth!, name, metadata(request)) });
}));

export const propertySettingsRouter = Router();
propertySettingsRouter.use(authenticate, requirePropertyContext);

propertySettingsRouter.get('/', requirePermission('MODULE_VIEW'), asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await getPropertySettings(request.propertyContext!) });
}));

propertySettingsRouter.post('/properties', requirePermission('PROPERTY_CREATE'), asyncHandler(async (request, response) => {
  const { name } = newPropertySchema.parse(request.body);
  response.status(201).json({ ok: true, data: await createAccountProperty(
    request.auth!, request.propertyContext!, name, metadata(request),
  ) });
}));

propertySettingsRouter.put('/modules/:moduleCode', requirePermission('MODULE_MANAGE'), asyncHandler(async (request, response) => {
  const { moduleCode } = moduleParamsSchema.parse(request.params);
  const { enabled } = moduleStateSchema.parse(request.body);
  response.json({ ok: true, data: await updatePropertyModule(
    request.auth!, request.propertyContext!, moduleCode, enabled, metadata(request),
  ) });
}));
