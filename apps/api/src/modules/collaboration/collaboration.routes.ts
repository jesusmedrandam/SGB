import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { env } from '../../config.js';
import { asyncHandler } from '../../core/async-handler.js';
import {
  authenticate,
  requirePermission,
  requirePropertyContext,
} from '../auth/auth.middleware.js';
import type { RequestMetadata } from '../auth/auth.types.js';
import {
  acceptInvitationSchema,
  createInvitationSchema,
  invitationParamsSchema,
  invitationPreviewParamsSchema,
  membershipParamsSchema,
  membershipStatusSchema,
} from './collaboration.schemas.js';
import {
  acceptPropertyInvitation,
  createPropertyInvitation,
  getInvitationPreview,
  getPropertyTeam,
  revokePropertyInvitation,
  updatePropertyMembershipStatus,
} from './collaboration.service.js';

function metadata(request: Request): RequestMetadata {
  return {
    ipAddress: request.ip || null,
    userAgent: request.header('user-agent')?.slice(0, 1000) ?? null,
  };
}

const publicInvitationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

export const invitationRouter = Router();

invitationRouter.get('/preview/:token', publicInvitationLimiter, asyncHandler(async (request, response) => {
  const { token } = invitationPreviewParamsSchema.parse(request.params);
  response.json({ ok: true, data: await getInvitationPreview(token) });
}));

invitationRouter.post('/accept', authenticate, asyncHandler(async (request, response) => {
  const { token } = acceptInvitationSchema.parse(request.body);
  response.json({ ok: true, data: await acceptPropertyInvitation(request.auth!, token, metadata(request)) });
}));

export const propertyTeamRouter = Router();
propertyTeamRouter.use(authenticate, requirePropertyContext);

propertyTeamRouter.get('/', requirePermission('MEMBERSHIP_VIEW'), asyncHandler(async (request, response) => {
  response.json({ ok: true, data: await getPropertyTeam(request.auth!, request.propertyContext!) });
}));

propertyTeamRouter.post('/invitations', requirePermission('MEMBERSHIP_MANAGE'), asyncHandler(async (request, response) => {
  const input = createInvitationSchema.parse(request.body);
  const result = await createPropertyInvitation(request.auth!, request.propertyContext!, input, metadata(request));
  response.status(201).json({
    ok: true,
    data: {
      id: result.id,
      expiresAt: result.expiresAt.toISOString(),
      delivery: result.delivery,
      ...(env.EXPOSE_AUTH_TOKENS ? { invitationToken: result.invitationToken } : {}),
    },
  });
}));

propertyTeamRouter.delete('/invitations/:invitationId', requirePermission('MEMBERSHIP_MANAGE'), asyncHandler(async (request, response) => {
  const { invitationId } = invitationParamsSchema.parse(request.params);
  response.json({ ok: true, data: await revokePropertyInvitation(
    request.auth!, request.propertyContext!, invitationId, metadata(request),
  ) });
}));

propertyTeamRouter.patch('/members/:membershipId/status', requirePermission('MEMBERSHIP_MANAGE'), asyncHandler(async (request, response) => {
  const { membershipId } = membershipParamsSchema.parse(request.params);
  const { status } = membershipStatusSchema.parse(request.body);
  response.json({ ok: true, data: await updatePropertyMembershipStatus(
    request.auth!, request.propertyContext!, membershipId, status, metadata(request),
  ) });
}));
