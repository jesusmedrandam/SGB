import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { env } from '../config.js';
import { ApiError } from './errors.js';

type PostgresError = Error & { code?: string; constraint?: string };

export const notFoundHandler: RequestHandler = (request, response) => {
  response.status(404).json({
    ok: false,
    error: { code: 'NOT_FOUND', message: 'Ruta no encontrada.' },
    requestId: request.id,
  });
};

export const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
  if (error instanceof ApiError) {
    response.status(error.status).json({
      ok: false,
      error: { code: error.code, message: error.message },
      requestId: request.id,
    });
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Revisa los datos enviados.',
        fields: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
      requestId: request.id,
    });
    return;
  }

  const databaseError = error as PostgresError;
  if (databaseError.code === '23505') {
    response.status(409).json({
      ok: false,
      error: { code: 'DUPLICATE_RECORD', message: 'Ya existe un registro con esos datos.' },
      requestId: request.id,
    });
    return;
  }

  console.error(`[${request.id}]`, error);
  response.status(500).json({
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: env.NODE_ENV === 'production' ? 'Ocurrió un error inesperado.' : String(error),
    },
    requestId: request.id,
  });
};
