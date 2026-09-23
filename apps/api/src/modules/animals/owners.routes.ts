import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/async-handler.js';
import { authenticate, requirePermission, requirePropertyContext } from '../auth/auth.middleware.js';
import { createOwner, listAccountUsers, listOwners } from './owners.service.js';

export const ownersRouter = Router();
ownersRouter.use(authenticate, requirePropertyContext);
ownersRouter.get('/', requirePermission('ANIMAL_VIEW'), asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await listOwners(request.propertyContext!) });
}));
ownersRouter.get('/users', requirePermission('CATALOG_MANAGE'), asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await listAccountUsers(request.propertyContext!) });
}));
const ownerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('USER'), userId: z.uuid() }),
  z.object({ kind: z.enum(['EXTERNAL_PERSON', 'ORGANIZATION']),
    name: z.string().trim().min(1).max(160) }),
]);
ownersRouter.post('/', requirePermission('CATALOG_MANAGE'), asyncHandler(async (request: Request, response) => {
  const input = ownerSchema.parse(request.body);
  response.status(201).json({ ok: true, data: await createOwner(request.auth!, request.propertyContext!,
    input, { ipAddress: request.ip || null, userAgent: request.header('user-agent')?.slice(0, 1000) ?? null }) });
}));
