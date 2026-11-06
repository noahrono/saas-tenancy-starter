import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, importPKCS8, importSPKI, jwtVerify } from 'jose';
import type postgres from 'postgres';
import type { CentralDb } from '../db/central/client.ts';
import { AppError } from '../errors.ts';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A rotated token presented again within this window is treated as a race, not reuse. */
export const REUSE_GRACE_MS = 30_000;

export interface IssuedRefresh {
  token: string;
  expiresAt: Date;
}

export interface TokenService {
  signAccess(userId: string): Promise<string>;
  verifyAccess(token: string): Promise<{ userId: string }>;
  issueRefresh(userId: string, familyId?: string): Promise<IssuedRefresh>;
  /** Swaps a refresh token for a new one. A token that was already used revokes its whole family. */
  rotateRefresh(token: string): Promise<IssuedRefresh & { userId: string }>;
  revokeFamily(token: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

const unauthenticated = () => new AppError('UNAUTHENTICATED', 401, 'Not signed in or session expired');

export function createTokenService(opts: {
  privateKeyPem: string;
  publicKeyPem: string;
  central: CentralDb;
  now?: () => Date;
}): TokenService {
  const now = opts.now ?? (() => new Date());
  const privateKey = importPKCS8(opts.privateKeyPem, 'EdDSA');
  const publicKey = importSPKI(opts.publicKeyPem, 'EdDSA');
  const { sql } = opts.central;

  const ts = () => now().toISOString();

  async function insertRefresh(
    db: postgres.Sql | postgres.TransactionSql,
    userId: string,
    familyId: string,
  ): Promise<IssuedRefresh & { id: string }> {
    const token = randomToken();
    const id = randomUUID();
    const expiresAt = new Date(now().getTime() + REFRESH_TTL_MS);
    await db`
      insert into refresh_tokens (id, user_id, family_id, token_hash, expires_at, created_at)
      values (${id}, ${userId}, ${familyId}, ${hashToken(token)}, ${expiresAt.toISOString()}, ${ts()})`;
    return { id, token, expiresAt };
  }

  return {
    async signAccess(userId) {
      const iat = Math.floor(now().getTime() / 1000);
      return new SignJWT({})
        .setProtectedHeader({ alg: 'EdDSA' })
        .setSubject(userId)
        .setIssuedAt(iat)
        .setExpirationTime(iat + ACCESS_TTL_SECONDS)
        .setJti(randomUUID())
        .sign(await privateKey);
    },

    async verifyAccess(token) {
      try {
        const { payload } = await jwtVerify(token, await publicKey, { algorithms: ['EdDSA'], currentDate: now() });
        if (typeof payload.sub !== 'string') throw unauthenticated();
        return { userId: payload.sub };
      } catch {
        throw unauthenticated();
      }
    },

    async issueRefresh(userId, familyId = randomUUID()) {
      const { token, expiresAt } = await insertRefresh(sql, userId, familyId);
      return { token, expiresAt };
    },

    async rotateRefresh(token) {
      const outcome = await sql.begin(async (tx) => {
        const [row] = await tx<
          { id: string; user_id: string; family_id: string; expires_at: Date | string; revoked_at: unknown; replaced_by: string | null }[]
        >`
          select id, user_id, family_id, expires_at, revoked_at, replaced_by
          from refresh_tokens where token_hash = ${hashToken(token)}
          for update`;
        if (!row) return { kind: 'unknown' as const };
        if (row.revoked_at && row.replaced_by) {
          // Rotated moments ago and its replacement is still live: a double submit or two tabs
          // refreshing at once, not theft. Refuse this one without ending the session.
          const rotatedAgo = now().getTime() - new Date(row.revoked_at as string | Date).getTime();
          if (rotatedAgo < REUSE_GRACE_MS) {
            const [successor] = await tx`select 1 from refresh_tokens where id = ${row.replaced_by} and revoked_at is null`;
            if (successor) return { kind: 'revoked' as const };
          }
          // Otherwise someone is replaying an old token. End the whole session.
          await tx`update refresh_tokens set revoked_at = ${ts()}
                   where family_id = ${row.family_id} and revoked_at is null`;
          return { kind: 'reused' as const };
        }
        if (row.revoked_at) return { kind: 'revoked' as const };
        if (new Date(row.expires_at).getTime() <= now().getTime()) return { kind: 'expired' as const };

        const next = await insertRefresh(tx, row.user_id, row.family_id);
        await tx`update refresh_tokens set revoked_at = ${ts()}, replaced_by = ${next.id} where id = ${row.id}`;
        return { kind: 'ok' as const, userId: row.user_id, token: next.token, expiresAt: next.expiresAt };
      });

      if (outcome.kind === 'reused') throw new AppError('REFRESH_REUSED', 401, 'Session was ended because a refresh token was reused');
      if (outcome.kind !== 'ok') throw unauthenticated();
      return { userId: outcome.userId, token: outcome.token, expiresAt: outcome.expiresAt };
    },

    async revokeFamily(token) {
      await sql`
        update refresh_tokens set revoked_at = ${ts()}
        where revoked_at is null and family_id = (
          select family_id from refresh_tokens where token_hash = ${hashToken(token)})`;
    },

    async revokeAllForUser(userId) {
      await sql`update refresh_tokens set revoked_at = ${ts()} where user_id = ${userId} and revoked_at is null`;
    },
  };
}
