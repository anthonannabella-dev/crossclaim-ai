/**
 * R45 S4（第一批）—— expected basis 建立 / supersede 受保护动作（真实 PostgreSQL）
 * 依据：MSG-20261002-49 ③（S4 授权）+ MSG-20261001-46 Q1（supersede 事务顺序冻结）。
 *
 * 说明：审批事实在本测试中**直接构造**为 `recovery.review_approved` 审计行（等价于
 * `submitRecoveryReview` 写入的形状：boundAction + boundPayload + extra 指纹），
 * 以便聚焦执行侧边界；approval **创建**路径的绑定要求已单独由注册批次覆盖。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import {
  RECONCILIATION_BASIS_SET_ACTION,
  RECONCILIATION_BASIS_SUPERSEDE_ACTION,
} from '../services/action-guard/approval-verifier';
import {
  RECONCILIATION_BASIS_SET_RECORDED_ACTION,
  RECONCILIATION_BASIS_SUPERSEDED_ACTION,
  setReconciliationBasis,
  supersedeReconciliationBasis,
} from '../services/reconciliation/basis-actions';

const prisma = new PrismaClient();
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'r45-s4-pass-1';

let ORG_A = '';
let ORG_B = '';
let caseA = '';
let caseB = '';
let claimA = '';
let claimB = '';
let ownerId = '';
let viewerId = '';

const uuid = (): string => randomUUID();
const hex64 = (): string => (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64);

async function seedOrg(slugSuffix: string): Promise<{ organizationId: string; ownerId: string }> {
  const id = uuid();
  await prisma.organization.create({ data: { id, name: 'R45 S4 ' + slugSuffix, slug: 'r45-s4-' + slugSuffix } });
  const owner = await prisma.user.create({
    data: {
      email: 'r45-s4-owner-' + slugSuffix + '@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: id, userId: owner.id, role: 'OWNER', isActive: true } });
  return { organizationId: id, ownerId: owner.id };
}

async function seedViewer(organizationId: string): Promise<string> {
  const viewer = await prisma.user.create({
    data: {
      email: 'r45-s4-viewer-' + uuid() + '@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'VIEWER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId, userId: viewer.id, role: 'VIEWER', isActive: true } });
  return viewer.id;
}

async function seedCase(organizationId: string): Promise<string> {
  const created = await prisma.case.create({
    data: {
      organizationId,
      caseNo: 'R45S4-' + randomUUID().slice(0, 8),
      title: 'R45 S4 fixture',
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
      platformRef: 'r45s4-' + uuid(),
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

/** 直接构造与 submitRecoveryReview 一致的 approval 审计行（boundAction + boundPayload + extra 指纹） */
async function issueApproval(input: {
  organizationId: string;
  caseId: string;
  approverUserId: string;
  action: string;
  amount: string;
  currency: string;
  basisVersion: string;
  extra: Record<string, string>;
}): Promise<string> {
  // 审批前置：与真实流程一致，必须先存在 recovery.review_required（否则 APPROVAL_NOT_APPROVED）
  await prisma.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.approverUserId,
      action: 'recovery.review_required',
      entityType: 'Case',
      entityId: input.caseId,
      changes: { boundAction: input.action } as never,
      createdAt: new Date(Date.now() - 1000),
    },
    select: { id: true },
  });
  const row = await prisma.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorType: 'USER',
      actorUserId: input.approverUserId,
      action: 'recovery.review_approved',
      entityType: 'Case',
      entityId: input.caseId,
      changes: {
        boundAction: input.action,
        boundPayload: {
          amount: input.amount,
          currency: input.currency,
          basisReference: input.basisVersion,
          evidenceArtifactId: null,
          fingerprintVersion: 'v1',
          ...input.extra,
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      } as never,
      createdAt: new Date(),
    },
    select: { id: true },
  });
  return row.id;
}

async function basisRows(organizationId: string, claimItemId: string) {
  return prisma.expectedRecoveryBasis.findMany({
    where: { organizationId, claimItemId },
    orderBy: { createdAt: 'asc' },
  });
}

async function expectRejection(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const err = error as Error & { code?: string; reason?: string };
    expect(`${err.code ?? ''} ${err.reason ?? ''} ${err.message}`).toMatch(pattern);
    return;
  }
  throw new Error('EXPECTED_BASIS_REJECTION_MISSING: ' + String(pattern));
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
  ownerId = seededA.ownerId;
  viewerId = await seedViewer(ORG_A);
  caseA = await seedCase(ORG_A);
  caseB = await seedCase(ORG_B);
  claimA = await seedClaimItem(ORG_A, caseA);
  claimB = await seedClaimItem(ORG_B, caseB);
});

describe('R45 S4 · recovery.reconciliation_basis_set', () => {
  it('成功建立：写入 basis + 业务审计 + approval 消费（同一事务）', async () => {
    const amount = '250.0000';
    const approvalId = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_BASIS_SET_ACTION,
      amount,
      currency: 'USD',
      basisVersion: 'basis/v1',
      extra: {
        claimItemId: claimA,
        caseId: caseA,
        expectedRecoveryAmount: amount,
        currency: 'USD',
        basisKind: 'CARRIER_CLAIM',
        basisVersion: 'basis/v1',
      },
    });

    const result = await setReconciliationBasis(
      { prisma },
      {
        organizationId: ORG_A,
        role: 'OWNER',
        actorUserId: ownerId,
        claimItemId: claimA,
        approvalId,
        expectedRecoveryAmount: amount,
        currency: 'usd',
        basisKind: 'CARRIER_CLAIM',
        basisVersion: 'basis/v1',
        basisSource: 'carrier-report/' + uuid(),
      },
    );

    expect(result.operation).toBe('SET');
    expect(result.currency).toBe('USD');
    expect(result.expectedRecoveryAmount).toBe('250.0000');
    expect(result.approvalConsumed).toBe(true);
    expect(result.platformWriteExecuted).toBe(false);

    const rows = await basisRows(ORG_A, claimA);
    expect(rows).toHaveLength(1);
    expect(rows[0].supersededAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, action: RECONCILIATION_BASIS_SET_RECORDED_ACTION } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, action: 'recovery.approval_consumed' } })).toBe(1);
  });

  it('已有 effective basis 时不得用 SET（必须走 supersede）：零写入', async () => {
    const amount = '100.0000';
    const approvalId = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_BASIS_SET_ACTION,
      amount,
      currency: 'USD',
      basisVersion: 'basis/v1',
      extra: {
        claimItemId: claimA,
        caseId: caseA,
        expectedRecoveryAmount: amount,
        currency: 'USD',
        basisKind: 'CARRIER_CLAIM',
        basisVersion: 'basis/v1',
      },
    });
    const first = await setReconciliationBasis(
      { prisma },
      {
        organizationId: ORG_A,
        role: 'OWNER',
        actorUserId: ownerId,
        claimItemId: claimA,
        approvalId,
        expectedRecoveryAmount: amount,
        currency: 'USD',
        basisKind: 'CARRIER_CLAIM',
        basisVersion: 'basis/v1',
        basisSource: 'carrier-report/' + uuid(),
      },
    );
    expect(first.basisId).toBeTruthy();

    const secondApproval = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_BASIS_SET_ACTION,
      amount: '101.0000',
      currency: 'USD',
      basisVersion: 'basis/v1',
      extra: {
        claimItemId: claimA,
        caseId: caseA,
        expectedRecoveryAmount: '101.0000',
        currency: 'USD',
        basisKind: 'CARRIER_CLAIM',
        basisVersion: 'basis/v1',
      },
    });
    await expectRejection(
      () =>
        setReconciliationBasis(
          { prisma },
          {
            organizationId: ORG_A,
            role: 'OWNER',
            actorUserId: ownerId,
            claimItemId: claimA,
            approvalId: secondApproval,
            expectedRecoveryAmount: '101.0000',
            currency: 'USD',
            basisKind: 'CARRIER_CLAIM',
            basisVersion: 'basis/v1',
            basisSource: 'carrier-report/' + uuid(),
          },
        ),
      /CONFLICT|已存在 effective basis/,
    );
    expect(await basisRows(ORG_A, claimA)).toHaveLength(1);
  });

  it('审批动作不匹配 / 载荷指纹不一致 → fail-closed（零写入、不消费 approval）', async () => {
    const amount = '100.0000';
    const mismatchedAction = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_BASIS_SUPERSEDE_ACTION,
      amount,
      currency: 'USD',
      basisVersion: 'basis/v1',
      extra: {
        claimItemId: claimA,
        caseId: caseA,
        expectedRecoveryAmount: amount,
        currency: 'USD',
        basisKind: 'CARRIER_CLAIM',
        basisVersion: 'basis/v1',
      },
    });
    await expectRejection(
      () =>
        setReconciliationBasis(
          { prisma },
          {
            organizationId: ORG_A,
            role: 'OWNER',
            actorUserId: ownerId,
            claimItemId: claimA,
            approvalId: mismatchedAction,
            expectedRecoveryAmount: amount,
            currency: 'USD',
            basisKind: 'CARRIER_CLAIM',
            basisVersion: 'basis/v1',
            basisSource: 'carrier-report/' + uuid(),
          },
        ),
      /APPROVAL_ACTION_MISMATCH|APPROVAL_NOT_VERIFIED/,
    );

    const mismatchedPayload = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_BASIS_SET_ACTION,
      amount: '999.0000',
      currency: 'USD',
      basisVersion: 'basis/v1',
      extra: {
        claimItemId: claimA,
        caseId: caseA,
        expectedRecoveryAmount: '999.0000',
        currency: 'USD',
        basisKind: 'CARRIER_CLAIM',
        basisVersion: 'basis/v1',
      },
    });
    await expectRejection(
      () =>
        setReconciliationBasis(
          { prisma },
          {
            organizationId: ORG_A,
            role: 'OWNER',
            actorUserId: ownerId,
            claimItemId: claimA,
            approvalId: mismatchedPayload,
            expectedRecoveryAmount: amount,
            currency: 'USD',
            basisKind: 'CARRIER_CLAIM',
            basisVersion: 'basis/v1',
            basisSource: 'carrier-report/' + uuid(),
          },
        ),
      /APPROVAL_PAYLOAD_MISMATCH|APPROVAL_NOT_VERIFIED/,
    );

    expect(await basisRows(ORG_A, claimA)).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, action: 'recovery.approval_consumed' } })).toBe(0);
  });

  it('角色：锁前快速拒绝（VIEWER）+ 锁内成员失效（零写入）', async () => {
    const amount = '100.0000';
    const approvalId = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_BASIS_SET_ACTION,
      amount,
      currency: 'USD',
      basisVersion: 'basis/v1',
      extra: {
        claimItemId: claimA,
        caseId: caseA,
        expectedRecoveryAmount: amount,
        currency: 'USD',
        basisKind: 'CARRIER_CLAIM',
        basisVersion: 'basis/v1',
      },
    });
    await expectRejection(
      () =>
        setReconciliationBasis(
          { prisma },
          {
            organizationId: ORG_A,
            role: 'VIEWER',
            actorUserId: viewerId,
            claimItemId: claimA,
            approvalId,
            expectedRecoveryAmount: amount,
            currency: 'USD',
            basisKind: 'CARRIER_CLAIM',
            basisVersion: 'basis/v1',
            basisSource: 'carrier-report/' + uuid(),
          },
        ),
      /FORBIDDEN|权限/,
    );

    await prisma.membership.updateMany({ where: { organizationId: ORG_A, userId: ownerId }, data: { isActive: false } });
    await expectRejection(
      () =>
        setReconciliationBasis(
          { prisma },
          {
            organizationId: ORG_A,
            role: 'OWNER',
            actorUserId: ownerId,
            claimItemId: claimA,
            approvalId,
            expectedRecoveryAmount: amount,
            currency: 'USD',
            basisKind: 'CARRIER_CLAIM',
            basisVersion: 'basis/v1',
            basisSource: 'carrier-report/' + uuid(),
          },
        ),
      /FORBIDDEN|活跃成员|权限/,
    );
    expect(await basisRows(ORG_A, claimA)).toHaveLength(0);
  });

  it('跨租户 claimItem → NOT_FOUND（零写入）', async () => {
    const amount = '100.0000';
    const approvalId = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_BASIS_SET_ACTION,
      amount,
      currency: 'USD',
      basisVersion: 'basis/v1',
      extra: {
        claimItemId: claimB,
        caseId: caseA,
        expectedRecoveryAmount: amount,
        currency: 'USD',
        basisKind: 'CARRIER_CLAIM',
        basisVersion: 'basis/v1',
      },
    });
    await expectRejection(
      () =>
        setReconciliationBasis(
          { prisma },
          {
            organizationId: ORG_A,
            role: 'OWNER',
            actorUserId: ownerId,
            claimItemId: claimB,
            approvalId,
            expectedRecoveryAmount: amount,
            currency: 'USD',
            basisKind: 'CARRIER_CLAIM',
            basisVersion: 'basis/v1',
            basisSource: 'carrier-report/' + uuid(),
          },
        ),
      /NOT_FOUND|不存在/,
    );
    expect(await basisRows(ORG_A, claimB)).toHaveLength(0);
  });
});

describe('R45 S4 · recovery.reconciliation_basis_supersede', () => {
  async function seedEffectiveBasis(amount = '100.0000'): Promise<string> {
    const approvalId = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_BASIS_SET_ACTION,
      amount,
      currency: 'USD',
      basisVersion: 'basis/v1',
      extra: {
        claimItemId: claimA,
        caseId: caseA,
        expectedRecoveryAmount: amount,
        currency: 'USD',
        basisKind: 'CARRIER_CLAIM',
        basisVersion: 'basis/v1',
      },
    });
    const result = await setReconciliationBasis(
      { prisma },
      {
        organizationId: ORG_A,
        role: 'OWNER',
        actorUserId: ownerId,
        claimItemId: claimA,
        approvalId,
        expectedRecoveryAmount: amount,
        currency: 'USD',
        basisKind: 'CARRIER_CLAIM',
        basisVersion: 'basis/v1',
        basisSource: 'carrier-report/' + uuid(),
      },
    );
    return result.basisId;
  }

  it('成功取代：旧 basis 永久保留且被标记 superseded，新 basis 成为唯一 effective', async () => {
    const oldBasisId = await seedEffectiveBasis('100.0000');
    const amount = '150.0000';
    const approvalId = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_BASIS_SUPERSEDE_ACTION,
      amount,
      currency: 'USD',
      basisVersion: 'basis/v2',
      extra: {
        claimItemId: claimA,
        caseId: caseA,
        supersedesBasisId: oldBasisId,
        expectedRecoveryAmount: amount,
        currency: 'USD',
        basisKind: 'PROVIDER_POLICY',
        basisVersion: 'basis/v2',
      },
    });

    const result = await supersedeReconciliationBasis(
      { prisma },
      {
        organizationId: ORG_A,
        role: 'OWNER',
        actorUserId: ownerId,
        claimItemId: claimA,
        approvalId,
        supersedesBasisId: oldBasisId,
        expectedRecoveryAmount: amount,
        currency: 'USD',
        basisKind: 'PROVIDER_POLICY',
        basisVersion: 'basis/v2',
        basisSource: 'policy-report/' + uuid(),
      },
    );

    expect(result.operation).toBe('SUPERSEDE');
    expect(result.supersededBasisId).toBe(oldBasisId);
    const rows = await basisRows(ORG_A, claimA);
    expect(rows).toHaveLength(2);
    const oldRow = rows.find((row) => row.id === oldBasisId)!;
    expect(oldRow.supersededAt).not.toBeNull();
    expect(oldRow.supersededByBasisId).toBe(result.basisId);
    const effective = rows.filter((row) => row.supersededAt === null);
    expect(effective).toHaveLength(1);
    expect(effective[0].id).toBe(result.basisId);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, action: RECONCILIATION_BASIS_SUPERSEDED_ACTION } })).toBe(1);
  });

  it('supersedesBasisId 与当前 effective 不一致 → CONFLICT（旧 basis 保持 effective）', async () => {
    const oldBasisId = await seedEffectiveBasis('100.0000');
    const amount = '150.0000';
    const approvalId = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_BASIS_SUPERSEDE_ACTION,
      amount,
      currency: 'USD',
      basisVersion: 'basis/v2',
      extra: {
        claimItemId: claimA,
        caseId: caseA,
        supersedesBasisId: uuid(),
        expectedRecoveryAmount: amount,
        currency: 'USD',
        basisKind: 'PROVIDER_POLICY',
        basisVersion: 'basis/v2',
      },
    });
    await expectRejection(
      () =>
        supersedeReconciliationBasis(
          { prisma },
          {
            organizationId: ORG_A,
            role: 'OWNER',
            actorUserId: ownerId,
            claimItemId: claimA,
            approvalId,
            supersedesBasisId: uuid(),
            expectedRecoveryAmount: amount,
            currency: 'USD',
            basisKind: 'PROVIDER_POLICY',
            basisVersion: 'basis/v2',
            basisSource: 'policy-report/' + uuid(),
          },
        ),
      /CONFLICT|不一致/,
    );
    const rows = await basisRows(ORG_A, claimA);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(oldBasisId);
    expect(rows[0].supersededAt).toBeNull();
  });

  it('无 effective basis 时 supersede → NOT_FOUND（零写入）', async () => {
    const amount = '150.0000';
    const approvalId = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_BASIS_SUPERSEDE_ACTION,
      amount,
      currency: 'USD',
      basisVersion: 'basis/v2',
      extra: {
        claimItemId: claimA,
        caseId: caseA,
        supersedesBasisId: uuid(),
        expectedRecoveryAmount: amount,
        currency: 'USD',
        basisKind: 'PROVIDER_POLICY',
        basisVersion: 'basis/v2',
      },
    });
    await expectRejection(
      () =>
        supersedeReconciliationBasis(
          { prisma },
          {
            organizationId: ORG_A,
            role: 'OWNER',
            actorUserId: ownerId,
            claimItemId: claimA,
            approvalId,
            supersedesBasisId: uuid(),
            expectedRecoveryAmount: amount,
            currency: 'USD',
            basisKind: 'PROVIDER_POLICY',
            basisVersion: 'basis/v2',
            basisSource: 'policy-report/' + uuid(),
          },
        ),
      /NOT_FOUND|不存在 effective basis/,
    );
    expect(await basisRows(ORG_A, claimA)).toHaveLength(0);
  });

  it('后置写入失败 → 整个事务回滚：旧 basis 仍 effective、无新 basis、approval 不消费', async () => {
    const oldBasisId = await seedEffectiveBasis('100.0000');
    const amount = '150.0000';
    const approvalId = await issueApproval({
      organizationId: ORG_A,
      caseId: caseA,
      approverUserId: ownerId,
      action: RECONCILIATION_BASIS_SUPERSEDE_ACTION,
      amount,
      currency: 'USD',
      basisVersion: 'basis/v2',
      extra: {
        claimItemId: claimA,
        caseId: caseA,
        supersedesBasisId: oldBasisId,
        expectedRecoveryAmount: amount,
        currency: 'USD',
        basisKind: 'PROVIDER_POLICY',
        basisVersion: 'basis/v2',
      },
    });
    const consumedBefore = await prisma.auditLog.count({ where: { organizationId: ORG_A, action: 'recovery.approval_consumed' } });

    await expectRejection(
      () =>
        supersedeReconciliationBasis(
          { prisma },
          {
            organizationId: ORG_A,
            role: 'OWNER',
            actorUserId: ownerId,
            claimItemId: claimA,
            approvalId,
            supersedesBasisId: oldBasisId,
            expectedRecoveryAmount: amount,
            currency: 'USD',
            basisKind: 'PROVIDER_POLICY',
            basisVersion: 'basis/v2',
            basisSource: 'policy-report/' + uuid(),
            // 故障注入：非法日期 → INSERT 阶段失败（旧 basis 的 supersede UPDATE 必须一并回滚）
            effectiveAt: new Date('invalid'),
          },
        ),
      /./,
    );

    const rows = await basisRows(ORG_A, claimA);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(oldBasisId);
    expect(rows[0].supersededAt).toBeNull();
    expect(rows[0].supersededByBasisId).toBeNull();
    expect(await prisma.auditLog.count({ where: { organizationId: ORG_A, action: 'recovery.approval_consumed' } })).toBe(consumedBefore);
  });
});
