import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { env } from '../../config.js';
import { asyncHandler } from '../../core/async-handler.js';
import { unauthorized } from '../../core/errors.js';
import { clearRefreshCookie, readCookie, setRefreshCookie } from '../../security/cookies.js';
import { authenticate } from './auth.middleware.js';
import {
  contextSchema,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  verifyEmailSchema,
} from './auth.schemas.js';
import {
  changeContext,
  getSessionOverview,
  login,
  logout,
  refreshSession,
  register,
  resendEmailVerification,
  verifyEmail,
} from './auth.service.js';
import type { RequestMetadata } from './auth.types.js';

export const authRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    error: { code: 'AUTH_RATE_LIMIT', message: 'Demasiados intentos. Espera unos minutos.' },
  },
});

const verificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    error: { code: 'VERIFICATION_RATE_LIMIT', message: 'Espera unos minutos antes de solicitar otro correo.' },
  },
});

function metadata(request: Request): RequestMetadata {
  return {
    ipAddress: request.ip || null,
    userAgent: request.header('user-agent')?.slice(0, 1000) ?? null,
  };
}

function accessToken(request: Request): string | null {
  const header = request.header('authorization');
  if (!header) return null;
  const [scheme, token, extra] = header.trim().split(/\s+/);
  return !extra && scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

function sessionPayload(session: Awaited<ReturnType<typeof login>>) {
  return {
    accessToken: session.accessToken,
    accessExpiresAt: session.accessExpiresAt.toISOString(),
    user: session.user,
    activeContext: session.activePropertyId && session.activeRoleId
      ? { propertyId: session.activePropertyId, roleId: session.activeRoleId }
      : null,
  };
}

authRouter.post('/register', authLimiter, asyncHandler(async (request, response) => {
  const input = registerSchema.parse(request.body);
  const result = await register(input, metadata(request));
  response.status(201).json({
    ok: true,
    data: {
      userId: result.userId,
      accountId: result.accountId,
      propertyId: result.propertyId,
      invitationId: result.invitationId,
      verificationRequired: true,
      verificationExpiresAt: result.verificationExpiresAt.toISOString(),
      verificationDelivery: result.verificationDelivery,
      ...(env.EXPOSE_AUTH_TOKENS ? { verificationToken: result.verificationToken } : {}),
    },
  });
}));

authRouter.post('/resend-verification', verificationLimiter, asyncHandler(async (request, response) => {
  const { email } = resendVerificationSchema.parse(request.body);
  const result = await resendEmailVerification(email, metadata(request));
  response.status(202).json({
    ok: true,
    data: {
      accepted: true,
      ...(env.EXPOSE_AUTH_TOKENS && result.verificationToken
        ? { verificationToken: result.verificationToken }
        : {}),
    },
  });
}));

authRouter.post('/verify-email', authLimiter, asyncHandler(async (request, response) => {
  const { token } = verifyEmailSchema.parse(request.body);
  await verifyEmail(token, metadata(request));
  response.json({ ok: true, data: { verified: true } });
}));

authRouter.post('/login', authLimiter, asyncHandler(async (request, response) => {
  const input = loginSchema.parse(request.body);
  const session = await login(input, metadata(request));
  setRefreshCookie(response, session.refreshToken);
  response.json({ ok: true, data: sessionPayload(session) });
}));

authRouter.post('/refresh', authLimiter, asyncHandler(async (request, response) => {
  const refreshToken = readCookie(request, env.REFRESH_COOKIE_NAME);
  if (!refreshToken) throw unauthorized();
  const session = await refreshSession(refreshToken, metadata(request));
  setRefreshCookie(response, session.refreshToken);
  response.json({ ok: true, data: sessionPayload(session) });
}));

authRouter.post('/logout', asyncHandler(async (request, response) => {
  await logout(
    accessToken(request),
    readCookie(request, env.REFRESH_COOKIE_NAME),
    metadata(request),
  );
  clearRefreshCookie(response);
  response.status(204).send();
}));

authRouter.get('/me', authenticate, asyncHandler(async (request, response) => {
  const data = await getSessionOverview(request.auth!);
  response.json({ ok: true, data });
}));

authRouter.post('/context', authenticate, asyncHandler(async (request, response) => {
  const { propertyId, roleId } = contextSchema.parse(request.body);
  const data = await changeContext(request.auth!, propertyId, roleId, metadata(request));
  response.json({ ok: true, data });
}));
