import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

export const requestId: RequestHandler = (request, response, next) => {
  const incoming = request.header('x-request-id');
  request.id = incoming && incoming.length <= 100 ? incoming : randomUUID();
  response.setHeader('x-request-id', request.id);
  next();
};
