import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { CentralDb } from '../db/central/client.ts';
import { users } from '../db/central/schema.ts';
import { AppError } from '../errors.ts';
import type { TokenService } from './tokens.ts';

export interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/** preHandler that requires `Authorization: Bearer <access token>` and loads the user. */
export function makeRequireAuth(tokens: TokenService, central: CentralDb) {
  return async function requireAuth(req: FastifyRequest): Promise<void> {
    const header = req.headers.authorization;
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    if (!match?.[1]) throw new AppError('UNAUTHENTICATED', 401, 'Not signed in or session expired');

    const { userId } = await tokens.verifyAccess(match[1]);
    const [row] = await central.db
      .select({ id: users.id, email: users.email, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId));
    if (!row) throw new AppError('UNAUTHENTICATED', 401, 'Not signed in or session expired');
    req.user = { id: row.id, email: row.email, emailVerified: row.emailVerifiedAt !== null };
  };
}

/** The signed-in user, for handlers behind requireAuth. */
export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new AppError('UNAUTHENTICATED', 401, 'Not signed in or session expired');
  return req.user;
}
