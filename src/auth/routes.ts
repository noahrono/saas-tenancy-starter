import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { LRUCache } from 'lru-cache';
import { z } from 'zod';
import type { Config } from '../config/index.ts';
import type { CentralDb } from '../db/central/client.ts';
import { AppError } from '../errors.ts';
import type { Mailer } from '../mailer/console.ts';
import { consumeEmailToken, createEmailToken } from './email-tokens.ts';
import { currentUser, makeRequireAuth } from './guard.ts';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords.ts';
import { REFRESH_TTL_MS, type TokenService } from './tokens.ts';

export interface AuthRouteDeps {
  config: Config;
  central: CentralDb;
  tokens: TokenService;
  mailer: Mailer;
}

/** How every email address the API accepts is validated and normalised. */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const email = emailSchema;
const password = z.string().min(10).max(128);
const credentials = z.object({ email, password });
const userOut = z.object({ id: z.uuid(), email: z.string() });
const session = z.object({ user: userOut, accessToken: z.string() });

const COOKIE = 'rt';
const PER_IP = { max: 10, timeWindow: '1 minute' };
const PER_EMAIL_MAX = 5;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  const { config, central, tokens, mailer } = deps;
  const requireAuth = makeRequireAuth(tokens, central);
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Counts attempts per email for one minute, on top of the per-IP limit.
  const attempts = new LRUCache<string, number>({ max: 50_000, ttl: 60_000, ttlAutopurge: true });
  function limitEmail(route: string, address: string): void {
    const key = `${route}:${address}`;
    const n = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, n, { noUpdateTTL: n > 1 });
    if (n > PER_EMAIL_MAX) throw new AppError('RATE_LIMITED', 429, 'Too many attempts, try again in a minute');
  }

  function setRefreshCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(COOKIE, token, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'strict',
      path: '/auth',
      maxAge: REFRESH_TTL_MS / 1000,
    });
  }

  async function startSession(reply: FastifyReply, user: { id: string; email: string }) {
    const refresh = await tokens.issueRefresh(user.id);
    setRefreshCookie(reply, refresh.token);
    return { user, accessToken: await tokens.signAccess(user.id) };
  }

  function link(path: string, token: string): string {
    return `https://${config.baseDomain}${path}?token=${token}`;
  }

  r.post(
    '/auth/signup',
    {
      config: { rateLimit: PER_IP },
      schema: { tags: ['auth'], body: credentials, response: { 201: session } },
    },
    async (req, reply) => {
      limitEmail('signup', req.body.email);
      let user: { id: string; email: string };
      try {
        const passwordHash = await hashPassword(req.body.password);
        const [row] = await central.sql<{ id: string; email: string }[]>`
          insert into users (email, password_hash) values (${req.body.email}, ${passwordHash}) returning id, email`;
        user = row!;
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError('EMAIL_TAKEN', 409, 'An account with this email already exists');
        throw err;
      }
      const token = await createEmailToken(central, user.id, 'verify_email');
      await mailer.send({
        to: user.email,
        subject: 'Verify your email',
        text: `Confirm your email address: ${link('/verify-email', token)}`,
      });
      reply.status(201);
      return startSession(reply, user);
    },
  );

  r.post(
    '/auth/login',
    {
      config: { rateLimit: PER_IP },
      schema: { tags: ['auth'], body: credentials, response: { 200: session } },
    },
    async (req, reply) => {
      limitEmail('login', req.body.email);
      const [row] = await central.sql<{ id: string; email: string; password_hash: string }[]>`
        select id, email, password_hash from users where email = ${req.body.email}`;
      const ok = row ? await verifyPassword(row.password_hash, req.body.password) : await verifyAgainstDummy(req.body.password);
      if (!row || !ok) throw new AppError('INVALID_CREDENTIALS', 401, 'Email or password is incorrect');
      return startSession(reply, { id: row.id, email: row.email });
    },
  );

  r.post(
    '/auth/refresh',
    { schema: { tags: ['auth'], response: { 200: z.object({ accessToken: z.string() }) } } },
    async (req, reply) => {
      const current = req.cookies[COOKIE];
      if (!current) throw new AppError('UNAUTHENTICATED', 401, 'Not signed in or session expired');
      const next = await tokens.rotateRefresh(current);
      setRefreshCookie(reply, next.token);
      return { accessToken: await tokens.signAccess(next.userId) };
    },
  );

  r.post('/auth/logout', { schema: { tags: ['auth'] } }, async (req, reply) => {
    const current = req.cookies[COOKIE];
    if (current) await tokens.revokeFamily(current);
    reply.clearCookie(COOKIE, { path: '/auth' });
    return reply.status(204).send();
  });

  r.get(
    '/auth/me',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['auth'],
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ id: z.uuid(), email: z.string(), emailVerified: z.boolean() }) },
      },
    },
    async (req) => currentUser(req),
  );

  r.post(
    '/auth/verify-email',
    { schema: { tags: ['auth'], body: z.object({ token: z.string().min(1) }) } },
    async (req, reply) => {
      const userId = await consumeEmailToken(central, req.body.token, 'verify_email');
      await central.sql`update users set email_verified_at = coalesce(email_verified_at, now()) where id = ${userId}`;
      return reply.status(204).send();
    },
  );

  r.post(
    '/auth/password-reset/request',
    { config: { rateLimit: PER_IP }, schema: { tags: ['auth'], body: z.object({ email }) } },
    async (req, reply) => {
      limitEmail('reset', req.body.email);
      const [row] = await central.sql<{ id: string; email: string }[]>`
        select id, email from users where email = ${req.body.email}`;
      if (row) {
        const token = await createEmailToken(central, row.id, 'reset_password');
        await mailer.send({
          to: row.email,
          subject: 'Reset your password',
          text: `Choose a new password: ${link('/reset-password', token)}\nIf you did not ask for this, ignore this email.`,
        });
      }
      return reply.status(204).send();
    },
  );

  r.post(
    '/auth/password-reset/confirm',
    { schema: { tags: ['auth'], body: z.object({ token: z.string().min(1), password }) } },
    async (req, reply) => {
      const userId = await consumeEmailToken(central, req.body.token, 'reset_password');
      await central.sql`update users set password_hash = ${await hashPassword(req.body.password)} where id = ${userId}`;
      await tokens.revokeAllForUser(userId);
      return reply.status(204).send();
    },
  );
}
