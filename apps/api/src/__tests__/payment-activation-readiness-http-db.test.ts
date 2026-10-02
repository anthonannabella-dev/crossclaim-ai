/**
 * TRACK A / PC-12A FINAL — GET /payment-activation-readiness（真实 HTTP + PostgreSQL）。
 * CHANGE C：证明 endpoint 由真实事实派生（不是静态 DTO）—— env / DB / 注入 / 能力各自独立生效。
 */

import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { LocalFileSystemStorage } from '../services/storage';

const prisma = new PrismaClient();
const ORG = 'cc777777-0000-4000-8000-000000000011';
const SALT = 'pc12a-readiness-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'payment-activation-pass-1';
const POLICY_KEYS = [
  'terms-of-service',
  'privacy-policy',
  'data-use-notice',
  'refund-and-fee-policy',
  'recovery-service-scope',
  'provider-authorization-disclosure',
  'customs-broker-limitation',
];

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crossclaim-pc12a-'));
const storage = new LocalFileSystemStorage({ rootDir: storageRoot, secret: SALT, publicBaseUrl: 'http://localhost:3000' });

interface ReadinessBody {
  activationReady: boolean;
  ready: boolean;
  readinessMeaning: string;
  posture: string;
  internalReady: boolean;
  currentState: { payment: string; collection: string; autopay: string; externalWrite: string; r13: string };
  activationState: string;
  activationPrerequisites: Record<string, boolean>;
  checks: Record<string, { value: boolean; source: string }>;
  blockers: string[];
  feeDueVsCollected: { separated: boolean };
}

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer({ prisma, log, audit, storage });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run('http://127.0.0.1:' + port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function login(base: string, email: string): Promise<string> {
  const response = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error('LOGIN_FAILED ' + response.status);
  return cookie.split(';')[0];
}

async function seedUser(email: string, role: string): Promise<void> {
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: role,
      status: 'ACTIVE',
      emailVerified: true,
    },
    select: { id: true },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: user.id, role: role as never, isActive: true } });
}

async function readiness(base: string, cookie: string): Promise<{ status: number; raw: string; body: ReadinessBody }> {
  const response = await fetch(base + '/payment-activation-readiness', { headers: { cookie } });
  const raw = await response.text();
  return { status: response.status, raw, body: JSON.parse(raw) as ReadinessBody };
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  delete process.env.PAYMENT_WEBHOOK_SECRET;
  delete process.env.PAYMENTS_ENABLED;
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "PolicyAcceptance", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'PC12A 租户', slug: 'pc12a-org' } });
  await seedUser('owner-pc12a@example.com', 'OWNER');
  await seedUser('viewer-pc12a@example.com', 'VIEWER');
});

describe('PC-12A FINAL — /payment-activation-readiness', () => {
  it('授权：未认证 401；VIEWER 403；OWNER 200', async () => {
    await withServer(async (base) => {
      expect((await fetch(base + '/payment-activation-readiness')).status).toBe(401);
      const viewer = await login(base, 'viewer-pc12a@example.com');
      expect((await fetch(base + '/payment-activation-readiness', { headers: { cookie: viewer } })).status).toBe(403);
      const owner = await login(base, 'owner-pc12a@example.com');
      expect((await readiness(base, owner)).status).toBe(200);
    });
  });

  it('默认冻结：currentState 全冻结、activationReady=false、provider gate=false、productionCredentials 未就位', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'owner-pc12a@example.com');
      const { body, raw } = await readiness(base, owner);
      expect(body.activationReady).toBe(false);
      expect(body.activationState).toBe('NOT_ACTIVATED');
      expect(body.currentState).toEqual({
        payment: 'ZERO',
        collection: 'OFF',
        autopay: 'OFF',
        externalWrite: 'OFF',
        r13: 'HOLD',
      });
      expect(body.activationPrerequisites.providerCredentialsConfigured).toBe(false);
      expect(body.checks.providerCredentialsConfigured.value).toBe(false);
      expect(body.blockers).toContain('EXTERNAL:R13_NOT_RELEASED');
      expect(body.feeDueVsCollected.separated).toBe(true);
      for (const forbidden of ['sk_', 'whsec', 'client_secret', 'passwordHash', 'credentialRef']) {
        expect(raw).not.toContain(forbidden);
      }
    });
  });

  it('CHANGE C：webhook secret 由 env 派生，且只改变对应 check（一个 fact 不影响无关 fact）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'owner-pc12a@example.com');
      const before = await readiness(base, owner);
      expect(before.body.checks.paymentWebhookSecretConfigured).toEqual({ value: false, source: 'ENV' });

      process.env.PAYMENT_WEBHOOK_SECRET = 'test-only-value-not-a-real-secret';
      const after = await readiness(base, owner);
      expect(after.body.checks.paymentWebhookSecretConfigured).toEqual({ value: true, source: 'ENV' });

      for (const key of Object.keys(before.body.checks)) {
        if (key === 'paymentWebhookSecretConfigured') continue;
        expect(after.body.checks[key]).toEqual(before.body.checks[key]);
      }
      delete process.env.PAYMENT_WEBHOOK_SECRET;
    });
  });

  it('CHANGE C：商业接受由 DB 派生（未接受=false；接受全部 CURRENT 后=true，且不影响无关 check）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'owner-pc12a@example.com');
      const before = await readiness(base, owner);
      expect(before.body.checks.commercialAcceptanceReady).toEqual({ value: false, source: 'DB' });

      for (const key of POLICY_KEYS) {
        const response = await fetch(base + '/commercial/policies/' + key + '/accept', {
          method: 'POST',
          headers: { cookie: owner, 'content-type': 'application/json' },
          body: JSON.stringify({ accept: true }),
        });
        expect([200, 201]).toContain(response.status);
      }

      const after = await readiness(base, owner);
      expect(after.body.checks.commercialAcceptanceReady).toEqual({ value: true, source: 'DB' });
      expect(after.body.checks.providerCredentialsConfigured).toEqual(before.body.checks.providerCredentialsConfigured);
      expect(after.body.currentState).toEqual(before.body.currentState);
      // 内部条件仍未全绿（reconciliation 未生产验收 / 冻结 gate）→ activationReady 仍为 false
      expect(after.body.activationReady).toBe(false);
    });
  });

  it('CHANGE C：Action Guard / Kill Switch 由注入与真实 resolver 派生（均为 true）', async () => {
    await withServer(async (base) => {
      const owner = await login(base, 'owner-pc12a@example.com');
      const { body } = await readiness(base, owner);
      expect(body.checks.actionGuardReady).toEqual({ value: true, source: 'INJECTED' });
      expect(body.checks.killSwitchReady).toEqual({ value: true, source: 'INJECTED' });
    });
  });
});
