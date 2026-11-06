import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError, type ErrorCode } from '../errors.ts';

export interface ErrorBody {
  error: { code: ErrorCode; message: string; requestId: string; details?: unknown };
}

function send(reply: FastifyReply, req: FastifyRequest, status: number, code: ErrorCode, message: string, details?: unknown) {
  const body: ErrorBody = { error: { code, message, requestId: req.id } };
  if (details !== undefined) body.error.details = details;
  return reply.status(status).send(body);
}

/** One error envelope for every failure: AppError, schema validation, Fastify 4xx and unexpected crashes. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((req, reply) => send(reply, req, 404, 'NOT_FOUND', `Route ${req.method} ${req.url} not found`));

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, err.message);
      return send(reply, req, err.statusCode, err.code, err.message, err.details);
    }

    if (hasZodFastifySchemaValidationErrors(err)) {
      const details = err.validation.map((v) => ({
        path: v.instancePath.split('/').filter(Boolean),
        message: v.message,
      }));
      return send(reply, req, 400, 'VALIDATION_FAILED', 'Request validation failed', details);
    }

    const status = err.statusCode ?? 500;
    if (status === 429) return send(reply, req, 429, 'RATE_LIMITED', 'Too many requests, slow down');
    if (status >= 400 && status < 500) return send(reply, req, status, 'VALIDATION_FAILED', err.message);

    req.log.error({ err }, 'unhandled error');
    return send(reply, req, 500, 'INTERNAL', 'Something went wrong');
  });
}
