import 'dotenv/config';
import { z } from 'zod';

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
  REFRESH_COOKIE_NAME: z.string().min(1).default('sgb_refresh'),
  COOKIE_SECURE: z.stringbool().optional(),
  COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).default('lax'),
  EXPOSE_AUTH_TOKENS: z.stringbool().optional(),
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
