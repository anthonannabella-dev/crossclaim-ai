/**
 * PHASE 3-A · U1（只读）—— 权威可信事实适配器 · 真实 PostgreSQL 只读端口验收
 * 说明：种子的写入属于**测试自身**的准备动作；被测适配器只调用只读端口（findUnique / findFirst）。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createPrismaTrustedFactsReadPort,
  createTrustedFactsAdapter,
} from '../services/self-repair/trusted-facts-adapter';

import { testDatabaseMarker } from './si-rsi-test-db.helper';

const prisma = new PrismaClient();
const AT = new Date('2026-10-09T04:00:00.000Z');
const ORG = 'org-u1-db';

const adapter = () =>
  createTrustedFactsAdapter({
    readPort: createPrismaTrustedFactsReadPort({ prisma }),
    executionContext: { subjectRef: 'runtime-member-1', operationRecheck: 'CONFIRMED_READ_ONLY' },
    now: () => AT,
  });

async function seedAuthorization(overrides: { revocationState?: string; expiresAt?: Date; allowedActionTypes?: string[]; monetaryLimitUsd?: string } = {}): Promise<void> {
  await prisma.organization.upsert({
    where: { id: ORG },
    create: { id: ORG, name: ORG, slug: ORG },
    update: {},
  });
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });
  await prisma.standingAuthorization.create({
    data: {
      organizationId: ORG,
      platformAccountId: 'acct-u1',
      provider: 'AMAZON',
      allowedActionTypes: overrides.allowedActionTypes ?? ['recovery.read'],
      monetaryLimitUsd: overrides.monetaryLimitUsd ?? '50.0000',
      currency: 'USD',
      domain: 'LOGISTICS',
      jurisdiction: 'US',
      effectiveAt: new Date('2026-10-01T00:00:00.000Z'),
      expiresAt: overrides.expiresAt ?? new Date('2026-11-01T00:00:00.000Z'),
      authorizationVersion: 3,
      termsPolicyVersion: 'v1',
      consentEvidenceRef: 'evidence://u1-seed',
      scopeDigest: 'b'.repeat(64),
      revocationState: overrides.revocationState ?? 'ACTIVE',
      createdAt: AT,
      ...(overrides.revocationState === undefined || overrides.revocationState === 'ACTIVE'
        ? {}
        : { revokedAt: AT, revokedBy: 'owner@example.test', revocationReason: 'TEST_REVOKE' }),
    },
  });
}

beforeEach(async () => {
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe(`PHASE 3-A / U1 可信事实适配器 × 真实 PostgreSQL（${testDatabaseMarker()}）`, () => {
  it('U1-DB1 真实组织 + 有效授权 ⇒ 解析成功并给出 provenance 与 factVersion', async () => {
    await seedAuthorization();
    const result = await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.facts.organizationIdResolved).toBe(true);
    expect(result.facts.authorizationActive).toBe(true);
    expect(result.provenance.authorizationActive?.authorizationVersion).toBe(3);
    expect(result.provenance.factVersion).toMatch(/^org:.+\|auth:3$/);
  });

  it('U1-DB2 组织不存在 ⇒ ORGANIZATION_NOT_FOUND（fail-closed）', async () => {
    const result = await adapter().resolve({ organizationId: 'org-does-not-exist', actionType: 'recovery.read' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('U1-DB3 授权已撤销 / 已过期 / 动作类型不允许 / 超限额 逐项 fail-closed', async () => {
    await seedAuthorization({ revocationState: 'REVOKED' });
    const revoked = await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read' });
    expect(!revoked.ok && revoked.reason).toBe('AUTHORIZATION_REVOKED');

    await seedAuthorization({ expiresAt: new Date('2026-10-08T00:00:00.000Z') });
    const expired = await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read' });
    expect(!expired.ok && expired.reason).toBe('AUTHORIZATION_NOT_EFFECTIVE');

    await seedAuthorization({ allowedActionTypes: ['recovery.read'] });
    const notAllowed = await adapter().resolve({ organizationId: ORG, actionType: 'payment.capture' });
    expect(!notAllowed.ok && notAllowed.reason).toBe('ACTION_TYPE_NOT_ALLOWED');

    await seedAuthorization({ monetaryLimitUsd: '10.0000' });
    const overLimit = await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read', amountUsd: '10.0001' });
    expect(!overLimit.ok && overLimit.reason).toBe('MONETARY_LIMIT_EXCEEDED');
  });

  it('U1-DB4 只读端口不产生任何业务副作用（零候选/零任务/零租约）', async () => {
    await seedAuthorization();
    const before = {
      tasks: await prisma.autonomyTask.count(),
      leases: await prisma.autonomyLease.count(),
      incidents: await prisma.autonomyIncident.count(),
    };
    await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read' });
    expect(await prisma.autonomyTask.count()).toBe(before.tasks);
    expect(await prisma.autonomyLease.count()).toBe(before.leases);
    expect(await prisma.autonomyIncident.count()).toBe(before.incidents);
  });
});
