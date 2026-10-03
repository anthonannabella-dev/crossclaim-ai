/**
 * CHANGE C（MSG-20261003-142）— Platform qualification **runtime composition** HTTP E2E（真实 PostgreSQL）。
 * 关键点：**不手工注入** qualificationRead —— 使用 createDefaultReadDeps（createRuntime 的默认装配）。
 * 断言：真实登录会话 → GET /platform-accounts/:id/qualification → 200 且返回预先持久化的判定；
 *       读取前后判定记录数不变；VIEWER 403；未知账户 404；未认证 401。
 */

import type { AddressInfo } from 'node:net';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger';
import { createDefaultReadDeps, createServer } from '../server';
import { hashPassword } from '../services/auth';
import { createAuditWriter, createPrismaAuditSink } from '../services/audit';
import { evaluateCustomerQualification, type RecoveryEconomicsPolicy } from '../services/commercial/customer-qualification-gate';
import { createPrismaQualificationAssessmentStore } from '../services/commercial/recovery-qualification-store';

const prisma = new PrismaClient();
const ORG = 'cc290000-0000-4000-8000-000000000001';
const USER = 'cc290000-0000-4000-8000-000000000002';
const VIEWER = 'cc290000-0000-4000-8000-000000000003';
const SALT = 'chg-c-e2e-salt-0123456789';
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'change-c-e2e-pass-1';
const NOW = '2026-10-04T09:00:00.000Z';

const audit = createAuditWriter(createPrismaAuditSink(prisma), { ipSalt: SALT });
const log = createLogger({ level: 'error', sink: () => undefined });
const PERMISSIVE_GUARD = { async assertAllowed() {} };

const POLICY: RecoveryEconomicsPolicy = {
  policyId: 'recovery-economics-2026',
  policyVersion: '1.0.0',
  currency: 'USD',
  minimumRecoveryThreshold: '100.00',
  highValueThreshold: '10000.00',
  maxCostRatio: '0.35',
  minimumDataCompleteness: '0.80',
};

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  // 关键：只给只读依赖的默认装配（createRuntime 使用的同一个函数），不手工注入 qualificationRead
  const server = createServer({
    prisma,
    log,
    audit,
    actionGuard: PERMISSIVE_GUARD,
    ...createDefaultReadDeps(prisma),
  } as never);
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

const getQualification = (base: string, accountId: string, cookie?: string) =>
  fetch(base + '/platform-accounts/' + encodeURIComponent(accountId) + '/qualification', {
    headers: cookie ? { cookie } : {},
  });

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RecoveryQualificationAssessmentRecord", "AuditLog", "Session", "UserInvitation", "Membership", "User", "Organization" CASCADE;',
  );
  await prisma.organization.create({ data: { id: ORG, name: 'CHANGE C E2E', slug: 'change-c-e2e' } });
  for (const [id, email, name] of [
    [USER, 'change-c-owner@example.com', 'OWNER'],
    [VIEWER, 'change-c-viewer@example.com', 'VIEWER'],
  ] as const) {
    await prisma.user.create({ data: { id, email, passwordHash: hashPassword(PASSWORD, FAST_PARAMS), displayName: name, status: 'ACTIVE', emailVerified: true } });
  }
  await prisma.membership.create({ data: { organizationId: ORG, userId: USER, role: 'OWNER' as never, isActive: true } });
  await prisma.membership.create({ data: { organizationId: ORG, userId: VIEWER, role: 'VIEWER' as never, isActive: true } });
});

describe('CHANGE C — Platform qualification runtime composition（真实 HTTP + PostgreSQL）', () => {
  it('默认 runtime（不手工注入）→ 200 且返回持久化判定；读取不重算', async () => {
    const decision = evaluateCustomerQualification({
      readiness: {
        organizationId: ORG,
        platformAccountId: 'acct-1',
        verifiedDataAvailable: true,
        importHistoryAvailable: true,
        returnExportDestructionEvidenceAvailable: true,
        lineageCompleteness: 'COMPLETE',
        dataCompletenessScore: '0.95',
        riskLevel: 'LOW',
        checkedAt: NOW,
      },
      estimatedRecoveryAmount: '1000.00',
      estimatedExternalApiCost: '100.00',
      estimatedBrokerCost: '100.00',
      policy: POLICY,
      computedAt: NOW,
    });
    await createPrismaQualificationAssessmentStore(prisma).appendAssessment({
      organizationId: ORG,
      algorithmVersion: 'v1',
      inputDigest: 'a'.repeat(64),
      decision,
      payload: { reasonCodes: decision.reasonCodes },
    });

    await withServer(async (base) => {
      const owner = await login(base, 'change-c-owner@example.com');
      expect((await getQualification(base, 'acct-1')).status).toBe(401);

      const before = await prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*)::bigint AS n FROM "RecoveryQualificationAssessmentRecord"');
      const response = await getQualification(base, 'acct-1', owner);
      const after = await prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*)::bigint AS n FROM "RecoveryQualificationAssessmentRecord"');
      expect(response.status).toBe(200);
      const body = (await response.json()) as { qualification: Record<string, unknown>; boundary: Record<string, unknown> };
      expect(body.qualification.status).toBe('QUALIFIED');
      expect(body.qualification.policyVersion).toBe('1.0.0');
      expect(body.boundary.recomputedOnRead).toBe(false);
      expect(after[0].n).toBe(before[0].n);

      const viewer = await login(base, 'change-c-viewer@example.com');
      expect((await getQualification(base, 'acct-1', viewer)).status).toBe(403);
      expect((await getQualification(base, 'acct-unknown', owner)).status).toBe(404);
    });
  });
});
