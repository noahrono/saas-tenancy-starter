import type { CentralDb } from '../db/central/client.ts';
import type { EmailTokenPurpose } from '../db/central/schema.ts';
import { AppError } from '../errors.ts';
import { hashToken, randomToken } from './tokens.ts';

export const EMAIL_TOKEN_TTL_MS: Record<EmailTokenPurpose, number> = {
  verify_email: 24 * 60 * 60 * 1000,
  reset_password: 60 * 60 * 1000,
};

/** Creates a single-use token for an emailed link. Only its hash is stored. */
export async function createEmailToken(central: CentralDb, userId: string, purpose: EmailTokenPurpose): Promise<string> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + EMAIL_TOKEN_TTL_MS[purpose]).toISOString();
  await central.sql`
    insert into email_tokens (user_id, purpose, token_hash, expires_at)
    values (${userId}, ${purpose}, ${hashToken(token)}, ${expiresAt})`;
  return token;
}

/** Marks a token used and returns its user. Unknown, used, expired or wrong-purpose tokens throw TOKEN_INVALID. */
export async function consumeEmailToken(central: CentralDb, token: string, purpose: EmailTokenPurpose): Promise<string> {
  const [row] = await central.sql<{ user_id: string }[]>`
    update email_tokens set used_at = now()
    where token_hash = ${hashToken(token)} and purpose = ${purpose} and used_at is null and expires_at > now()
    returning user_id`;
  if (!row) throw new AppError('TOKEN_INVALID', 400, 'This link is invalid or has expired');
  return row.user_id;
}
