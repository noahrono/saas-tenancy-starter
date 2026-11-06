import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { AppError } from '../errors.ts';
import { cheapestPlanWith, hasFeature, type Feature } from './plans.ts';

/**
 * preHandler that runs after requireTenant (and requirePermission): refuses with 403
 * FEATURE_NOT_AVAILABLE unless the tenant's plan includes `feature`. The details name the
 * cheapest plan that has it, so a client can show an upgrade prompt.
 */
export function requireFeature(feature: Feature): preHandlerAsyncHookHandler {
  return async function checkFeature(req: FastifyRequest): Promise<void> {
    if (!req.tenant) throw new Error('requireFeature needs requireTenant to run first');
    const { plan } = req.tenant;
    if (!hasFeature(plan, feature)) {
      throw new AppError('FEATURE_NOT_AVAILABLE', 403, `Your plan doesn't include ${feature}`, {
        feature,
        plan,
        requiredPlan: cheapestPlanWith(feature),
      });
    }
  };
}
