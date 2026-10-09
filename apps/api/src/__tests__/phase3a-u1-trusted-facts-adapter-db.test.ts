/**
 * PHASE 3-A — U1：只读权威可信事实适配器 → 真实 PostgreSQL 只读端口测试（CHANGE 17–20 修订版）
 * 说明：被测对象是**只读**端口；本文件中的写入仅用于**准备夹具**（seed）与清理。
 * 证据口径（CHANGE 20）：
 *   ① 端口全部读取在**只读事务**内执行（`SET TRANSACTION READ ONLY`）；
 *   ② 在该只读事务内执行写语句会被数据库**直接拒绝**（证明「无写」而非「没调用写方法」）；
 *   ③ 解析前后对**全相关表**（Organization / StandingAuthorization / AuditLog / RecoveryOpportunity /
 *      AutonomyTask / AutonomyLease / AutonomyIncident）做前后状态比较，并核对 Organization.updatedAt。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createPrismaTrustedFactsReadPort,
  createTrustedFactsAdapter,
  runInReadOnlyTransaction,
} from '../services/self-repair/trusted-facts-adapter';

import { testDatabaseMarker } from './si-rsi-test-db.helper';

const prisma = new PrismaClient();
const AT = new Date('2026-10-09T04:00:00.000Z');
const ORG = 'org-u1-db';

const adapter = (caller = 'RUNTIME_MEMBER') =>
  createTrustedFactsAdapter({
    readPort: createPrismaTrustedFactsReadPort({ prisma }),
    executionContext: { subjectRef: 'runtime-member-1', caller, operationRecheck: 'CONFIRMED_READ_ONLY' },
    now: () => AT,
  });

async function seedOrganization(): Promise<void> {
  await prisma.organization.upsert({
    where: { id: ORG },
    create: { id: ORG, name: ORG, slug: ORG },
    update: {},
  });
}

async function seedAuthorization(
  overrides: {
    authorizationVersion?: number;
    revocationState?: string;
    effectiveAt?: Date;
    expiresAt?: Date;
    allowedActionTypes?: string[];
    monetaryLimitUsd?: string;
    currency?: string;
    provider?: string;
    platformAccountId?: string;
  } = {},
): Promise<void> {
  await seedOrganization();
  await prisma.standingAuthorization.create({
    data: {
      organizationId: ORG,
      platformAccountId: overrides.platformAccountId ?? 'acct-u1',
      provider: overrides.provider ?? 'AMAZON',
      allowedActionTypes: overrides.allowedActionTypes ?? ['recovery.read'],
      monetaryLimitUsd: overrides.monetaryLimitUsd ?? '50.0000',
      currency: overrides.currency ?? 'USD',
      domain: 'LOGISTICS',
      jurisdiction: 'US',
      effectiveAt: overrides.effectiveAt ?? new Date('2026-10-01T00:00:00.000Z'),
      expiresAt: overrides.expiresAt ?? new Date('2026-11-01T00:00:00.000Z'),
      authorizationVersion: overrides.authorizationVersion ?? 3,
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

/** CHANGE 20：全相关表计数（不只比较 Autonomy* 三张表） */
async function tableCounts(): Promise<Record<string, number>> {
  return {
    organization: await prisma.organization.count(),
    standingAuthorization: await prisma.standingAuthorization.count(),
    auditLog: await prisma.auditLog.count(),
    recoveryOpportunity: await prisma.recoveryOpportunity.count(),
    autonomyTask: await prisma.autonomyTask.count(),
    autonomyLease: await prisma.autonomyLease.count(),
    autonomyIncident: await prisma.autonomyIncident.count(),
  };
}

beforeEach(async () => {
  await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe(`PHASE 3-A / U1 可信事实适配器 — 真实 PostgreSQL（${testDatabaseMarker()}）`, () => {
  it('U1-DB1 真实组织 + 有效授权 ⇒ 解析成功，provenance 含 authorizationId / factVersion', async () => {
    await seedAuthorization();
    const result = await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read', monetaryAction: false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.facts.organizationIdResolved).toBe(true);
    expect(result.facts.authorizationActive).toBe(true);
    expect(result.provenance.authorizationActive?.authorizationId).toMatch(/\S/);
    expect(result.provenance.authorizationActive?.authorizationVersion).toBe(3);
    expect(result.provenance.readScope.statement).toBe('SET TRANSACTION READ ONLY');
    expect(result.provenance.factVersion).toMatch(/^org:.+\|auth:3$/);
  });

  it('U1-DB2 组织不存在 ⇒ ORGANIZATION_NOT_FOUND（fail-closed）', async () => {
    const result = await adapter().resolve({ organizationId: 'org-does-not-exist', actionType: 'recovery.read', monetaryAction: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ORGANIZATION_NOT_FOUND');
  });

  it('U1-DB3 撤销 / 过期 / 动作不允许 / 币种不符 / 超限 / 缺金额声明 ⇒ 一律 fail-closed', async () => {
    await seedAuthorization({ revocationState: 'REVOKED' });
    const revoked = await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read', monetaryAction: false });
    expect(!revoked.ok && revoked.reason).toBe('AUTHORIZATION_REVOKED');
    await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });

    await seedAuthorization({ expiresAt: new Date('2026-10-08T00:00:00.000Z') });
    const expired = await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read', monetaryAction: false });
    expect(!expired.ok && expired.reason).toBe('AUTHORIZATION_NOT_EFFECTIVE');
    await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });

    await seedAuthorization({ allowedActionTypes: ['recovery.read'] });
    const notAllowed = await adapter().resolve({ organizationId: ORG, actionType: 'payment.capture', monetaryAction: false });
    expect(!notAllowed.ok && notAllowed.reason).toBe('ACTION_TYPE_NOT_ALLOWED');

    const missingMonetaryDeclaration = await adapter().resolve({
      organizationId: ORG,
      actionType: 'recovery.read',
    } as never);
    expect(!missingMonetaryDeclaration.ok && missingMonetaryDeclaration.reason).toBe('MONETARY_INPUT_INVALID');

    await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });
    await seedAuthorization({ currency: 'EUR' });
    const currencyMismatch = await adapter().resolve({
      organizationId: ORG,
      actionType: 'recovery.read',
      monetaryAction: true,
      amountUsd: '1.0000',
      currency: 'USD',
    });
    expect(!currencyMismatch.ok && currencyMismatch.reason).toBe('MONETARY_INPUT_INVALID');
    await prisma.standingAuthorization.deleteMany({ where: { organizationId: ORG } });

    await seedAuthorization({ monetaryLimitUsd: '10.0000' });
    const overLimit = await adapter().resolve({
      organizationId: ORG,
      actionType: 'recovery.read',
      monetaryAction: true,
      amountUsd: '10.0001',
      currency: 'USD',
    });
    expect(!overLimit.ok && overLimit.reason).toBe('MONETARY_LIMIT_EXCEEDED');
  });

  it('U1-DB4 同组织两条有效授权 ⇒ AUTHORIZATION_AMBIGUOUS（不取「最高版本」）', async () => {
    await seedAuthorization({ authorizationVersion: 3 });
    await seedAuthorization({ authorizationVersion: 4, platformAccountId: 'acct-u1-b', provider: 'SHOPIFY' });
    const ambiguous = await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read', monetaryAction: false });
    expect(!ambiguous.ok && ambiguous.reason).toBe('AUTHORIZATION_AMBIGUOUS');

    // 资源范围可消除歧义：显式指定 provider 后唯一命中
    const scoped = await adapter().resolve({
      organizationId: ORG,
      actionType: 'recovery.read',
      monetaryAction: false,
      resourceScope: { provider: 'SHOPIFY' },
    });
    expect(scoped.ok).toBe(true);
  });

  it('U1-DB5 只读事务：读可用，写入被数据库直接拒绝；调用方白名单在真实路径生效', async () => {
    await seedAuthorization();

    const counted = await runInReadOnlyTransaction(prisma, (tx) => tx.standingAuthorization.count());
    expect(counted).toBeGreaterThanOrEqual(1);

    await expect(
      runInReadOnlyTransaction(prisma, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM "StandingAuthorization" WHERE "id" = 'u1-probe-nonexistent'`),
      ),
    ).rejects.toThrow(/read-only/i);

    await expect(
      runInReadOnlyTransaction(prisma, (tx) =>
        tx.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "u1_readonly_probe" ("x" int)'),
      ),
    ).rejects.toThrow(/read-only/i);

    const untrustedCaller = await adapter('MODEL').resolve({
      organizationId: ORG,
      actionType: 'recovery.read',
      monetaryAction: false,
    });
    expect(!untrustedCaller.ok && untrustedCaller.reason).toBe('CALLER_NOT_TRUSTED');
  });

  it('U1-DB6 解析前后全相关表状态一致（含 Organization.updatedAt）', async () => {
    await seedAuthorization();
    const before = await tableCounts();
    const orgBefore = await prisma.organization.findUnique({ where: { id: ORG }, select: { updatedAt: true } });

    const resolved = await adapter().resolve({ organizationId: ORG, actionType: 'recovery.read', monetaryAction: false });
    expect(resolved.ok).toBe(true);

    const after = await tableCounts();
    const orgAfter = await prisma.organization.findUnique({ where: { id: ORG }, select: { updatedAt: true } });
    expect(after).toEqual(before);
    expect(orgAfter?.updatedAt.toISOString()).toBe(orgBefore?.updatedAt.toISOString());
  });
});
