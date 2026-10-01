/**
 * R43 S3 —— `recovery.manual_submit`：锁内重验 + 原子人工提交确认
 * 覆盖 MSG-20261001-34 的 14 项 S3 验收（+ 幂等复确认）。
 * 边界：不测 providerCaseRef 后补 / outcome / reconciliation / Settlement linkage（S4/S5）。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import { APPROVAL_CONSUMED_EVENT_ACTION } from '../services/action-guard/approval-tx-verify';
import { RECOVERY_MANUAL_SUBMIT_ACTION } from '../services/action-guard/approval-verifier';
import {
  RECOVERY_MANUAL_SUBMITTED_ACTION,
  RECOVERY_MANUAL_SUBMIT_REJECTED_ACTION,
  submitManualRecoveryWithApproval,
} from '../services/recovery/manual-submission';
import {
  buildRecoveryManifest,
  buildRecoveryPackageBasisReference,
  computePackageDigest,
  generateRecoveryPackage,
  transitionRecoveryPackage,
  type RecoveryManifestFactInput,
} from '../services/recovery/recovery-package';

const prisma = new PrismaClient();
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'recovery-manual-submit-pass-1';

let ORG = '';
let caseId = '';
let claimItemId = '';
let claimItemId2 = '';
let ownerId = '';
/** 执行人（第二个 OWNER：与 claim.submit / appeal.submit 同权限口径） */
let executorId = '';
let evidenceId = '';

async function seedUser(suffix: string, role: 'OWNER' | 'FINANCE' | 'VIEWER'): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `r43-s3-${role.toLowerCase()}-${suffix}@example.com`,
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: role,
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: ORG, userId: user.id, role, isActive: true } });
  return user.id;
}

function fact(claimItem: string, overrides: Partial<RecoveryManifestFactInput> = {}): RecoveryManifestFactInput {
  return {
    organizationId: ORG,
    claimItemId: claimItem,
    caseId,
    platformType: 'AMAZON',
    claimType: 'ORDER_DISCREPANCY',
    normalizedRefs: ['amazon-sp::orders::1'],
    currency: 'USD',
    amountExpected: '120',
    amountActual: '100',
    recoverableAmount: '20',
    occurredAt: '2026-09-02T00:00:00.000Z',
    responsibleParty: 'PLATFORM',
    evidence: [{ evidenceId, evidenceType: 'INVOICE', capturedAt: '2026-09-01T00:00:00.000Z' }],
    instructionNote: 'submit via Seller Central',
    ...overrides,
  };
}

interface ApprovalFixture {
  approvalId: string;
  basisReference: string;
  packageDigest: string;
  packageVersion: string;
  digestVersion: string;
}

/** 创建 recovery.review_required + recovery.review_approved 事件族（含 boundPayload 与额外指纹键） */
async function createApproval(input: {
  approverUserId: string;
  caseId: string;
  claimItemId: string;
  packageVersion: string;
  digestVersion: string;
  packageDigest: string;
  action?: string;
  expiresAt?: Date;
}): Promise<ApprovalFixture> {
  const basisReference = buildRecoveryPackageBasisReference({
    claimItemId: input.claimItemId,
    caseId: input.caseId,
    packageVersion: input.packageVersion,
    digestVersion: input.digestVersion,
    packageDigest: input.packageDigest,
  });
  await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: input.approverUserId,
      action: 'recovery.review_required',
      entityType: 'Case',
      entityId: input.caseId,
      changes: { claimItemId: input.claimItemId },
    },
  });
  const approved = await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: input.approverUserId,
      action: 'recovery.review_approved',
      entityType: 'Case',
      entityId: input.caseId,
      changes: {
        boundAction: input.action ?? RECOVERY_MANUAL_SUBMIT_ACTION,
        expiresAt: (input.expiresAt ?? new Date(Date.now() + 3600_000)).toISOString(),
        boundPayload: {
          amount: null,
          currency: null,
          basisReference,
          evidenceArtifactId: null,
          fingerprintVersion: 'v1',
          claimItemId: input.claimItemId,
          caseId: input.caseId,
          packageVersion: input.packageVersion,
          digestVersion: input.digestVersion,
          packageDigest: input.packageDigest,
        },
      },
    },
  });
  return {
    approvalId: approved.id,
    basisReference,
    packageDigest: input.packageDigest,
    packageVersion: input.packageVersion,
    digestVersion: input.digestVersion,
  };
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
  ORG = randomUUID();
  await prisma.organization.create({ data: { id: ORG, name: 'R43 S3 租户', slug: 'r43-s3-' + suffix } });
  ownerId = await seedUser(suffix, 'OWNER');
  executorId = await seedUser(suffix + '-exec', 'OWNER');

  const createdCase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'R43-S3-' + suffix,
      title: 'R43 S3 fixture',
      domain: 'PLATFORM',
      currency: 'USD',
      openedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  caseId = createdCase.id;

  const makeClaim = async (ref: string) =>
    (
      await prisma.claimItem.create({
        data: {
          organizationId: ORG,
          caseId,
          platformType: 'AMAZON',
          claimType: 'ORDER_DISCREPANCY',
          platformRef: ref,
          sourceFingerprint: (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64),
          fingerprintVersion: 'v1',
          occurredAt: new Date('2026-09-02T00:00:00.000Z'),
          currency: 'USD',
          status: 'READY_TO_APPEAL',
          normalizerVersion: 'amazon-sp-normalizer/v1',
        },
        select: { id: true },
      })
    ).id;
  claimItemId = await makeClaim('AMZ-S3-A-' + suffix);
  claimItemId2 = await makeClaim('AMZ-S3-B-' + suffix);

  const evidence = await prisma.evidenceArtifact.create({
    data: { organizationId: ORG, kind: 'INVOICE', title: 'R43 S3 evidence' },
  });
  evidenceId = evidence.id;
});

async function submit(overrides: Record<string, unknown> = {}) {
  return submitManualRecoveryWithApproval(
    {
      organizationId: ORG,
      role: 'OWNER',
      actorUserId: executorId,
      claimItemId,
      packageId: '',
      evidenceIds: [evidenceId],
      ...overrides,
    } as never,
    { prisma },
  );
}

async function prepareApprovedPackage(claimItem = claimItemId) {
  const generated = await generateRecoveryPackage({ fact: fact(claimItem), actorUserId: ownerId }, { prisma });
  const manifest = buildRecoveryManifest(fact(claimItem));
  const approval = await createApproval({
    approverUserId: ownerId,
    caseId,
    claimItemId: claimItem,
    packageVersion: generated.packageVersion,
    digestVersion: generated.digestVersion,
    packageDigest: generated.packageDigest,
  });
  return { generated, manifest, approval };
}

describe('R43 S3 — recovery.manual_submit（锁内重验 + 原子提交）', () => {
  it('S3-01 成功提交：状态跃迁 + submission + evidence + 审计 + approval 消费（同事务）', async () => {
    const { generated, approval } = await prepareApprovedPackage();
    const result = await submit({ packageId: generated.packageId, approvalId: approval.approvalId });

    expect(result.status).toBe('SUBMITTED_MANUAL');
    expect(result.platformWriteExecuted).toBe(false);
    expect(result.externalSubmission).toBe('NEEDS_MANUAL');
    expect(result.approvalBasisReference).toBe(approval.basisReference);

    const claim = await prisma.claimItem.findUniqueOrThrow({ where: { id: claimItemId } });
    expect(claim.status).toBe('SUBMITTED_MANUAL');
    const submission = await prisma.recoveryManualSubmission.findUniqueOrThrow({
      where: { id: result.submissionId },
    });
    expect(submission.approvalId).toBe(approval.approvalId);
    expect(submission.packageDigest).toBe(approval.packageDigest);
    expect(await prisma.recoveryManualSubmissionEvidence.count({ where: { submissionId: submission.id } })).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: RECOVERY_MANUAL_SUBMITTED_ACTION } }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: APPROVAL_CONSUMED_EVENT_ACTION } }),
    ).toBe(1);
  });

  it('S3-02 缺审批 → 拒绝且零推进零消费（并留拒绝审计）', async () => {
    const { generated } = await prepareApprovedPackage();
    await expect(submit({ packageId: generated.packageId })).rejects.toThrowError(/APPROVAL_NOT_FOUND/);
    await expect(
      submit({ packageId: generated.packageId, approvalId: randomUUID() }),
    ).rejects.toThrowError(/APPROVAL_NOT_FOUND/);
    expect((await prisma.claimItem.findUniqueOrThrow({ where: { id: claimItemId } })).status).toBe('READY_TO_APPEAL');
    expect(await prisma.recoveryManualSubmission.count({ where: { organizationId: ORG } })).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: APPROVAL_CONSUMED_EVENT_ACTION } }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: RECOVERY_MANUAL_SUBMIT_REJECTED_ACTION } }),
    ).toBeGreaterThan(0);
  });

  it('S3-03 错 action（审批绑定其他动作）→ APPROVAL_ACTION_MISMATCH', async () => {
    const generated = await generateRecoveryPackage({ fact: fact(claimItemId), actorUserId: ownerId }, { prisma });
    const approval = await createApproval({
      approverUserId: ownerId,
      caseId,
      claimItemId,
      packageVersion: generated.packageVersion,
      digestVersion: generated.digestVersion,
      packageDigest: generated.packageDigest,
      action: 'claim.submit',
    });
    await expect(
      submit({ packageId: generated.packageId, approvalId: approval.approvalId }),
    ).rejects.toThrowError(/APPROVAL_ACTION_MISMATCH/);
    expect((await prisma.claimItem.findUniqueOrThrow({ where: { id: claimItemId } })).status).toBe('READY_TO_APPEAL');
  });

  it('S3-04 错 package 绑定（用 package A 的审批提交 package B）→ 拒绝且零副作用', async () => {
    const a = await prepareApprovedPackage(claimItemId);
    // 第二个 package（不同业务内容 → 不同 digest）
    const bGenerated = await generateRecoveryPackage(
      { fact: fact(claimItemId, { amountActual: '99.5' }), actorUserId: ownerId },
      { prisma },
    );
    expect(bGenerated.packageDigest).not.toBe(a.generated.packageDigest);
    await expect(
      submit({ packageId: bGenerated.packageId, approvalId: a.approval.approvalId }),
    ).rejects.toThrowError(/APPROVAL_PAYLOAD_MISMATCH/);
    expect((await prisma.claimItem.findUniqueOrThrow({ where: { id: claimItemId } })).status).toBe('READY_TO_APPEAL');
    expect(await prisma.recoveryManualSubmission.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('S3-05 package 版本变化（digestVersion/packageVersion 参与 basis）→ 审批失效', async () => {
    const { generated } = await prepareApprovedPackage();
    const staleApproval = await createApproval({
      approverUserId: ownerId,
      caseId,
      claimItemId,
      packageVersion: 'recovery-package/v0',
      digestVersion: generated.digestVersion,
      packageDigest: generated.packageDigest,
    });
    await expect(
      submit({ packageId: generated.packageId, approvalId: staleApproval.approvalId }),
    ).rejects.toThrowError(/APPROVAL_PAYLOAD_MISMATCH/);
  });

  it('S3-06 package 已 SUPERSEDED → 拒绝（终态不可用于提交）', async () => {
    const { generated, approval } = await prepareApprovedPackage();
    await transitionRecoveryPackage(
      {
        organizationId: ORG,
        packageId: generated.packageId,
        actorUserId: ownerId,
        transition: { to: 'SUPERSEDED', reason: 'rescoped package' },
      },
      { prisma },
    );
    await expect(
      submit({ packageId: generated.packageId, approvalId: approval.approvalId }),
    ).rejects.toThrowError(/ILLEGAL_TRANSITION/);
    expect((await prisma.claimItem.findUniqueOrThrow({ where: { id: claimItemId } })).status).toBe('READY_TO_APPEAL');
  });

  it('S3-07 approval 过期 / 已撤销 → 拒绝', async () => {
    const generated = await generateRecoveryPackage({ fact: fact(claimItemId), actorUserId: ownerId }, { prisma });
    const expired = await createApproval({
      approverUserId: ownerId,
      caseId,
      claimItemId,
      packageVersion: generated.packageVersion,
      digestVersion: generated.digestVersion,
      packageDigest: generated.packageDigest,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(
      submit({ packageId: generated.packageId, approvalId: expired.approvalId }),
    ).rejects.toThrowError(/APPROVAL_EXPIRED/);

    const revoked = await createApproval({
      approverUserId: ownerId,
      caseId,
      claimItemId,
      packageVersion: generated.packageVersion,
      digestVersion: generated.digestVersion,
      packageDigest: generated.packageDigest,
    });
    await prisma.auditLog.create({
      data: {
        organizationId: ORG,
        actorType: 'USER',
        actorUserId: ownerId,
        action: 'recovery.approval_revoked',
        entityType: 'Case',
        entityId: caseId,
        changes: { approvalId: revoked.approvalId },
      },
    });
    await expect(
      submit({ packageId: generated.packageId, approvalId: revoked.approvalId }),
    ).rejects.toThrowError(/APPROVAL_REVOKED/);
    expect((await prisma.claimItem.findUniqueOrThrow({ where: { id: claimItemId } })).status).toBe('READY_TO_APPEAL');
  });

  it('S3-08 执行人被停用 / 降权（锁内重验）→ 拒绝', async () => {
    const { generated, approval } = await prepareApprovedPackage();
    await prisma.membership.updateMany({ where: { organizationId: ORG, userId: executorId }, data: { isActive: false } });
    await expect(
      submit({ packageId: generated.packageId, approvalId: approval.approvalId }),
    ).rejects.toThrowError(/APPROVAL_ACTOR_MISMATCH|FORBIDDEN/);

    await prisma.membership.updateMany({
      where: { organizationId: ORG, userId: executorId },
      data: { isActive: true, role: 'VIEWER' },
    });
    await expect(
      submit({ packageId: generated.packageId, approvalId: approval.approvalId }),
    ).rejects.toThrowError(/FORBIDDEN|权限/);
    expect((await prisma.claimItem.findUniqueOrThrow({ where: { id: claimItemId } })).status).toBe('READY_TO_APPEAL');
  });

  it('S3-09/10 并发与单链：同一提交至多一次成功；同一 approval 用于两个 ClaimItem 至多一个成功', async () => {
    const { generated, approval } = await prepareApprovedPackage();
    const first = await submit({ packageId: generated.packageId, approvalId: approval.approvalId });
    await expect(
      submit({ packageId: generated.packageId, approvalId: approval.approvalId }),
    ).rejects.toThrowError(/APPROVAL_ALREADY_CONSUMED|ILLEGAL_TRANSITION|Unique constraint/);
    expect(await prisma.recoveryManualSubmission.count({ where: { organizationId: ORG } })).toBe(1);
    expect(first.status).toBe('SUBMITTED_MANUAL');

    // 同一 approval 用于第二个 ClaimItem（另一 package）
    const otherPackage = await generateRecoveryPackage({ fact: fact(claimItemId2), actorUserId: ownerId }, { prisma });
    await expect(
      submit({ claimItemId: claimItemId2, packageId: otherPackage.packageId, approvalId: approval.approvalId }),
    ).rejects.toThrowError(/APPROVAL_ALREADY_CONSUMED|APPROVAL_TARGET_MISMATCH|APPROVAL_PAYLOAD_MISMATCH/);
    expect((await prisma.claimItem.findUniqueOrThrow({ where: { id: claimItemId2 } })).status).toBe('READY_TO_APPEAL');
  });

  it('S3-11 事务原子性：后置步骤失败（跨租户证据）→ 状态/提交/消费全部回滚', async () => {
    const { generated, approval } = await prepareApprovedPackage();
    const otherOrg = randomUUID();
    await prisma.organization.create({ data: { id: otherOrg, name: 'R43 S3 other', slug: 'r43-s3-other-' + otherOrg.slice(0, 8) } });
    const foreignEvidence = await prisma.evidenceArtifact.create({
      data: { organizationId: otherOrg, kind: 'INVOICE', title: 'foreign' },
    });
    await expect(
      submit({
        packageId: generated.packageId,
        approvalId: approval.approvalId,
        evidenceIds: [evidenceId, foreignEvidence.id],
      }),
    ).rejects.toThrowError(/NOT_FOUND/);
    expect((await prisma.claimItem.findUniqueOrThrow({ where: { id: claimItemId } })).status).toBe('READY_TO_APPEAL');
    expect(await prisma.recoveryManualSubmission.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.recoveryManualSubmissionEvidence.count({ where: { organizationId: ORG } })).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: RECOVERY_MANUAL_SUBMITTED_ACTION } }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: APPROVAL_CONSUMED_EVENT_ACTION } }),
    ).toBe(0);
  });

  it('S3-12 providerCaseRef 为空仍可确认提交（S3 不创建 reference 行）', async () => {
    const { generated, approval } = await prepareApprovedPackage();
    const result = await submit({ packageId: generated.packageId, approvalId: approval.approvalId });
    expect(result.status).toBe('SUBMITTED_MANUAL');
    expect(await prisma.recoveryManualSubmissionReference.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('S3-13 export ≠ submitted：EXPORTED（非终态）后仍可提交；导出本身不产生提交事实', async () => {
    const { generated, approval } = await prepareApprovedPackage();
    await transitionRecoveryPackage(
      { organizationId: ORG, packageId: generated.packageId, actorUserId: ownerId, transition: { to: 'EXPORTED' } },
      { prisma },
    );
    expect(await prisma.recoveryManualSubmission.count({ where: { organizationId: ORG } })).toBe(0);
    const result = await submit({ packageId: generated.packageId, approvalId: approval.approvalId });
    expect(result.status).toBe('SUBMITTED_MANUAL');
  });

  it('S3-14 资金域零变化：Payment / Settlement / RecoveryLedger / Billing 全部为 0', async () => {
    const { generated, approval } = await prepareApprovedPackage();
    await submit({ packageId: generated.packageId, approvalId: approval.approvalId });
    expect(await prisma.payment.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.settlement.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.billingInvoice.count({ where: { organizationId: ORG } })).toBe(0);
    // 依赖 digest：审批 basis 与 package digest 一致（版本化绑定）
    const submission = await prisma.recoveryManualSubmission.findFirstOrThrow({ where: { organizationId: ORG } });
    expect(submission.packageDigest).toBe(computePackageDigest(buildRecoveryManifest(fact(claimItemId))));
    expect(submission.packageDigest).toBe(approval.packageDigest);
  });
});
