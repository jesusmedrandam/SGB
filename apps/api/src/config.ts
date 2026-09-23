import 'dotenv/config';
import { z } from 'zod';

const optionalEnvironmentValue = <T extends z.ZodType>(schema: T) => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  schema.optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z.stringbool().default(false),
  DATABASE_SSL_REJECT_UNAUTHORIZED: z.stringbool().default(true),
  DB_POOL_MAX: z.coerce.number().int().min(2).max(30).default(10),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(5000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
  FRONTEND_URL: z.url(),
  TRUST_PROXY: z.stringbool().default(false),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(60).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  EMAIL_TOKEN_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(24),
  EMAIL_VERIFICATION_RESEND_SECONDS: z.coerce.number().int().min(30).max(3600).default(60),
  INVITATION_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  BREVO_API_KEY: optionalEnvironmentValue(z.string().trim().min(20)),
  CLOUDINARY_CLOUD_NAME: optionalEnvironmentValue(z.string().trim().regex(/^[a-zA-Z0-9_-]+$/)),
  CLOUDINARY_API_KEY: optionalEnvironmentValue(z.string().trim().min(1)),
  CLOUDINARY_API_SECRET: optionalEnvironmentValue(z.string().trim().min(1)),
  BREVO_SENDER_EMAIL: optionalEnvironmentValue(z.email()),
  BREVO_SENDER_NAME: z.string().trim().min(1).max(120).default('SGB'),
  EMAIL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
  REFRESH_COOKIE_NAME: z.string().min(1).default('sgb_refresh'),
  COOKIE_SECURE: z.stringbool().optional(),
  COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).default('lax'),
  EXPOSE_AUTH_TOKENS: z.stringbool().optional(),
}).superRefine((value, context) => {
  const cloudinary = [value.CLOUDINARY_CLOUD_NAME, value.CLOUDINARY_API_KEY, value.CLOUDINARY_API_SECRET];
  if (cloudinary.some(Boolean) && !cloudinary.every(Boolean)) {
    context.addIssue({ code: 'custom', path: ['CLOUDINARY_CLOUD_NAME'],
      message: 'Configura juntos CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY y CLOUDINARY_API_SECRET.' });
  }
  if (Boolean(value.BREVO_API_KEY) !== Boolean(value.BREVO_SENDER_EMAIL)) {
    context.addIssue({
      code: 'custom',
      path: ['BREVO_API_KEY'],
      message: 'BREVO_API_KEY y BREVO_SENDER_EMAIL deben configurarse juntos.',
    });
  }
});

const parsed = schema.parse(process.env);

export const env = {
  ...parsed,
  COOKIE_SECURE: parsed.COOKIE_SECURE ?? parsed.NODE_ENV === 'production',
  EXPOSE_AUTH_TOKENS: parsed.EXPOSE_AUTH_TOKENS ?? parsed.NODE_ENV !== 'production',
};

if (env.COOKIE_SAME_SITE === 'none' && !env.COOKIE_SECURE) {
  throw new Error('COOKIE_SAME_SITE=none requiere COOKIE_SECURE=true.');
}
