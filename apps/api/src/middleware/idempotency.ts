import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { pool } from '../database/pool.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

interface StoredMutation {
  request_hash: string;
  state: 'PENDING' | 'COMPLETED';
  response_status: number | null;
  response_body: unknown;
}

function requestHash(method: string, path: string, body: unknown) {
  return createHash('sha256')
    .update(JSON.stringify({ method, path, body: body ?? null }))
    .digest('hex');
}

/**
 * Runs after authentication. A completed request with the same key is replayed,
 * while a new request is reserved before its route handler mutates the database.
 */
export const idempotentMutation: RequestHandler = async (request, response, next) => {
  try {
    if (!MUTATING_METHODS.has(request.method)) return next();

    const key = request.header('x-idempotency-key')?.trim();
    if (!key) return next();
    if (!IDEMPOTENCY_KEY.test(key)) {
      response.status(400).json({
        ok: false,
        error: {
          code: 'INVALID_IDEMPOTENCY_KEY',
          message: 'La clave de idempotencia no tiene un formato válido.',
        },
        requestId: request.id,
      });
      return;
    }

    const userId = request.auth?.userId;
    if (!userId) return next();
    const path = request.originalUrl;
    const hash = requestHash(request.method, path, request.body);

    // Expired reservations and completed responses must not block/replay a key forever.
    await pool.query(
      `DELETE FROM idempotent_mutation
        WHERE user_id = $1 AND idempotency_key = $2
          AND expires_at <= now()`,
      [userId, key],
    );

    const reservation = await pool.query(
      `INSERT INTO idempotent_mutation
         (user_id, idempotency_key, request_method, request_path, request_hash,
          expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours')
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [userId, key, request.method, path, hash],
    );

    if (reservation.rowCount === 0) {
      const stored = await pool.query<StoredMutation>(
        `SELECT request_hash, state, response_status, response_body
           FROM idempotent_mutation
          WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, key],
      );
      const previous = stored.rows[0];
      if (!previous || previous.request_hash !== hash) {
        response.status(409).json({
          ok: false,
          error: {
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'La clave ya fue utilizada para otra operación.',
          },
          requestId: request.id,
        });
        return;
      }
      if (previous.state === 'COMPLETED' && previous.response_status !== null) {
        response.setHeader('x-idempotent-replay', 'true');
        response.status(previous.response_status).json(previous.response_body);
        return;
      }
      response.setHeader('retry-after', '2');
      response.status(409).json({
        ok: false,
        error: {
          code: 'IDEMPOTENCY_IN_PROGRESS',
          message: 'La misma operación todavía se está procesando.',
        },
        requestId: request.id,
      });
      return;
    }

    let responseBody: unknown = null;
    const originalJson = response.json.bind(response);
    response.json = ((body: unknown) => {
      responseBody = body;
      return originalJson(body);
    }) as typeof response.json;

    response.once('finish', () => {
      if (response.statusCode >= 500) {
        void pool.query(
          `DELETE FROM idempotent_mutation
            WHERE user_id = $1 AND idempotency_key = $2 AND state = 'PENDING'`,
          [userId, key],
        ).catch((error: unknown) => console.error(`[${request.id}] idempotency cleanup`, error));
        return;
      }
      void pool.query(
        `UPDATE idempotent_mutation
            SET state = 'COMPLETED', response_status = $3, response_body = $4,
                completed_at = now(), expires_at = now() + interval '7 days'
          WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, key, response.statusCode, JSON.stringify(responseBody)],
      ).catch((error: unknown) => console.error(`[${request.id}] idempotency persist`, error));
    });

    next();
  } catch (error) {
    next(error);
  }
};
