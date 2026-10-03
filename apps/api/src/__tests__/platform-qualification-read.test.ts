/**
 * CHANGE A（MSG-20261003-141）— Platform Qualification Read Projection 真实 PostgreSQL 验收。
 * 断言：只读投影真实来自持久化判定（status / reasonCodes / policy / computedAt）；
 *       INDETERMINATE / NOT_QUALIFIED 原样返回；判 404（未知账户 / 跨租户）；403（VIEWER）；400（空 ID）；
 *       读取不重算（读取前后判定行数不变）。
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { evaluateCustomerQualification, type RecoveryEconomicsPolicy } from '../services/commercial/customer-qualification-gate';
import { createPrismaQualificationAssessmentStore } from '../services/commercial/recovery-qualification-store';
import { getQualificationReadProjection, type QualificationReadDeps } from '../services/commercial/qualification-read';

const prisma = new PrismaClient();
const ORG = 'cc270000-0000-4000-8000-000000000001';
const ORG_B = 'cc270000-0000-4000-8000-000000000002';
const NOW = '2026-10-04T06:00:00.000Z';

const POLICY: RecoveryEconomicsPolicy = {
  policyId: 'recovery-economics-2026',
  policyVersion: '1.0.0',
  currency: 'USD',
  minimumRecoveryThreshold: '100.00',
  highValueThreshold: '10000.00',
  maxCostRatio: '0.35',
  minimumDataCompleteness: '0.80',
};

const store = () => createPrismaQualificationAssessmentStore(prisma);
const deps: QualificationReadDeps = {
  loadLatest: (args) => store().loadLatestAssessment(args),
};

const appendDecision = async (qualificationStatus: 'QUALIFIED' | 'INDETERMINATE' | 'NOT_QUALIFIED') => {
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
    estimatedRecoveryAmount: qualificationStatus === 'NOT_QUALIFIED' ? '50.00' : '1000.00',
    estimatedExternalApiCost: '100.00',
    estimatedBrokerCost: '100.00',
    policy: POLICY,
    computedAt: NOW,
  });
  const forced = { ...decision, qualificationStatus };
  await store().appendAssessment({
    organizationId: ORG,
    algorithmVersion: 'v1',
    inputDigest: 'a'.repeat(64),
    decision: forced,
    payload: { reasonCodes: forced.reasonCodes },
  });
};

const call = (platformAccountId = 'acct-1', role = 'OWNER', organizationId = ORG) =>
  getQualificationReadProjection({ session: { organizationId, actorUserId: 'actor-1', role }, deps, platformAccountId });

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
  await prisma.organization.create({ data: { id: ORG, name: 'QUAL 读租户', slug: 'qual-read-org' } });
  await prisma.organization.create({ data: { id: ORG_B, name: 'QUAL 读租户B', slug: 'qual-read-org-b' } });
});

describe('CHANGE A — Platform Qualification Read Projection（真实 PostgreSQL）', () => {
  it('真实读取持久化判定：status / reasonCodes / policy / computedAt 原样返回，且只读不重算', async () => {
    await appendDecision('QUALIFIED');
    const before = await prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*)::bigint AS n FROM "RecoveryQualificationAssessmentRecord"');
    const result = await call();
    const after = await prisma.$queryRawUnsafe<{ n: bigint }[]>('SELECT count(*)::bigint AS n FROM "RecoveryQualificationAssessmentRecord"');
    expect(result.status).toBe(200);
    const qualification = result.body.qualification as Record<string, unknown>;
    expect(qualification.status).toBe('QUALIFIED');
    expect(qualification.policyId).toBe('recovery-economics-2026');
    expect(qualification.policyVersion).toBe('1.0.0');
    expect(qualification.algorithmVersion).toBe('v1');
    expect(Array.isArray(qualification.reasonCodes)).toBe(true);
    expect(String(qualification.computedAt)).toContain('2026-10-04');
    expect((result.body.boundary as Record<string, unknown>).recomputedOnRead).toBe(false);
    expect((result.body.boundary as Record<string, unknown>).filingAuthorized).toBe(false);
    expect(after[0].n).toBe(before[0].n);
  });

  it('INDETERMINATE / NOT_QUALIFIED 原样展示（不做美化）', async () => {
    await appendDecision('INDETERMINATE');
    expect(((await call()).body.qualification as Record<string, unknown>).status).toBe('INDETERMINATE');

    await prisma.$executeRawUnsafe('TRUNCATE TABLE "RecoveryQualificationAssessmentRecord" CASCADE');
    await appendDecision('NOT_QUALIFIED');
    expect(((await call()).body.qualification as Record<string, unknown>).status).toBe('NOT_QUALIFIED');
  });

  it('RBAC / 参数 / 租户：VIEWER 403；空 ID 400；未知账户 404；跨租户 404', async () => {
    await appendDecision('QUALIFIED');
    expect((await call('acct-1', 'VIEWER')).status).toBe(403);
    expect((await call('  ', 'OWNER')).status).toBe(400);
    expect((await call('acct-unknown', 'OWNER')).status).toBe(404);
    expect((await call('acct-1', 'OWNER', ORG_B)).status).toBe(404);
    expect((await call('acct-1', 'FINANCE')).status).toBe(200);
  });
});
