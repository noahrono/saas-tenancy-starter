/**
 * Plans live in code: they change when the product changes, and ship with it.
 * To add a feature, add it to FEATURES and to the plans that include it, then guard the route
 * with requireFeature(). To add a limit, add it to LIMITS and give every plan a value.
 * This file must not import from db/, because the central schema imports PLAN_IDS from here.
 */
export const PLAN_IDS = ['free', 'pro', 'business'] as const;
export const FEATURES = ['projects:export'] as const;
export const LIMITS = ['members', 'projects'] as const;

export type PlanId = (typeof PLAN_IDS)[number];
export type Feature = (typeof FEATURES)[number];
export type Limit = (typeof LIMITS)[number];

export interface PlanDefinition {
  name: string;
  features: readonly Feature[];
  /** `null` means unlimited. */
  limits: Record<Limit, number | null>;
}

export const PLANS = {
  free: { name: 'Free', features: [], limits: { members: 3, projects: 10 } },
  pro: { name: 'Pro', features: ['projects:export'], limits: { members: 20, projects: 1000 } },
  business: { name: 'Business', features: ['projects:export'], limits: { members: null, projects: null } },
} satisfies Record<PlanId, PlanDefinition>;

export function hasFeature(plan: PlanId, feature: Feature): boolean {
  return (PLANS[plan].features as readonly Feature[]).includes(feature);
}

export function limitFor(plan: PlanId, limit: Limit): number | null {
  return PLANS[plan].limits[limit];
}

/** The first plan, in PLAN_IDS order, that includes `feature`: what an upgrade prompt should offer. */
export function cheapestPlanWith(feature: Feature): PlanId {
  const plan = PLAN_IDS.find((p) => hasFeature(p, feature));
  if (!plan) throw new Error(`no plan includes ${feature}`);
  return plan;
}
