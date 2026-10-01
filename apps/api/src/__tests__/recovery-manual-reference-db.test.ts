/**
 * R43 S4 —— providerCaseRef canonical 补录（MSG-20261001-36 的 12 项要求）
 * 复用 S3 生成真实 SUBMITTED_MANUAL submission，再对补录动作做全量验收。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import { APPROVAL_CONSUMED_EVENT_ACTION } from '../services/action-guard/approval-tx-verify';
import { RECOVERY_MANUAL_SUBMIT_ACTION } from '../services/action-guard/approval-verifier';
import {
  RECOVERY_MANUAL_REFERENCE_ACTION,
} from '../services/action-guard/approval-verifier';
import {
  buildRecoveryReferenceBasisReference,
  canonicalizeProviderCaseRef,
  recordManualRecoveryReference,
  RECOVERY_MANUAL_REFERENCE_RECORDED_ACTION,
  RECOVERY_MANUAL_REFERENCE_REJECTED_ACTION,
} from '../services/recovery/manual-reference';
import { submitManualRecoveryWithApproval } from '../services/recovery/manual-submission';
import {
  buildRecoveryPackageBasisReference,
  generateRecoveryPackage,
  type RecoveryManifestFactInput,
} from '../services/recovery/recovery-package';

const prisma = new PrismaClient();
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'recovery-manual-ref-pass-1';

let ORG = '';
let caseId = '';
let claimItemId = '';
let approverId = '';
let executorId = '';
let evidenceId = '';
let submissionId = '';
let s3ApprovalId = '';

function fact(): RecoveryManifestFactInput {
  return {
    organizationId: ORG,
    claimItemId,
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
  };
}

async function createApproval(input: {
  action: string;
  basisReference: string;
  extra: Record<string, string>;
  expiresAt?: Date;
}): Promise<string> {
  await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: approverId,
      action: 'recovery.review_required',
      entityType: 'Case',
      entityId: caseId,
      changes: { claimItemId },
    },
  });
  const approved = await prisma.auditLog.create({
    data: {
      organizationId: ORG,
      actorType: 'USER',
      actorUserId: approverId,
      action: 'recovery.review_approved',
      entityType: 'Case',
      entityId: caseId,
      changes: {
        boundAction: input.action,
        expiresAt: (input.expiresAt ?? new Date(Date.now() + 3600_000)).toISOString(),
        boundPayload: {
          amount: null,
          currency: null,
          basisReference: input.basisReference,
          evidenceArtifactId: null,
          fingerprintVersion: 'v1',
          ...input.extra,
        },
      },
    },
  });
  return approved.id;
}

function referenceApproval(canonical: string) {
  const basisReference = buildRecoveryReferenceBasisReference({
    submissionId,
    claimItemId,
    providerCaseRefCanonical: canonical,
  });
  return { basisReference, extra: { submissionId, claimItemId, providerCaseRefCanonical: canonical } };
}

async function record(raw: string, overrides: Record<string, unknown> = {}) {
  const canonical = canonicalizeProviderCaseRef(raw);
  const { basisReference, extra } = referenceApproval(canonical);
  const approvalId = await createApproval({
    action: RECOVERY_MANUAL_REFERENCE_ACTION,
    basisReference,
    extra,
  });
  return recordManualRecoveryReference(
    {
      organizationId: ORG,
      role: 'OWNER',
      actorUserId: executorId,
      submissionId,
      providerCaseRefRaw: raw,
      approvalId,
      ...overrides,
    },
    { prisma },
  );
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
  await prisma.organization.create({ data: { id: ORG, name: 'R43 S4 租户', slug: 'r43-s4-' + suffix } });
  const mkUser = async (tag: string) => {
    const user = await prisma.user.create({
      data: {
        email: `r43-s4-${tag}-${suffix}@example.com`,
        passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
        displayName: tag,
        status: 'ACTIVE',
        emailVerified: true,
      },
    });
    await prisma.membership.create({ data: { organizationId: ORG, userId: user.id, role: 'OWNER', isActive: true } });
    return user.id;
  };
  approverId = await mkUser('approver');
  executorId = await mkUser('executor');

  const createdCase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'R43-S4-' + suffix,
      title: 'R43 S4 fixture',
      domain: 'PLATFORM',
      currency: 'USD',
      openedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  caseId = createdCase.id;
  const claim = await prisma.claimItem.create({
    data: {
      organizationId: ORG,
      caseId,
      platformType: 'AMAZON',
      claimType: 'ORDER_DISCREPANCY',
      platformRef: 'AMZ-S4-' + suffix,
      sourceFingerprint: (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64),
      fingerprintVersion: 'v1',
      occurredAt: new Date('2026-09-02T00:00:00.000Z'),
      currency: 'USD',
      status: 'READY_TO_APPEAL',
      normalizerVersion: 'amazon-sp-normalizer/v1',
    },
  });
  claimItemId = claim.id;
  evidenceId = (
    await prisma.evidenceArtifact.create({
      data: { organizationId: ORG, kind: 'INVOICE', title: 'R43 S4 evidence' },
    })
  ).id;

  // 真实 S3 提交（消费 S3 approval）：作为 S4 的既有 submission
  const generated = await generateRecoveryPackage({ fact: fact(), actorUserId: approverId }, { prisma });
  const s3Basis = buildRecoveryPackageBasisReference({
    claimItemId,
    caseId,
    packageVersion: generated.packageVersion,
    digestVersion: generated.digestVersion,
    packageDigest: generated.packageDigest,
  });
  s3ApprovalId = await createApproval({
    action: RECOVERY_MANUAL_SUBMIT_ACTION,
    basisReference: s3Basis,
    extra: {
      claimItemId,
      caseId,
      packageVersion: generated.packageVersion,
      digestVersion: generated.digestVersion,
      packageDigest: generated.packageDigest,
    },
  });
  const submitted = await submitManualRecoveryWithApproval(
    {
      organizationId: ORG,
      role: 'OWNER',
      actorUserId: executorId,
      claimItemId,
      packageId: generated.packageId,
      approvalId: s3ApprovalId,
      evidenceIds: [evidenceId],
    },
    { prisma },
  );
  submissionId = submitted.submissionId;
});

describe('R43 S4 — providerCaseRef canonical 补录', () => {
  it('S4-01 成功补录：raw+canonical 分开保存、审计写入；Submission / ClaimItem 均不被修改', async () => {
    const submissionBefore = await prisma.recoveryManualSubmission.findUniqueOrThrow({ where: { id: submissionId } });
    const result = await record('  ABC-123  ');

    const row = await prisma.recoveryManualSubmissionReference.findUniqueOrThrow({ where: { id: result.referenceId } });
    expect(row.providerCaseRefRaw).toBe('  ABC-123  ');
    expect(row.providerCaseRefCanonical).toBe('ABC-123');
    expect(row.recordedByUserId).toBe(executorId);
    expect(result.providerAccepted).toBe(false);
    expect(result.platformWriteExecuted).toBe(false);

    expect(
      await prisma.auditLog.count({
        where: { organizationId: ORG, action: RECOVERY_MANUAL_REFERENCE_RECORDED_ACTION },
      }),
    ).toBe(1);
    // Submission 未被 UPDATE（逐字段一致）
    const submissionAfter = await prisma.recoveryManualSubmission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(submissionAfter).toEqual(submissionBefore);
    expect((await prisma.claimItem.findUniqueOrThrow({ where: { id: claimItemId } })).status).toBe('SUBMITTED_MANUAL');
  });

  it('S4-02 空 / 纯空白 / 纯零宽 reference 一律拒绝', async () => {
    expect(() => canonicalizeProviderCaseRef('')).toThrowError(/REFERENCE_EMPTY/);
    expect(() => canonicalizeProviderCaseRef('   ')).toThrowError(/REFERENCE_EMPTY/);
    expect(() => canonicalizeProviderCaseRef('\u200b\u200b')).toThrowError(/REFERENCE_EMPTY/);
    const { basisReference, extra } = referenceApproval('X-1');
    const approvalId = await createApproval({
      action: RECOVERY_MANUAL_REFERENCE_ACTION,
      basisReference,
      extra,
    });
    await expect(
      recordManualRecoveryReference(
        {
          organizationId: ORG,
          role: 'OWNER',
          actorUserId: executorId,
          submissionId,
          providerCaseRefRaw: '   ',
          approvalId,
        },
        { prisma },
      ),
    ).rejects.toThrowError(/REFERENCE_EMPTY/);
    expect(await prisma.recoveryManualSubmissionReference.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('S4-03/04 canonical duplicate 由 DB 唯一约束兜底；并发补录至多一次成功', async () => {
    await record('CASE-777');
    await expect(record('case-777')).resolves.toBeTruthy(); // 不做大小写折叠 → 不同 canonical，允许
    await expect(record(' CASE-777 ')).rejects.toThrowError(/PROVIDER_CASE_REF_CONFLICT/);
    expect(await prisma.recoveryManualSubmissionReference.count({ where: { organizationId: ORG } })).toBe(2);

    const raw = 'DUP-1';
    const canonical = canonicalizeProviderCaseRef(raw);
    const { basisReference, extra } = referenceApproval(canonical);
    const a = await createApproval({ action: RECOVERY_MANUAL_REFERENCE_ACTION, basisReference, extra });
    const b = await createApproval({ action: RECOVERY_MANUAL_REFERENCE_ACTION, basisReference, extra });
    const results = await Promise.allSettled([
      recordManualRecoveryReference(
        {
          organizationId: ORG,
          role: 'OWNER',
          actorUserId: executorId,
          submissionId,
          providerCaseRefRaw: raw,
          approvalId: a,
        },
        { prisma },
      ),
      recordManualRecoveryReference(
        {
          organizationId: ORG,
          role: 'OWNER',
          actorUserId: executorId,
          submissionId,
          providerCaseRefRaw: raw,
          approvalId: b,
        },
        { prisma },
      ),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBe(1);
    expect(
      await prisma.recoveryManualSubmissionReference.count({ where: { organizationId: ORG, providerCaseRefCanonical: canonical } }),
    ).toBe(1);
  });

  it('S4-05 跨租户 / 错 submission / 非 ACTIVE 成员 → fail-closed', async () => {
    const otherOrg = randomUUID();
    await prisma.organization.create({ data: { id: otherOrg, name: 'S4 other', slug: 's4-other-' + otherOrg.slice(0, 8) } });
    const { basisReference, extra } = referenceApproval('TEN-1');
    const approvalId = await createApproval({ action: RECOVERY_MANUAL_REFERENCE_ACTION, basisReference, extra });

    await expect(
      recordManualRecoveryReference(
        {
          organizationId: otherOrg,
          role: 'OWNER',
          actorUserId: executorId,
          submissionId,
          providerCaseRefRaw: 'TEN-1',
          approvalId,
        },
        { prisma },
      ),
    ).rejects.toThrowError(/NOT_FOUND/);

    await expect(
      recordManualRecoveryReference(
        {
          organizationId: ORG,
          role: 'OWNER',
          actorUserId: executorId,
          submissionId: randomUUID(),
          providerCaseRefRaw: 'TEN-1',
          approvalId,
        },
        { prisma },
      ),
    ).rejects.toThrowError(/NOT_FOUND/);

    await prisma.membership.updateMany({ where: { organizationId: ORG, userId: executorId }, data: { isActive: false } });
    await expect(
      recordManualRecoveryReference(
        {
          organizationId: ORG,
          role: 'OWNER',
          actorUserId: executorId,
          submissionId,
          providerCaseRefRaw: 'TEN-1',
          approvalId,
        },
        { prisma },
      ),
    ).rejects.toThrowError(/APPROVAL_ACTOR_MISMATCH|FORBIDDEN|权限/);
    expect(await prisma.recoveryManualSubmissionReference.count({ where: { organizationId: ORG } })).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: RECOVERY_MANUAL_REFERENCE_REJECTED_ACTION } }),
    ).toBeGreaterThan(0);
  });

  it('S4-06 canonical 化：NFKC / 去零宽 / 折叠空白 / 不 lower-case', async () => {
    expect(canonicalizeProviderCaseRef('\uFF21BC')).toBe('ABC'); // 全角 → NFKC
    expect(canonicalizeProviderCaseRef('A\u200bB')).toBe('AB'); // 零宽剔除
    expect(canonicalizeProviderCaseRef('A   B\tC')).toBe('A B C'); // 空白折叠
    expect(canonicalizeProviderCaseRef('abc-123')).toBe('abc-123'); // 不做 lower-case

    const lower = await record('mix-1');
    expect(lower.providerCaseRefCanonical).toBe('mix-1');
  });

  it('S4-07 独立动作 + 独立 binding：不得复用 S3 approval；错误 canonical binding 拒绝', async () => {
    // 用 S3 的 approval（action=recovery.manual_submit）→ 动作不匹配
    await expect(
      recordManualRecoveryReference(
        {
          organizationId: ORG,
          role: 'OWNER',
          actorUserId: executorId,
          submissionId,
          providerCaseRefRaw: 'R-1',
          approvalId: s3ApprovalId,
        },
        { prisma },
      ),
    ).rejects.toThrowError(/APPROVAL_ACTION_MISMATCH|APPROVAL_ALREADY_CONSUMED|APPROVAL_PAYLOAD_MISMATCH/);

    // 审批绑定另一个 canonical → 载荷不匹配
    const wrong = referenceApproval('OTHER-1');
    const wrongApproval = await createApproval({
      action: RECOVERY_MANUAL_REFERENCE_ACTION,
      basisReference: wrong.basisReference,
      extra: wrong.extra,
    });
    await expect(
      recordManualRecoveryReference(
        {
          organizationId: ORG,
          role: 'OWNER',
          actorUserId: executorId,
          submissionId,
          providerCaseRefRaw: 'R-1',
          approvalId: wrongApproval,
        },
        { prisma },
      ),
    ).rejects.toThrowError(/APPROVAL_PAYLOAD_MISMATCH/);
    expect(await prisma.recoveryManualSubmissionReference.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('S4-08 边界：不产生 accepted/reimbursed/recovered 事实，不消费 S3 旧审批，不触碰资金域', async () => {
    const consumedBefore = await prisma.auditLog.count({
      where: { organizationId: ORG, action: APPROVAL_CONSUMED_EVENT_ACTION },
    });
    await record('OUT-1');

    // ClaimItem 仍 SUBMITTED_MANUAL（未产生 RECOVERED / 未回退）
    expect((await prisma.claimItem.findUniqueOrThrow({ where: { id: claimItemId } })).status).toBe('SUBMITTED_MANUAL');
    // 补录写入自己的消费事件（approval 数 +1），但 S3 审批不会被再次消费
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: APPROVAL_CONSUMED_EVENT_ACTION } }),
    ).toBe(consumedBefore + 1);
    expect(
      await prisma.auditLog.count({
        where: { organizationId: ORG, action: APPROVAL_CONSUMED_EVENT_ACTION },
      }),
    ).toBe(2);
    // 无 provider 受理/赔付语义
    expect(await prisma.settlement.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.billingInvoice.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.payment.count({ where: { organizationId: ORG } })).toBe(0);
  });
});
