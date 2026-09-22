import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../database/pool.js';

const migrationsDirectory = resolve(process.cwd(), 'database/migrations');
const transactionWrapper = /^\s*BEGIN;([\s\S]*)COMMIT;\s*$/i;

try {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        filename text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`SELECT pg_advisory_lock(hashtext('sgb_schema_migrations'))`);

    const filenames = (await readdir(migrationsDirectory))
      .filter((filename) => /^\d{4}_[a-z0-9_]+\.sql$/.test(filename))
      .sort();

    for (const filename of filenames) {
      const source = await readFile(resolve(migrationsDirectory, filename), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      const applied = await client.query<{ checksum: string }>(
        `SELECT checksum FROM schema_migration WHERE filename = $1`,
        [filename],
      );
      if (applied.rows[0]) {
        if (applied.rows[0].checksum.trim() !== checksum) {
          throw new Error(`La migración aplicada ${filename} fue modificada.`);
        }
        console.log(`Sin cambios: ${filename}`);
        continue;
      }

      const match = source.match(transactionWrapper);
      if (!match?.[1]) {
        throw new Error(`${filename} debe estar envuelta por BEGIN; y COMMIT;`);
      }

      await client.query('BEGIN');
      try {
        await client.query(match[1]);
        await client.query(
          `INSERT INTO schema_migration(filename, checksum) VALUES($1,$2)`,
          [filename, checksum],
        );
        await client.query('COMMIT');
        console.log(`Aplicada: ${filename}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock(hashtext('sgb_schema_migrations'))`);
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
