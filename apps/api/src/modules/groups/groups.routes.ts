import { Router, type Request } from 'express';
import { asyncHandler } from '../../core/async-handler.js';
import { authenticate, requirePermission, requirePropertyContext } from '../auth/auth.middleware.js';
import type { RequestMetadata } from '../auth/auth.types.js';
import { createGroupSchema, createLocationSchema,
  groupStateSchema, idSchema, updateGroupSchema, updateLocationSchema } from './groups.schemas.js';
import { createGroup, createLocation, listGroups, listLocations,
  setGroupState, updateGroup, updateLocation } from './groups.service.js';

const metadata = (request: Request): RequestMetadata => ({
  ipAddress: request.ip || null, userAgent: request.header('user-agent')?.slice(0, 1000) ?? null,
});

export const groupsRouter = Router();
groupsRouter.use(authenticate, requirePropertyContext);
groupsRouter.get('/', requirePermission('GROUP_VIEW'), asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await listGroups(request.propertyContext!) });
}));
groupsRouter.post('/', requirePermission('GROUP_MANAGE'), asyncHandler(async (request, response) => {
  const input = createGroupSchema.parse(request.body);
  response.status(201).json({ ok: true, data: await createGroup(
    request.auth!, request.propertyContext!, input, metadata(request)) });
}));
groupsRouter.patch('/:id', requirePermission('GROUP_MANAGE'), asyncHandler(async (request, response) => {
  const { id } = idSchema.parse(request.params);
  const input = updateGroupSchema.parse(request.body);
  response.json({ ok: true, data: await updateGroup(
    request.auth!, request.propertyContext!, id, input, metadata(request)) });
}));
groupsRouter.patch('/:id/state', requirePermission('GROUP_MANAGE'), asyncHandler(async (request, response) => {
  const { id } = idSchema.parse(request.params);
  const input = groupStateSchema.parse(request.body);
  response.json({ ok: true, data: await setGroupState(
    request.auth!, request.propertyContext!, id, input, metadata(request)) });
}));

export const locationsRouter = Router();
locationsRouter.use(authenticate, requirePropertyContext);
locationsRouter.get('/', requirePermission('LOCATION_VIEW'), asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await listLocations(request.propertyContext!) });
}));
locationsRouter.post('/', requirePermission('LOCATION_MANAGE'), asyncHandler(async (request, response) => {
  const input = createLocationSchema.parse(request.body);
  response.status(201).json({ ok: true, data: await createLocation(
    request.auth!, request.propertyContext!, input, metadata(request)) });
}));

locationsRouter.patch('/:id', requirePermission('LOCATION_MANAGE'), asyncHandler(async (request, response) => {
  const { id } = idSchema.parse(request.params);
  const input = updateLocationSchema.parse(request.body);
  response.json({ ok: true, data: await updateLocation(request.auth!, request.propertyContext!,
    id, input, metadata(request)) });
}));
