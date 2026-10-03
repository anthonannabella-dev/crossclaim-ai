/**
 * R45 S5 —— 只读一致性 checker（真实 PostgreSQL）
 * ---------------------------------------------------------------------------
 * 依据：MSG-20261002-50 ③（read-only checker + permanent regression closure；DETECT ≠ REPAIR）。
 * 断言：
 *   - clean 数据库 → checker 通过（无异常），且**执行前后关键表快照一致**（只读）；
 *   - 人工制造漂移 → checker 以 INCONSISTENT[n] 失败（非零语义）。
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import { RECONCILIATION_BASIS_SET_ACTION, RECONCILIATION_OVERRIDE_ACTION, RECONCILIATION_PROVIDER_OUTCOME_ACTION } from '../services/action-guard/approval-verifier';
import { setReconciliationBasis } from '../services/reconciliation/basis-actions';
import { recordManualProviderOutcomeFact, recordReconciliationOverride } from '../services/reconciliation/manual-actions';
import { SYSTEM_EXACT_POLICY_ID, rebuildClaimReconciliationProjection } from '../services/reconciliation/projector';

const prisma = new PrismaClient();
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'r45-s5-pass-1';
/** 由 beforeAll 动态加载（工具脚本为 .mjs，避免 TS 静态解析） */
let CHECKER_SQL = '';

let ORG = '';
let caseId = '';
let claimItemId = '';
let ownerId = '';

const uuid = (): string => randomUUID();
const hex64 = (): string => (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64);

async function runChecker(): Promise<void> {
  await prisma.$executeRawUnsafe(CHECKER_SQL);
}

async function expectInconsistency(expectation: string, expectedIndex: number | string): Promise<void> {
  try {
    await runChecker();
  } catch (error) {
    const text = String((error as Error).message);
    expect(text).toContain(`INCONSISTENT[${expectedIndex}]`);
    expect(text).toContain(expectation.split(' ')[0]);
    return;
  }
  throw new Error(`EXPECTED_INCONSISTENCY_${expectedIndex}_MISSING`);
}

async function issueApproval(input: {
  action: string;
  payload: { amount: string | null; currency: string | null; basisReference: string; evidenceArtifactId: string | null };
  extra: Record<string, string>;
}): Promise<string> {
  await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: ownerId,
      action: 'recovery.review_required',
      entityType: 'Case',
      entityId: caseId,
      changes: { boundAction: input.action } as never,
      createdAt: new Date(Date.now() - 1000),
    },
    select: { id: true },
  });
  const row = await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: ownerId,
      action: 'recovery.review_approved',
      entityType: 'Case',
      entityId: caseId,
      changes: {
        boundAction: input.action,
        boundPayload: { ...input.payload, fingerprintVersion: 'v1', ...input.extra },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      } as never,
      createdAt: new Date(),
    },
    select: { id: true },
  });
  return row.id;
}

async function seedEvidence(): Promise<string> {
  const row = await prisma.evidenceArtifact.create({
    data: { organizationId: ORG, kind: 'EMAIL', title: 'checker-evidence', externalUrl: 'https://evidence.example.com/' + uuid() },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  // 以 CLI 方式调用 checker（与 CI 用法一致），避免 TS/vite 对 .mjs 的模块解析差异
  // cwd = apps/api → 上溯两级到仓库根
  const checkerPath = path.resolve(process.cwd(), '..', '..', 'tools', 'consistency', 'check-reconciliation.mjs');
  CHECKER_SQL = execFileSync(process.execPath, [checkerPath], { encoding: 'utf8' });
  await prisma.$connect();
});

/**
 * 测试夹具隔离：清空 reconciliation 域（含 append-only 表，需临时停用触发器）。
 * 注意：这是**测试夹具**行为；checker 本身只读，绝不做任何修复。
 */
async function resetReconciliationDomain(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM "ClaimReconciliationProjectionFact"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "ClaimReconciliationProjection"`);
  for (const table of [
    'ReconciliationOverrideDecision',
    'ProviderOutcomeFact',
    'ReimbursementFact',
    'ExpectedRecoveryBasis',
  ]) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
  }
  await prisma.$executeRawUnsafe(`DELETE FROM "ReconciliationTolerancePolicy" WHERE "organizationId" IS NOT NULL`);
  await prisma.$executeRawUnsafe(`DELETE FROM "AuditLog"`);
}

afterAll(async () => {
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations')",
  );
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE ' + tables.map((row) => '"' + row.tablename + '"').join(', ') + ' CASCADE;',
    );
  }
  await prisma.$disconnect();
});

beforeEach(async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  await resetReconciliationDomain();
  ORG = uuid();
  await prisma.organization.create({ data: { id: ORG, name: 'R45 S5', slug: 'r45-s5-' + suffix } });
  const owner = await prisma.user.create({
    data: {
      email: 'r45-s5-' + suffix + '@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  ownerId = owner.id;
  await prisma.membership.create({ data: { organizationId: ORG, userId: ownerId, role: 'OWNER', isActive: true } });
  const kase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'R45S5-' + randomUUID().slice(0, 8),
      title: 'R45 S5 fixture',
      domain: 'PLATFORM',
      currency: 'USD',
      openedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  caseId = kase.id;
  const claim = await prisma.claimItem.create({
    data: {
      organizationId: ORG,
      caseId,
      platformType: 'AMAZON',
      claimType: 'ORDER_DISCREPANCY',
      platformRef: 'r45s5-' + uuid(),
      sourceFingerprint: hex64(),
      fingerprintVersion: 'v1',
      occurredAt: new Date('2026-09-02T00:00:00.000Z'),
      currency: 'USD',
      status: 'READY_TO_APPEAL',
      normalizerVersion: 'amazon-sp-normalizer/v1',
    },
  });
  claimItemId = claim.id;
  // 系统 exact policy（CHANGE C 的显式记录）
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ReconciliationTolerancePolicy"
       ("id","organizationId","provider","operation","policyVersion","absoluteTolerance","relativeTolerance","effectiveAt","createdByUserId")
     VALUES ($1, NULL, NULL, NULL, 'v1', 0, 0, CURRENT_TIMESTAMP, 'SYSTEM_EXACT_POLICY')
     ON CONFLICT ("id") DO NOTHING`,
    SYSTEM_EXACT_POLICY_ID,
  );
});

async function seedObserved(amount: string): Promise<string> {
  const row = await prisma.reimbursementFact.create({
    data: {
      organizationId: ORG,
      claimItemId,
      provider: 'amazon',
      kind: 'OBSERVED',
      amount,
      currency: 'USD',
      occurredAt: new Date('2026-09-04T00:00:00.000Z'),
      providerEventId: 'evt-' + uuid(),
      providerEventFingerprint: hex64(),
      fingerprintVersion: 'v1',
      sourceKind: 'OFFICIAL_API',
      sourceRef: 'sp-api/finances/' + uuid(),
      capturedAt: new Date('2026-09-04T01:00:00.000Z'),
      ingestedByUserId: uuid(),
      evidenceArtifactIds: [],
    },
    select: { id: true },
  });
  return row.id;
}

async function seedBasis(amount: string): Promise<string> {
  const approvalId = await issueApproval({
    action: RECONCILIATION_BASIS_SET_ACTION,
    payload: { amount, currency: 'USD', basisReference: 'basis/v1', evidenceArtifactId: null },
    extra: {
      claimItemId,
      caseId,
      expectedRecoveryAmount: amount,
      currency: 'USD',
      basisKind: 'CARRIER_CLAIM',
      basisVersion: 'basis/v1',
    },
  });
  const result = await setReconciliationBasis(
    { prisma },
    {
      organizationId: ORG,
      role: 'OWNER',
      actorUserId: ownerId,
      claimItemId,
      approvalId,
      expectedRecoveryAmount: amount,
      currency: 'USD',
      basisKind: 'CARRIER_CLAIM',
      basisVersion: 'basis/v1',
      basisSource: 'carrier/' + uuid(),
    },
  );
  return result.basisId;
}

async function seedCleanBaseline(): Promise<{ basisId: string; observedId: string }> {
  const basisId = await seedBasis('100.0000');
  const observedId = await seedObserved('100.0000');
  await rebuildClaimReconciliationProjection(prisma, { organizationId: ORG, claimItemId, reason: 'SEED' });
  return { basisId, observedId };
}

describe('R45 S5 · checker（clean → 通过；且只读）', () => {
  it('clean 数据库 → checker 通过，且执行前后关键表快照一致（只读，无自动修复）', async () => {
    await seedCleanBaseline();
    const evidenceId = await seedEvidence();
    const outcomeApproval = await issueApproval({
      action: RECONCILIATION_PROVIDER_OUTCOME_ACTION,
      payload: { amount: null, currency: null, basisReference: 'src-1', evidenceArtifactId: evidenceId },
      extra: {
        caseId,
        provider: 'amazon',
        kind: 'ACCEPTED',
        occurredAt: new Date('2026-09-06T00:00:00.000Z').toISOString(),
        canonicalSourceIdentity: 'src-1',
      },
    });
    await recordManualProviderOutcomeFact(
      { prisma },
      {
        organizationId: ORG,
        role: 'OWNER',
        actorUserId: ownerId,
        caseId,
        claimItemId,
        provider: 'AMAZON',
        kind: 'ACCEPTED',
        sourceResource: 'returns/outcomes',
        canonicalSourceIdentity: 'src-1',
        occurredAt: new Date('2026-09-06T00:00:00.000Z'),
        evidenceIds: [evidenceId],
        reasonCode: 'PROVIDER_EMAIL',
        approvalId: outcomeApproval,
      },
    );

    const snapshot = async () => ({
      projections: await prisma.claimReconciliationProjection.count(),
      members: await prisma.claimReconciliationProjectionFact.count(),
      basis: await prisma.expectedRecoveryBasis.count(),
      audits: await prisma.auditLog.count(),
      facts: await prisma.reimbursementFact.count(),
      outcomes: await prisma.providerOutcomeFact.count(),
    });
    const before = await snapshot();
    await expect(runChecker()).resolves.toBeUndefined();
    const after = await snapshot();
    expect(after).toEqual(before);
  });

  it('projection/net/status 与确定性重算不一致（人为篡改 net）→ INCONSISTENT[4]', async () => {
    const { basisId } = await seedCleanBaseline();
    expect(basisId).toBeTruthy();
    await prisma.$executeRawUnsafe(`UPDATE "ClaimReconciliationProjection" SET "netMatchedObservedAmount" = 999`);
    await expectInconsistency('NET_MISMATCH', 4);
  });

  it('FULLY_RECONCILED 但 basisId 为空 → INCONSISTENT[4]', async () => {
    await seedCleanBaseline();
    await prisma.$executeRawUnsafe(
      `UPDATE "ClaimReconciliationProjection" SET "basisId" = NULL, "tolerancePolicyId" = $1`,
      SYSTEM_EXACT_POLICY_ID,
    );
    await expectInconsistency('FULLY_WITHOUT_BASIS', 4);
  });

  it('projection 引用 dangling basis → INCONSISTENT[2]', async () => {
    await seedCleanBaseline();
    await prisma.$executeRawUnsafe(`UPDATE "ClaimReconciliationProjection" SET "basisId" = $1`, uuid());
    await expectInconsistency('dangling', 2);
  });

  it('projection 引用 cross-tenant policy → INCONSISTENT[3]', async () => {
    await seedCleanBaseline();
    const foreignOrg = uuid();
    await prisma.organization.create({ data: { id: foreignOrg, name: 'foreign', slug: 'foreign-' + uuid().slice(0, 8) } });
    const foreignPolicy = await prisma.reconciliationTolerancePolicy.create({
      data: {
        organizationId: foreignOrg,
        provider: 'amazon',
        operation: 'RECONCILIATION',
        policyVersion: 'v1',
        absoluteTolerance: '0',
        relativeTolerance: '0',
        effectiveAt: new Date('2026-09-08T00:00:00.000Z'),
        createdByUserId: uuid(),
      },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "ClaimReconciliationProjection" SET "tolerancePolicyId" = $1`,
      foreignPolicy.id,
    );
    await expectInconsistency('dangling', 3);
  });

  it('over-recovery（AMBIGUOUS 且 net > expected）缺 AMOUNT_EXCEEDS_EXPECTED reason → INCONSISTENT[5]', async () => {
    await seedBasis('100.0000');
    await seedObserved('150.0000');
    await rebuildClaimReconciliationProjection(prisma, { organizationId: ORG, claimItemId, reason: 'SEED' });
    // 抹掉 rebuild audit 中的 reason，模拟漂移
    await prisma.$executeRawUnsafe(
      `UPDATE "AuditLog" SET "changes" = jsonb_set("changes", '{ambiguityReasons}', '[]'::jsonb)
        WHERE "organizationId" = $1 AND "action" = 'reconciliation.projection_rebuilt'`,
      ORG,
    );
    await expectInconsistency('over-recovery', 5);
  });

  it('membership generation 与 header 不一致 → INCONSISTENT[1]', async () => {
    const { basisId } = await seedCleanBaseline();
    expect(basisId).toBeTruthy();
    // 漂移注入：临时停用 DB 立即触发器后写入 stale generation（checker 本身不写）
    await prisma.$executeRawUnsafe(`ALTER TABLE "ClaimReconciliationProjectionFact" DISABLE TRIGGER USER`);
    await prisma.$executeRawUnsafe(
      `UPDATE "ClaimReconciliationProjectionFact" SET "projectionVersion" = "projectionVersion" + 1`,
    );
    await prisma.$executeRawUnsafe(`ALTER TABLE "ClaimReconciliationProjectionFact" ENABLE TRIGGER USER`);
    await expectInconsistency('projection membership generation mismatch', 1);
  });

  it('matchedFactIds 摘要与 membership 关系表不一致 → INCONSISTENT[14]', async () => {
    const { basisId } = await seedCleanBaseline();
    expect(basisId).toBeTruthy();
    await prisma.$executeRawUnsafe(`UPDATE "ClaimReconciliationProjection" SET "matchedFactIds" = ARRAY[]::text[]`);
    await expectInconsistency('matchedFactIds', 14);
  });

  it('人工 provider outcome 缺少消费审计 → INCONSISTENT[12]', async () => {
    const evidenceId = await seedEvidence();
    const approvalId = await issueApproval({
      action: RECONCILIATION_PROVIDER_OUTCOME_ACTION,
      payload: { amount: null, currency: null, basisReference: 'src-x', evidenceArtifactId: evidenceId },
      extra: {
        caseId,
        provider: 'amazon',
        kind: 'ACCEPTED',
        occurredAt: new Date('2026-09-06T00:00:00.000Z').toISOString(),
        canonicalSourceIdentity: 'src-x',
      },
    });
    await recordManualProviderOutcomeFact(
      { prisma },
      {
        organizationId: ORG,
        role: 'OWNER',
        actorUserId: ownerId,
        caseId,
        claimItemId,
        provider: 'AMAZON',
        kind: 'ACCEPTED',
        sourceResource: 'returns/outcomes',
        canonicalSourceIdentity: 'src-x',
        occurredAt: new Date('2026-09-06T00:00:00.000Z'),
        evidenceIds: [evidenceId],
        reasonCode: 'PROVIDER_EMAIL',
        approvalId,
      },
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "AuditLog" WHERE "organizationId" = $1 AND "action" = 'recovery.approval_consumed'`,
      ORG,
    );
    await expectInconsistency('manual provider outcome without valid consumed approval', 12);
  });

  it('override 的 approval 未消费 → INCONSISTENT[11]', async () => {
    const observedId = await seedObserved('100.0000');
    const evidenceId = await seedEvidence();
    const approvalId = await issueApproval({
      action: RECONCILIATION_OVERRIDE_ACTION,
      payload: { amount: null, currency: null, basisReference: 'NOT_OUR_CLAIM', evidenceArtifactId: evidenceId },
      extra: { claimItemId, reimbursementFactId: observedId, decisionKind: 'UNMATCHED' },
    });
    await recordReconciliationOverride(
      { prisma },
      {
        organizationId: ORG,
        role: 'OWNER',
        actorUserId: ownerId,
        claimItemId,
        reimbursementFactId: observedId,
        decisionKind: 'UNMATCHED',
        reasonCode: 'NOT_OUR_CLAIM',
        reasonText: 'x',
        evidenceIds: [evidenceId],
        approvalId,
      },
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "AuditLog" WHERE "organizationId" = $1 AND "action" = 'recovery.approval_consumed'`,
      ORG,
    );
    await expectInconsistency('override approval binding invalid', 11);
  });

  it('dangling evidence（provider outcome 事实引用不存在证据）→ INCONSISTENT[9a]', async () => {
    await prisma.providerOutcomeFact.create({
      data: {
        organizationId: ORG,
        caseId,
        claimItemId,
        provider: 'amazon',
        kind: 'ACCEPTED',
        occurredAt: new Date('2026-09-06T00:00:00.000Z'),
        providerEventFingerprint: hex64(),
        fingerprintVersion: 'v1',
        sourceKind: 'OFFICIAL_API',
        sourceRef: 'api/x',
        capturedAt: new Date('2026-09-06T01:00:00.000Z'),
        ingestedByUserId: ownerId,
        evidenceArtifactIds: [uuid()],
      },
    });
    await expectInconsistency('dangling', '9a');
  });

  it('provider identity 冲突（同 providerEventId 多个指纹）→ INCONSISTENT[13]', async () => {
    const sharedEventId = 'evt-shared-' + uuid();
    for (let i = 0; i < 2; i += 1) {
      await prisma.providerOutcomeFact.create({
        data: {
          organizationId: ORG,
          caseId,
          claimItemId,
          provider: 'amazon',
          kind: 'ACCEPTED',
          occurredAt: new Date('2026-09-06T00:00:00.000Z'),
          providerEventId: sharedEventId,
          providerEventFingerprint: hex64(),
          fingerprintVersion: 'v1',
          sourceKind: 'OFFICIAL_API',
          sourceRef: 'api/' + i,
          capturedAt: new Date('2026-09-06T01:00:00.000Z'),
          ingestedByUserId: ownerId,
          evidenceArtifactIds: [],
        },
      });
    }
    await expectInconsistency('provider event identity collision', 13);
  });
});
