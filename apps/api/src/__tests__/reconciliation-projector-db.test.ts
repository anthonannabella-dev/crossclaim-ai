/**
 * R45 S3 —— deterministic projector（真实 PostgreSQL，IO 层）
 * ---------------------------------------------------------------------------
 * 依据：MSG-20261002-48 的 S3 永久验收清单（deterministic / 重建一致 / 中途失败完整回滚 /
 * stale generation / dangling·cross-tenant basis·policy / system exact policy 幂等创建与并发唯一 /
 * Projection 保存实际 basisId+policyId/version / reversal 后状态回退 / currency mismatch /
 * conflicting evidence / membership generation 严格一致 / projector 不写 immutable Fact）。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import {
  RECONCILIATION_PROJECTION_REBUILT_ACTION,
  SYSTEM_EXACT_POLICY_ID,
  rebuildClaimReconciliationProjection,
} from '../services/reconciliation/projector';

const prisma = new PrismaClient();
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'r45-s3-pass-1';

let ORG_A = '';
let ORG_B = '';
let caseA = '';
let caseB = '';
let claimA = '';
let claimB = '';
let actor = '';

const uuid = (): string => randomUUID();
const hex64 = (): string => (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64);

async function seedOrg(slugSuffix: string): Promise<{ organizationId: string; userId: string }> {
  const id = uuid();
  await prisma.organization.create({ data: { id, name: 'R45 S3 ' + slugSuffix, slug: 'r45-s3-' + slugSuffix } });
  const owner = await prisma.user.create({
    data: {
      email: 'r45-s3-' + slugSuffix + '@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: id, userId: owner.id, role: 'OWNER', isActive: true } });
  return { organizationId: id, userId: owner.id };
}

async function seedCase(organizationId: string): Promise<string> {
  const created = await prisma.case.create({
    data: {
      organizationId,
      caseNo: 'R45S3-' + randomUUID().slice(0, 8),
      title: 'R45 S3 fixture',
      domain: 'PLATFORM',
      currency: 'USD',
      openedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  return created.id;
}

async function seedClaimItem(organizationId: string, caseId: string): Promise<string> {
  const created = await prisma.claimItem.create({
    data: {
      organizationId,
      caseId,
      platformType: 'AMAZON',
      claimType: 'ORDER_DISCREPANCY',
      platformRef: 'r45s3-' + randomUUID(),
      sourceFingerprint: hex64(),
      fingerprintVersion: 'v1',
      occurredAt: new Date('2026-09-02T00:00:00.000Z'),
      currency: 'USD',
      status: 'READY_TO_APPEAL',
      normalizerVersion: 'amazon-sp-normalizer/v1',
    },
  });
  return created.id;
}

async function createObserved(
  organizationId: string,
  claimItemId: string,
  amount: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await prisma.reimbursementFact.create({
    data: {
      organizationId,
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
      ...overrides,
    },
  });
  return created.id;
}

async function createBasis(
  organizationId: string,
  claimItemId: string,
  caseId: string,
  amount = '100.0000',
  currency = 'USD',
): Promise<string> {
  const created = await prisma.expectedRecoveryBasis.create({
    data: {
      organizationId,
      claimItemId,
      caseId,
      expectedRecoveryAmount: amount,
      currency,
      basisKind: 'CARRIER_CLAIM',
      basisVersion: 'basis/v1',
      basisSource: 'carrier-report/' + uuid(),
      effectiveAt: new Date('2026-09-03T00:00:00.000Z'),
      createdByUserId: uuid(),
    },
  });
  return created.id;
}

async function readProjection(organizationId: string, claimItemId: string) {
  return prisma.claimReconciliationProjection.findFirst({ where: { organizationId, claimItemId } });
}

async function readMembers(projectionId: string) {
  return prisma.claimReconciliationProjectionFact.findMany({
    where: { projectionId },
    orderBy: { reimbursementFactId: 'asc' },
  });
}

async function expectRejection(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const err = error as Error & { code?: string };
    expect(`${err.code ?? ''} ${err.message}`).toMatch(pattern);
    return;
  }
  throw new Error('EXPECTED_PROJECTOR_REJECTION_MISSING: ' + String(pattern));
}

beforeAll(async () => {
  await prisma.$connect();
});

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
  const seededA = await seedOrg('a-' + suffix);
  const seededB = await seedOrg('b-' + suffix);
  ORG_A = seededA.organizationId;
  ORG_B = seededB.organizationId;
  actor = seededA.userId;
  caseA = await seedCase(ORG_A);
  caseB = await seedCase(ORG_B);
  claimA = await seedClaimItem(ORG_A, caseA);
  claimB = await seedClaimItem(ORG_B, caseB);
  // 幂等确保系统 exact policy 存在（测试夹具会 TRUNCATE 全库）
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ReconciliationTolerancePolicy"
       ("id","organizationId","provider","operation","policyVersion","absoluteTolerance","relativeTolerance","effectiveAt","createdByUserId")
     VALUES ($1, NULL, NULL, NULL, 'v1', 0, 0, CURRENT_TIMESTAMP, 'SYSTEM_EXACT_POLICY')
     ON CONFLICT ("id") DO NOTHING`,
    SYSTEM_EXACT_POLICY_ID,
  );
});

describe('R45 S3 · projector 基本路径', () => {
  it('重建写入 projection + membership（保存实际 basisId / policyId+version），且不写任何 Fact', async () => {
    const basisId = await createBasis(ORG_A, claimA, caseA, '100.0000');
    await createObserved(ORG_A, claimA, '100.0000');
    const factsBefore = await prisma.reimbursementFact.count({ where: { organizationId: ORG_A } });

    const result = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
      actorUserId: actor,
    });

    expect(result.created).toBe(true);
    expect(result.status).toBe('FULLY_RECONCILED');
    expect(result.projectionVersion).toBe(1);
    expect(result.basisId).toBe(basisId);
    expect(result.tolerancePolicyId).toBe(SYSTEM_EXACT_POLICY_ID);
    expect(result.policyVersion).toBe('v1');
    expect(result.netMatchedObservedAmount).toBe('100.0000');

    const projection = await readProjection(ORG_A, claimA);
    expect(projection?.status).toBe('FULLY_RECONCILED');
    expect(projection?.basisId).toBe(basisId);
    expect(projection?.inputDigest).toMatch(/^[0-9a-f]{64}$/);

    const members = await readMembers(projection!.id);
    expect(members).toHaveLength(1);
    expect(members[0].projectionVersion).toBe(projection!.projectionVersion);

    expect(await prisma.reimbursementFact.count({ where: { organizationId: ORG_A } })).toBe(factsBefore);
    expect(await prisma.providerOutcomeFact.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('同一输入重复 rebuild → 相同 inputDigest；版本 +1；membership 整体替换（不累积）', async () => {
    await createBasis(ORG_A, claimA, caseA, '100.0000');
    await createObserved(ORG_A, claimA, '40.0000');
    await createObserved(ORG_A, claimA, '60.0000');

    const first = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
    });
    const second = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
    });

    expect(second.inputDigest).toBe(first.inputDigest);
    expect(second.projectionVersion).toBe(2);
    expect(second.previousInputDigest).toBe(first.inputDigest);
    const members = await readMembers(second.projectionId);
    expect(members).toHaveLength(2);
    expect(members.every((row) => row.projectionVersion === 2)).toBe(true);
  });

  it('删除 Projection 后可从 facts/basis 重建出相同结果（projection 是 cache）', async () => {
    await createBasis(ORG_A, claimA, caseA, '100.0000');
    await createObserved(ORG_A, claimA, '100.0000');
    const first = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
    });

    await prisma.$executeRawUnsafe(`DELETE FROM "ClaimReconciliationProjectionFact" WHERE "projectionId" = $1`, first.projectionId);
    await prisma.$executeRawUnsafe(`DELETE FROM "ClaimReconciliationProjection" WHERE "id" = $1`, first.projectionId);

    const rebuilt = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
    });
    expect(rebuilt.inputDigest).toBe(first.inputDigest);
    expect(rebuilt.status).toBe(first.status);
    expect(rebuilt.created).toBe(true);
  });

  it('audit：写入 reconciliation.projection_rebuilt（含 previous/new digest、version、reason、rebuiltAt）', async () => {
    await createBasis(ORG_A, claimA, caseA, '100.0000');
    await createObserved(ORG_A, claimA, '100.0000');
    const result = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
      actorUserId: actor,
    });
    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: ORG_A, action: RECONCILIATION_PROJECTION_REBUILT_ACTION },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    const changes = audit!.changes as Record<string, unknown>;
    expect(changes.newInputDigest).toBe(result.inputDigest);
    expect(changes.previousInputDigest).toBeNull();
    expect(changes.projectionVersion).toBe(1);
    expect(changes.reason).toBe('MANUAL_REBUILD');
    expect(String(changes.rebuiltAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('R45 S3 · 中途失败必须完整回滚（MSG-48 永久验收）', () => {
  it('DELETE 已执行后 CAS 故障 → 回滚，旧 header + 旧 membership 逐行保持', async () => {
    await createBasis(ORG_A, claimA, caseA, '100.0000');
    await createObserved(ORG_A, claimA, '100.0000');
    const first = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
    });
    const membersBefore = await readMembers(first.projectionId);

    await expectRejection(
      () =>
        rebuildClaimReconciliationProjection(
          prisma,
          { organizationId: ORG_A, claimItemId: claimA, reason: 'FAULT_TEST' },
          {
            hooks: {
              afterDeleteBeforeCas: () => {
                throw new Error('FAULT_AFTER_DELETE');
              },
            },
          },
        ),
      /FAULT_AFTER_DELETE/,
    );

    const projection = await readProjection(ORG_A, claimA);
    expect(projection?.projectionVersion).toBe(first.projectionVersion);
    expect(projection?.inputDigest).toBe(first.inputDigest);
    const membersAfter = await readMembers(first.projectionId);
    expect(membersAfter.map((row) => row.id)).toEqual(membersBefore.map((row) => row.id));
    expect(membersAfter.every((row) => row.projectionVersion === first.projectionVersion)).toBe(true);
  });

  it('DELETE + CAS 已执行后 INSERT 故障 → 同样完整回滚', async () => {
    await createBasis(ORG_A, claimA, caseA, '100.0000');
    await createObserved(ORG_A, claimA, '100.0000');
    const first = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
    });

    await expectRejection(
      () =>
        rebuildClaimReconciliationProjection(
          prisma,
          { organizationId: ORG_A, claimItemId: claimA, reason: 'FAULT_TEST' },
          {
            hooks: {
              afterCasBeforeInsert: () => {
                throw new Error('FAULT_AFTER_CAS');
              },
            },
          },
        ),
      /FAULT_AFTER_CAS/,
    );

    const projection = await readProjection(ORG_A, claimA);
    expect(projection?.projectionVersion).toBe(first.projectionVersion);
    expect(projection?.inputDigest).toBe(first.inputDigest);
    const members = await readMembers(first.projectionId);
    expect(members).toHaveLength(1);
    expect(members[0].projectionVersion).toBe(first.projectionVersion);
  });

  it('stale generation membership → 立即拒绝（DB 不变量在 projector 路径同样生效）', async () => {
    await createBasis(ORG_A, claimA, caseA, '100.0000');
    await createObserved(ORG_A, claimA, '100.0000');
    const first = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
    });
    const existingMemberId = (await readMembers(first.projectionId))[0].reimbursementFactId;
    await expectRejection(
      () =>
        prisma.claimReconciliationProjectionFact.create({
          data: {
            organizationId: ORG_A,
            projectionId: first.projectionId,
            projectionVersion: first.projectionVersion + 1,
            reimbursementFactId: existingMemberId,
          },
        }),
      /STALE_GENERATION|23514|P2002/,
    );
  });
});

describe('R45 S3 · basis / policy 引用强度（CHANGE A / C）', () => {
  it('cross-tenant basis 不被采用；本租户无 effective basis → MATCHED（不宣称 recovered）', async () => {
    await createBasis(ORG_B, claimB, caseB, '100.0000');
    await createObserved(ORG_A, claimA, '100.0000');
    const result = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
    });
    expect(result.status).toBe('MATCHED');
    expect(result.basisId).toBeNull();
    const projection = await readProjection(ORG_A, claimA);
    expect(projection?.basisId).toBeNull();
  });

  it('system exact policy 缺失 → 显式幂等创建，Projection 持久化真实 policyId+version', async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "ReconciliationTolerancePolicy" WHERE "id" = $1`, SYSTEM_EXACT_POLICY_ID);
    await createBasis(ORG_A, claimA, caseA, '100.0000');
    await createObserved(ORG_A, claimA, '100.0000');
    const result = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
    });
    expect(result.tolerancePolicyId).toBe(SYSTEM_EXACT_POLICY_ID);
    expect(result.policyVersion).toBe('v1');
    const policy = await prisma.reconciliationTolerancePolicy.findUnique({ where: { id: SYSTEM_EXACT_POLICY_ID } });
    expect(policy).not.toBeNull();
  });

  // MSG-20261002-49 CHANGE A：引用损坏必须 fail-closed，不得静默降级成「无 basis」
  it('既有 Projection 引用 dangling basis → 重建 fail-closed（不降级为无 basis）', async () => {
    await createBasis(ORG_A, claimA, caseA, '100.0000');
    await createObserved(ORG_A, claimA, '100.0000');
    const first = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
    });
    // 人为制造弱引用损坏（basisId 指向不存在行）
    await prisma.$executeRawUnsafe(
      `UPDATE "ClaimReconciliationProjection" SET "basisId" = $2 WHERE "id" = $1`,
      first.projectionId,
      uuid(),
    );
    await expectRejection(
      () =>
        rebuildClaimReconciliationProjection(prisma, {
          organizationId: ORG_A,
          claimItemId: claimA,
          reason: 'REFERENCE_CHECK',
        }),
      /PROJECTION_BASIS_REFERENCE_INVALID/,
    );
  });

  it('既有 Projection 引用 cross-tenant policy → 重建 fail-closed', async () => {
    await createBasis(ORG_A, claimA, caseA, '100.0000');
    await createObserved(ORG_A, claimA, '100.0000');
    const first = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
    });
    const foreignPolicy = await prisma.reconciliationTolerancePolicy.create({
      data: {
        organizationId: ORG_B,
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
      `UPDATE "ClaimReconciliationProjection" SET "tolerancePolicyId" = $2 WHERE "id" = $1`,
      first.projectionId,
      foreignPolicy.id,
    );
    await expectRejection(
      () =>
        rebuildClaimReconciliationProjection(prisma, {
          organizationId: ORG_A,
          claimItemId: claimA,
          reason: 'REFERENCE_CHECK',
        }),
      /PROJECTION_POLICY_REFERENCE_INVALID/,
    );
  });

  it('并发重建（system policy 缺失）→ 最终仍只有一条 system exact policy', async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "ReconciliationTolerancePolicy" WHERE "id" = $1`, SYSTEM_EXACT_POLICY_ID);
    await createBasis(ORG_A, claimA, caseA, '100.0000');
    await createObserved(ORG_A, claimA, '100.0000');
    await createBasis(ORG_B, claimB, caseB, '50.0000');
    await createObserved(ORG_B, claimB, '50.0000');

    const results = await Promise.allSettled([
      rebuildClaimReconciliationProjection(prisma, { organizationId: ORG_A, claimItemId: claimA, reason: 'CONCURRENT' }),
      rebuildClaimReconciliationProjection(prisma, { organizationId: ORG_B, claimItemId: claimB, reason: 'CONCURRENT' }),
    ]);
    expect(results.some((entry) => entry.status === 'fulfilled')).toBe(true);

    const systemPolicies = await prisma.reconciliationTolerancePolicy.findMany({
      where: { organizationId: null, provider: null, operation: null, supersededAt: null },
    });
    expect(systemPolicies).toHaveLength(1);
    expect(systemPolicies[0].id).toBe(SYSTEM_EXACT_POLICY_ID);
  });
});

describe('R45 S3 · 事实变化后的重算（reversal / currency / conflict / override）', () => {
  it('reversal 后 rebuild：FULLY_RECONCILED → UNMATCHED（事实不变，投影可重算）', async () => {
    await createBasis(ORG_A, claimA, caseA, '100.0000');
    const observedId = await createObserved(ORG_A, claimA, '100.0000');
    const before = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
    });
    expect(before.status).toBe('FULLY_RECONCILED');

    await prisma.reimbursementFact.create({
      data: {
        organizationId: ORG_A,
        claimItemId: claimA,
        provider: 'amazon',
        kind: 'REIMBURSEMENT_REVERSED',
        reversesFactId: observedId,
        amount: null,
        currency: 'USD',
        occurredAt: new Date('2026-09-05T00:00:00.000Z'),
        providerEventId: 'rev-' + uuid(),
        providerEventFingerprint: hex64(),
        fingerprintVersion: 'v1',
        sourceKind: 'OFFICIAL_API',
        sourceRef: 'sp-api/finances/' + uuid(),
        capturedAt: new Date('2026-09-05T01:00:00.000Z'),
        ingestedByUserId: uuid(),
        evidenceArtifactIds: [],
      },
    });

    const after = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'REVERSAL_APPLIED',
    });
    expect(after.status).toBe('UNMATCHED');
    expect(after.netMatchedObservedAmount).toBe('0.0000');
    expect(after.inputDigest).not.toBe(before.inputDigest);
    const members = await readMembers(after.projectionId);
    expect(members).toHaveLength(0);
    // 原始 OBSERVED 事实仍在（append-only）
    expect(await prisma.reimbursementFact.count({ where: { organizationId: ORG_A, kind: 'OBSERVED' } })).toBe(1);
  });

  it('currency mismatch → AMBIGUOUS（不自动换汇）', async () => {
    await createBasis(ORG_A, claimA, caseA, '100.0000', 'USD');
    await createObserved(ORG_A, claimA, '100.0000', { currency: 'EUR' });
    const result = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
    });
    expect(result.status).toBe('AMBIGUOUS');
  });

  it('conflicting evidence（同 providerEventId 不同金额）→ AMBIGUOUS（不按来源择优）', async () => {
    await createBasis(ORG_A, claimA, caseA, '100.0000');
    const shared = 'evt-shared-' + uuid();
    await createObserved(ORG_A, claimA, '100.0000', { providerEventId: shared });
    await createObserved(ORG_A, claimA, '80.0000', { providerEventId: shared });
    const result = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
    });
    expect(result.status).toBe('AMBIGUOUS');
  });

  it('override 参与计算（UNMATCHED 排除该笔；不改原始事实），并改变 inputDigest', async () => {
    await createBasis(ORG_A, claimA, caseA, '150.0000');
    await createObserved(ORG_A, claimA, '100.0000');
    const second = await createObserved(ORG_A, claimA, '50.0000');
    const before = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'MANUAL_REBUILD',
    });
    expect(before.status).toBe('FULLY_RECONCILED');
    expect(before.memberCount).toBe(2);
    expect(before.netMatchedObservedAmount).toBe('150.0000');

    await prisma.reconciliationOverrideDecision.create({
      data: {
        organizationId: ORG_A,
        claimItemId: claimA,
        reimbursementFactId: second,
        decisionKind: 'UNMATCHED',
        reasonCode: 'NOT_OUR_CLAIM',
        reasonText: '该笔赔付不属于本 Claim（人工裁定）',
        approvalId: uuid(),
        decidedByUserId: actor,
        decidedAt: new Date('2026-09-06T00:00:00.000Z'),
      },
    });

    const after = await rebuildClaimReconciliationProjection(prisma, {
      organizationId: ORG_A,
      claimItemId: claimA,
      reason: 'OVERRIDE_APPLIED',
      actorUserId: actor,
    });
    expect(after.status).toBe('PARTIALLY_RECONCILED');
    expect(after.netMatchedObservedAmount).toBe('100.0000');
    expect(after.memberCount).toBe(1);
    expect(after.inputDigest).not.toBe(before.inputDigest);
    // override 不改原始事实
    expect(await prisma.reimbursementFact.count({ where: { organizationId: ORG_A } })).toBe(2);
  });
});
