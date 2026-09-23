import { Router, type Request } from 'express';
import { asyncHandler } from '../../core/async-handler.js';
import { authenticate, requireModule, requirePermission, requirePropertyContext } from '../auth/auth.middleware.js';
import type { RequestMetadata } from '../auth/auth.types.js';
import { createBirthSchema, createHeatSchema, createLossSchema, createPregnancySchema, createServiceSchema, idSchema,
  reproductionSettingSchema } from './reproduction.schemas.js';
import { cancelHeat, cancelPregnancy, cancelService, createHeat, createPregnancy, createService, listReproduction,
  listReproductionCandidates, getReproductionSettings, updateReproductionSettings,
  recordBirth, recordLoss } from './reproduction.service.js';

const metadata = (request: Request): RequestMetadata => ({
  ipAddress: request.ip || null, userAgent: request.header('user-agent')?.slice(0, 1000) ?? null,
});
export const reproductionRouter = Router();
reproductionRouter.use(authenticate, requirePropertyContext, requireModule('REPRODUCTION'));
reproductionRouter.get('/', requirePermission('REPRODUCTION_VIEW'), asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await listReproduction(request.propertyContext!) });
}));
reproductionRouter.get('/candidates', requirePermission('REPRODUCTION_VIEW'), asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await listReproductionCandidates(request.propertyContext!) });
}));
reproductionRouter.get('/settings', requirePermission('REPRODUCTION_VIEW'), asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await getReproductionSettings(request.propertyContext!) });
}));
reproductionRouter.put('/settings', requirePermission('REPRODUCTION_MANAGE'), asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await updateReproductionSettings(request.auth!, request.propertyContext!,
    reproductionSettingSchema.parse(request.body), metadata(request)) });
}));
reproductionRouter.post('/heats', requirePermission('REPRODUCTION_MANAGE'), asyncHandler(async (request, response) => {
  response.status(201).json({ ok: true, data: await createHeat(request.auth!, request.propertyContext!,
    createHeatSchema.parse(request.body), metadata(request)) });
}));
reproductionRouter.post('/services', requirePermission('REPRODUCTION_MANAGE'), asyncHandler(async (request, response) => {
  response.status(201).json({ ok: true, data: await createService(request.auth!, request.propertyContext!,
    createServiceSchema.parse(request.body), metadata(request)) });
}));
reproductionRouter.post('/services/:id/cancel', requirePermission('REPRODUCTION_MANAGE'),
  asyncHandler(async (request, response) => {
    const { id } = idSchema.parse(request.params);
    response.json({ ok: true, data: await cancelService(request.auth!, request.propertyContext!,
      id, metadata(request)) });
  }));
reproductionRouter.post('/pregnancies', requirePermission('REPRODUCTION_MANAGE'), asyncHandler(async (request, response) => {
  response.status(201).json({ ok: true, data: await createPregnancy(request.auth!, request.propertyContext!,
    createPregnancySchema.parse(request.body), metadata(request)) });
}));
reproductionRouter.post('/births', requirePermission('REPRODUCTION_MANAGE'), asyncHandler(async (request, response) => {
  response.status(201).json({ ok: true, data: await recordBirth(request.auth!, request.propertyContext!,
    createBirthSchema.parse(request.body), metadata(request)) });
}));
reproductionRouter.post('/losses', requirePermission('REPRODUCTION_MANAGE'), asyncHandler(async (request, response) => {
  response.status(201).json({ ok: true, data: await recordLoss(request.auth!, request.propertyContext!,
    createLossSchema.parse(request.body), metadata(request)) });
}));
reproductionRouter.post('/pregnancies/:id/cancel', requirePermission('REPRODUCTION_MANAGE'),
  asyncHandler(async (request, response) => {
    const { id } = idSchema.parse(request.params);
    response.json({ ok: true, data: await cancelPregnancy(request.auth!, request.propertyContext!,
      id, metadata(request)) });
  }));
reproductionRouter.post('/heats/:id/cancel', requirePermission('REPRODUCTION_MANAGE'),
  asyncHandler(async (request, response) => {
    const { id } = idSchema.parse(request.params);
    response.json({ ok: true, data: await cancelHeat(request.auth!, request.propertyContext!,
      id, metadata(request)) });
  }));
