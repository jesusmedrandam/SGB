import { Pool, type PoolConfig } from 'pg';
import { env } from '../config.js';

const config: PoolConfig = {
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  allowExitOnIdle: env.NODE_ENV === 'test',
};

if (env.DATABASE_SSL) {
  config.ssl = { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED };
}

export const pool = new Pool(config);

pool.on('error', (error) => {
  console.error('Conexión inactiva de PostgreSQL terminada inesperadamente.', error);
});
