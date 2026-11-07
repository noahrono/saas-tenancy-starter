import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { AppError } from '../errors.ts';
import { can, type Permission } from './permissions.ts';

/**
 * preHandler that runs after requireTenant: refuses the request with 403 FORBIDDEN unless
 * the caller's role in this tenant has `permission`. Non-members never get here: requireTenant
 * already answered them with 404.
 */
export function requirePermission(permission: Permission): preHandlerAsyncHookHandler {
  return async function checkPermission(req: FastifyRequest): Promise<void> {
    if (!req.membership) throw new Error('requirePermission needs requireTenant to run first');
    if (!can(req.membership.role, permission)) {
      throw new AppError('FORBIDDEN', 403, 'Your role does not allow this', { permission });
    }
  };
}
