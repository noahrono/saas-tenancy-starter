import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { createDeps, type RuntimeDeps } from '../../src/deps.ts';
import type { Role } from '../../src/db/central/schema.ts';
import type { Mailer, MailMessage } from '../../src/mailer/console.ts';
import type { TestContext } from './context.ts';

export interface TestApp {
  app: FastifyInstance;
  deps: RuntimeDeps;
  mails: MailMessage[];
  close(): Promise<void>;
}

/** Builds the real app on a test context, with a mailer that records instead of logging. */
export async function createTestApp(ctx: TestContext): Promise<TestApp> {
  const mails: MailMessage[] = [];
  const mailer: Mailer = {
    send: async (m) => {
      mails.push(m);
    },
  };
  const deps = createDeps(ctx.config, { mailer });
  const app = await buildApp(deps);
  return {
    app,
    deps,
    mails,
    async close() {
      await app.close();
      await deps.close();
    },
  };
}

/** Pulls the `token=` value out of a mailed link. */
export function tokenFromMail(mail: MailMessage | undefined): string {
  const m = mail?.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!m?.[1]) throw new Error('no token in mail');
  return m[1];
}

export function refreshCookie(res: { cookies: { name: string; value: string }[] }): string {
  const c = res.cookies.find((x) => x.name === 'rt');
  if (!c) throw new Error('no rt cookie set');
  return c.value;
}

let clients = 0;
/**
 * A different client address for each setup request, so per-IP rate limits on signup and
 * tenant creation don't trip in test files that need many users or tenants. Tests that
 * check those limits make their own requests and keep the default address.
 */
const freshClient = () => {
  clients++;
  return `10.99.${Math.floor(clients / 250)}.${(clients % 250) + 1}`;
};

export async function createTenant(t: TestApp, token: string, slug: string): Promise<void> {
  const res = await t.app.inject({
    method: 'POST',
    remoteAddress: freshClient(),
    url: '/tenants',
    headers: { authorization: `Bearer ${token}` },
    payload: { slug, name: slug },
  });
  if (res.statusCode !== 201) throw new Error(`create tenant failed: ${res.body}`);
}

/** Signs up `email` and makes them a `role` member of `slug` directly in the database. Returns their access token. */
export async function addMember(t: TestApp, slug: string, email: string, role: Role): Promise<string> {
  const token = await signupAndToken(t, email);
  await t.deps.central.sql`
    insert into memberships (user_id, tenant_id, role)
    select u.id, tn.id, ${role} from users u, tenants tn where u.email = ${email} and tn.slug = ${slug}`;
  return token;
}

export async function signupAndToken(t: TestApp, email: string, password = 'correct-horse-9'): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    remoteAddress: freshClient(),
    url: '/auth/signup',
    payload: { email, password },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.body}`);
  return res.json().accessToken as string;
}
