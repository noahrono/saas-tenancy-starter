import { AppError } from '../errors.ts';

/** 3 to 40 characters: lowercase letters, digits and inner hyphens. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'www',
  'api',
  'app',
  'admin',
  'auth',
  'static',
  'mail',
  'docs',
  'status',
]);

export function validateSlug(input: string): string {
  if (!SLUG.test(input)) {
    throw new AppError(
      'SLUG_INVALID',
      400,
      'Slug must be 3-40 characters of lowercase letters, numbers and hyphens, not starting or ending with a hyphen',
    );
  }
  if (RESERVED_SLUGS.has(input)) throw new AppError('SLUG_RESERVED', 400, `"${input}" is reserved`);
  return input;
}

/** Database name for a tenant. Built only from the generated tenant id, so user input never reaches SQL identifiers. */
export function tenantDbName(tenantId: string): string {
  if (!UUID.test(tenantId)) throw new Error(`not a tenant id: ${tenantId}`);
  return `t_${tenantId.replace(/-/g, '').toLowerCase()}`;
}
