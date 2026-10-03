/** P0-2 — qualification 判定 append-only 持久化：真实 PostgreSQL 验收。 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { evaluateCustomerQualification } from '../services/commercial/customer-qualification-gate';
import {
  createPrismaQualificationAssessmentStore,
  qualificationAssessmentId,
} from '../services/commercial/recovery-qualification-store';

const prisma = new PrismaClient();
const ORG = 'cc230000-0000-4000-8000-000000000001';
const ORG_B = 'cc230000-0000-4000-8000-000000000009';
const ACCOUNT = 'acct-p0-2';

const POLICY = {
  policyId: 'recovery-economics-2026',
  policyVersion: '1.0.0',
  currency: 'USD',
  minimumRecoveryThreshold: '100.00',
  highValueThreshold: '10000.00',
  maxCostRatio: '0.35',
  minimumDataCompleteness: '0.80',
};

const readiness = {
  organizationId: ORG,
  platformAccountId: ACCOUNT,
  verifiedDataAvailable: true,
  importHistoryAvailable: true,
  returnExportDestructionEvidenceAvailable: true,
  lineageCompleteness: 'COMPLETE' as const,
  dataCompletenessScore: '0.95',
  riskLevel: 'LOW' as const,
  checkedAt: '2026-10-03T12:45:00.000Z',
};

function decide(overrides: Record<string, unknown> = {}) {
  return evaluateCustomerQualification({
    readiness,
    estimatedRecoveryAmount: '1000.00',
    estimatedExternalApiCost: '100.00',
    estimatedBrokerCost: '100.00',
    policy: POLICY,
    computedAt: '2026-10-03T12:45:00.000Z',
    ...overrides,
  } as never);
}

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
  await prisma.organization.create({ data: { id: ORG, name: 'P0-2 租户', slug: 'p02-org' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'P0-2 租户B', slug: 'p02-org-b' } });
});

describe('P0-2 — qualification assessment persistence (PostgreSQL)', () => {
  it('同一输入重复 append → 幂等（ALREADY_APPENDED，只有一行）', async () => {
    const store = createPrismaQualificationAssessmentStore(prisma);
    const input = { organizationId: ORG, algorithmVersion: 'p0-2-v1', inputDigest: 'a'.repeat(64), decision: decide() };
    expect((await store.appendAssessment(input)).status).toBe('APPENDED');
    expect((await store.appendAssessment(input)).status).toBe('ALREADY_APPENDED');
    expect(await prisma.recoveryQualificationAssessmentRecord.count()).toBe(1);
  });

  it('重算（更晚 computedAt / 新 policyVersion）→ 追加历史且 latest 指向新判定', async () => {
    const store = createPrismaQualificationAssessmentStore(prisma);
    const first = await store.appendAssessment({
      organizationId: ORG,
      algorithmVersion: 'p0-2-v1',
      inputDigest: 'a'.repeat(64),
      decision: decide(),
    });
    const second = await store.appendAssessment({
      organizationId: ORG,
      algorithmVersion: 'p0-2-v2',
      inputDigest: 'b'.repeat(64),
      decision: decide({ policy: { ...POLICY, policyVersion: '1.1.0', maxCostRatio: '0.10' }, computedAt: '2026-10-03T13:10:00.000Z' }),
    });
    expect(second.assessmentId).not.toBe(first.assessmentId);
    expect(await prisma.recoveryQualificationAssessmentRecord.count()).toBe(2);
    const history = await store.listAssessments({ organizationId: ORG, platformAccountId: ACCOUNT });
    expect(history).toHaveLength(2);
    const latest = await store.loadLatestAssessment({ organizationId: ORG, platformAccountId: ACCOUNT });
    expect((latest?.policyVersion as string)).toBe('1.1.0');
    expect((latest?.qualificationStatus as string)).toBe('NOT_QUALIFIED');
  });

  it('UPDATE / DELETE append-only 判定 → DB 触发器拒绝', async () => {
    const store = createPrismaQualificationAssessmentStore(prisma);
    const written = await store.appendAssessment({
      organizationId: ORG,
      algorithmVersion: 'p0-2-v1',
      inputDigest: 'c'.repeat(64),
      decision: decide(),
    });
    await expect(
      prisma.$executeRawUnsafe('UPDATE "RecoveryQualificationAssessmentRecord" SET "qualificationStatus" = \'QUALIFIED\' WHERE "id" = $1', written.assessmentId),
    ).rejects.toThrow(/RECOVERY_QUALIFICATION_APPEND_ONLY/);
    await expect(
      prisma.$executeRawUnsafe('DELETE FROM "RecoveryQualificationAssessmentRecord" WHERE "id" = $1', written.assessmentId),
    ).rejects.toThrow(/RECOVERY_QUALIFICATION_APPEND_ONLY/);
    expect(await prisma.recoveryQualificationAssessmentRecord.count()).toBe(1);
  });

  it('跨租户：写入拒绝 + 读取隔离（B 租户看不到 A 的判定）', async () => {
    const store = createPrismaQualificationAssessmentStore(prisma);
    await store.appendAssessment({ organizationId: ORG, algorithmVersion: 'p0-2-v1', inputDigest: 'd'.repeat(64), decision: decide() });
    await expect(
      store.appendAssessment({
        organizationId: ORG_B,
        algorithmVersion: 'p0-2-v1',
        inputDigest: 'd'.repeat(64),
        decision: decide(),
      }),
    ).rejects.toThrow(/CROSS_TENANT_REJECTED/);
    expect(await store.listAssessments({ organizationId: ORG_B, platformAccountId: ACCOUNT })).toHaveLength(0);
  });

  it('确定性：同一判定两次派生同一 assessmentId（可重放）', async () => {
    const store = createPrismaQualificationAssessmentStore(prisma);
    const decision = decide();
    const id = qualificationAssessmentId({
      organizationId: ORG,
      platformAccountId: ACCOUNT,
      policyId: decision.policyId,
      policyVersion: decision.policyVersion,
      algorithmVersion: 'p0-2-v1',
      inputDigest: 'e'.repeat(64),
      computedAt: decision.computedAt,
    });
    const written = await store.appendAssessment({
      organizationId: ORG,
      algorithmVersion: 'p0-2-v1',
      inputDigest: 'e'.repeat(64),
      decision,
    });
    expect(written.assessmentId).toBe(id);
    expect(written.assessmentId).toHaveLength(32);
  });
});
