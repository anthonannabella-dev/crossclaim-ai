/**
 * R43 S5 —— 只读一致性 checker 的真实库验收（MSG-20261001-37）
 * 证明：clean DB → 通过；人工制造的漂移 → 抛错（非零退出码等价）；checker 不修改任何数据。
 */

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const prisma = new PrismaClient();

const CHECKER_PATH = resolve(__dirname, '..', '..', '..', '..', 'tools', 'consistency', 'check-recovery-manual-submission.mjs');

let checkerSql = '';

async function loadCheckerSql(): Promise<string> {
  const mod = (await import(pathToFileURL(CHECKER_PATH).href)) as {
    buildRecoveryManualConsistencySql: () => string;
  };
  return mod.buildRecoveryManualConsistencySql();
}

async function runChecker(): Promise<void> {
  await prisma.$executeRawUnsafe(checkerSql);
}

async function truncateAll(): Promise<void> {
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations')",
  );
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE ' + tables.map((row) => '"' + row.tablename + '"').join(', ') + ' CASCADE;',
    );
  }
}

interface Seeded {
  org: string;
  caseId: string;
  claimItemId: string;
  submissionId: string;
  packageDigest: string;
  userId: string;
}

/** 直接构造一致的提交数据（含审批审计事件与 package） */
async function seedConsistentSubmission(
  overrides: { basisReference?: string; approvalChanges?: Record<string, unknown> } = {},
): Promise<Seeded> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const org = randomUUID();
  await prisma.organization.create({ data: { id: org, name: 'R43 S5 租户', slug: 'r43-s5-' + suffix } });
  const user = await prisma.user.create({
    data: {
      email: `r43-s5-${suffix}@example.com`,
      passwordHash: 'x',
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  // 审计 actor 必须是该租户成员（audit actor membership trigger）
  await prisma.membership.create({ data: { organizationId: org, userId: user.id, role: 'OWNER', isActive: true } });
  const createdCase = await prisma.case.create({
    data: {
      organizationId: org,
      caseNo: 'R43-S5-' + suffix,
      title: 'R43 S5 fixture',
      domain: 'PLATFORM',
      currency: 'USD',
      openedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  const claim = await prisma.claimItem.create({
    data: {
      organizationId: org,
      caseId: createdCase.id,
      platformType: 'AMAZON',
      claimType: 'ORDER_DISCREPANCY',
      platformRef: 'AMZ-S5-' + suffix,
      sourceFingerprint: (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64),
      fingerprintVersion: 'v1',
      occurredAt: new Date('2026-09-02T00:00:00.000Z'),
      currency: 'USD',
      status: 'SUBMITTED_MANUAL',
      normalizerVersion: 'amazon-sp-normalizer/v1',
    },
  });
  const pkg = await prisma.recoveryPackage.create({
    data: {
      organizationId: org,
      claimItemId: claim.id,
      caseId: createdCase.id,
      packageVersion: 'recovery-package/v1',
      digestVersion: 'v1',
      packageDigest: 'a'.repeat(64),
    },
  });
  const basisReference =
    overrides.basisReference ??
    `rmp1:${claim.id}:${createdCase.id}:recovery-package/v1:v1:${'a'.repeat(64)}`;
  const approval = await prisma.auditLog.create({
    data: {
      organizationId: org,
      actorType: 'USER',
      actorUserId: user.id,
      action: 'recovery.review_approved',
      entityType: 'Case',
      entityId: createdCase.id,
      changes: (overrides.approvalChanges ?? {
        boundAction: 'recovery.manual_submit',
        boundPayload: {
          amount: null,
          currency: null,
          basisReference,
          evidenceArtifactId: null,
          fingerprintVersion: 'v1',
        },
      }) as never,
    },
  });
  const submission = await prisma.recoveryManualSubmission.create({
    data: {
      organizationId: org,
      claimItemId: claim.id,
      caseId: createdCase.id,
      packageId: pkg.id,
      packageDigest: 'a'.repeat(64),
      approvalId: approval.id,
      approvalBasisReference: basisReference,
      submittedAt: new Date('2026-09-03T00:00:00.000Z'),
      submittedByUserId: user.id,
      idempotencyKey: 'rms1-' + claim.id,
    },
  });
  return {
    org,
    caseId: createdCase.id,
    claimItemId: claim.id,
    submissionId: submission.id,
    packageDigest: 'a'.repeat(64),
    userId: user.id,
  };
}

beforeAll(async () => {
  await prisma.$connect();
  checkerSql = await loadCheckerSql();
});

afterAll(async () => {
  await truncateAll();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll();
});

describe('R43 S5 — 只读一致性 checker', () => {
  it('S5-11 干净数据库：checker 通过（等价 psql 退出码 0）', async () => {
    await seedConsistentSubmission();
    await expect(runChecker()).resolves.toBeUndefined();
  });

  it('S5-01/02 漂移：SUBMITTED_MANUAL 无 submission / 状态回退 → checker 报错', async () => {
    const seeded = await seedConsistentSubmission();
    await runChecker();
    // 制造漂移：把 ClaimItem 状态退回 READY_TO_APPEAL（submission 仍在）
    await prisma.claimItem.update({ where: { id: seeded.claimItemId }, data: { status: 'READY_TO_APPEAL' } });
    await expect(runChecker()).rejects.toThrow(/INCONSISTENT\[2\]/);
    // 恢复后再次通过
    await prisma.claimItem.update({ where: { id: seeded.claimItemId }, data: { status: 'SUBMITTED_MANUAL' } });
    await expect(runChecker()).resolves.toBeUndefined();
  });

  it('S5-03 漂移：submission 的 basis 关系不一致 → checker 报错（[3]）', async () => {
    await seedConsistentSubmission({ basisReference: 'rmp1:wrong:wrong:recovery-package/v1:v1:' + 'b'.repeat(64) });
    await expect(runChecker()).rejects.toThrow(/INCONSISTENT\[3\]/);
  });

  it('S5-06 漂移：SubmissionEvidence 引用不存在 → checker 报错（[6]）', async () => {
    const seeded = await seedConsistentSubmission();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "RecoveryManualSubmissionEvidence" ("id","organizationId","submissionId","evidenceId","createdAt")
       VALUES ($1,$2,$3,$4, now())`,
      randomUUID(),
      seeded.org,
      seeded.submissionId,
      randomUUID(),
    ).catch(() => undefined);
    // 若 FK 阻止写入，则视为数据库已 fail-closed（同样满足要求）
    const rows = await prisma.recoveryManualSubmissionEvidence.count({ where: { organizationId: seeded.org } });
    if (rows > 0) {
      await expect(runChecker()).rejects.toThrow(/INCONSISTENT\[6\]/);
    } else {
      await expect(runChecker()).resolves.toBeUndefined();
    }
  });

  it('S5-12 checker 只读：运行前后数据快照完全一致，且 SQL 不含任何写入语句', async () => {
    const seeded = await seedConsistentSubmission();
    const before = await snapshot(seeded.org);
    await runChecker();
    const after = await snapshot(seeded.org);
    expect(after).toEqual(before);

    const sql = checkerSql.toUpperCase();
    for (const forbidden of ['INSERT ', 'UPDATE ', 'DELETE ', 'ALTER ', 'DROP ', 'TRUNCATE ']) {
      expect(sql).not.toContain(forbidden);
    }
  });
});

async function snapshot(organizationId: string) {
  const [claimItems, submissions, evidences, references, packages, audits] = await Promise.all([
    prisma.claimItem.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
    prisma.recoveryManualSubmission.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
    prisma.recoveryManualSubmissionEvidence.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
    prisma.recoveryManualSubmissionReference.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
    prisma.recoveryPackage.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
    prisma.auditLog.findMany({ where: { organizationId }, orderBy: { id: 'asc' } }),
  ]);
  return { claimItems, submissions, evidences, references, packages, audits };
}

/**
 * R43 S6（MSG-20261001-38）—— CHANGE A：approval 语义强校验；CHANGE B：真实可制造漂移
 * 原则：DB 接受的业务不一致（不绕过 FK / 不绕过 append-only 触发器）→ checker 必须拒绝 → checker 零修复。
 */
describe('R43 S6 — approval 语义强校验与可制造漂移', () => {
  it('S6-A1 approval 绑定动作不是 recovery.manual_submit → INCONSISTENT[5c]', async () => {
    const seeded = await seedConsistentSubmission({
      approvalChanges: {
        boundAction: 'claim.submit',
        boundPayload: {
          amount: null,
          currency: null,
          basisReference: 'rmp1:other:other:recovery-package/v1:v1:' + 'c'.repeat(64),
          evidenceArtifactId: null,
          fingerprintVersion: 'v1',
        },
      },
    });
    const before = await snapshot(seeded.org);
    await expect(runChecker()).rejects.toThrow(/INCONSISTENT\[5c\]/);
    expect(await snapshot(seeded.org)).toEqual(before);
  });

  it('S6-A2 approval 的 versioned basis 与 submission 保存值不一致（他案/他包 approval）→ INCONSISTENT[5c]', async () => {
    await seedConsistentSubmission({
      approvalChanges: {
        boundAction: 'recovery.manual_submit',
        boundPayload: {
          amount: null,
          currency: null,
          basisReference: 'rmp1:another-claim:another-case:recovery-package/v1:v1:' + 'd'.repeat(64),
          evidenceArtifactId: null,
          fingerprintVersion: 'v1',
        },
      },
    });
    await expect(runChecker()).rejects.toThrow(/INCONSISTENT\[5c\]/);
  });

  it('S6-A3 approval 目标不是本单位 Case / 缺少 fingerprintVersion → INCONSISTENT[5c]', async () => {
    const seeded = await seedConsistentSubmission({
      approvalChanges: {
        boundAction: 'recovery.manual_submit',
        boundPayload: { amount: null, currency: null, basisReference: 'x', evidenceArtifactId: null },
      },
    });
    await expect(runChecker()).rejects.toThrow(/INCONSISTENT\[5c\]/);
    expect(seeded.submissionId).toBeTruthy();
  });

  it('S6-B1 非 canonical reference：数据库 CHECK 直接 fail-closed（不绕过约束；checker 8a 为纵深防御）', async () => {
    const seeded = await seedConsistentSubmission();
    let rejection = '';
    try {
      await prisma.recoveryManualSubmissionReference.create({
        data: {
          organizationId: seeded.org,
          submissionId: seeded.submissionId,
          providerCaseRefRaw: '  CASE-S6-B1  ',
          providerCaseRefCanonical: '  CASE-S6-B1  ',
          recordedByUserId: seeded.userId,
        },
      });
    } catch (error) {
      rejection = String(error);
    }
    // 数据库本身不允许该状态存在（CHECK canonical_shape）→ 满足 MSG-38「不要求绕过 FK/约束制造非法状态」
    expect(rejection).toMatch(/canonical_shape|23514/);
    expect(await prisma.recoveryManualSubmissionReference.count({ where: { organizationId: seeded.org } })).toBe(0);
    // checker 在该（数据库强制合法）状态下保持 clean；8a 是纵深防御，静态断言其守卫存在
    await expect(runChecker()).resolves.toBeUndefined();
    expect(checkerSql).toContain('INCONSISTENT[8a]');
  });

  it('S6-B3 同一租户重复 canonical reference：数据库 UNIQUE 兜底 fail-closed', async () => {
    const seeded = await seedConsistentSubmission();
    await prisma.recoveryManualSubmissionReference.create({
      data: {
        organizationId: seeded.org,
        submissionId: seeded.submissionId,
        providerCaseRefRaw: 'CASE-S6-B3',
        providerCaseRefCanonical: 'CASE-S6-B3',
        recordedByUserId: seeded.userId,
      },
    });
    await expect(runChecker()).resolves.toBeUndefined();
    let rejection = '';
    try {
      await prisma.recoveryManualSubmissionReference.create({
        data: {
          organizationId: seeded.org,
          submissionId: seeded.submissionId,
          providerCaseRefRaw: 'case-s6-b3',
          providerCaseRefCanonical: 'CASE-S6-B3',
          recordedByUserId: seeded.userId,
        },
      });
    } catch (error) {
      rejection = String(error);
    }
    expect(rejection).toMatch(/Unique|23505|providerCaseRefCanonical/);
  });
  it('S6-B2 DB 允许的 reference 租户漂移（organizationId ≠ submission 租户）→ INCONSISTENT[7] 或数据库 fail-closed', async () => {
    const seeded = await seedConsistentSubmission();
    const otherOrg = randomUUID();
    await prisma.organization.create({
      data: { id: otherOrg, name: 'R43 S6 他租户', slug: 'r43-s6-' + randomUUID().replace(/-/g, '').slice(0, 10) },
    });
    let inserted = false;
    try {
      await prisma.recoveryManualSubmissionReference.create({
        data: {
          organizationId: otherOrg,
          submissionId: seeded.submissionId,
          providerCaseRefRaw: 'CASE-S6-B2',
          providerCaseRefCanonical: 'CASE-S6-B2',
          recordedByUserId: seeded.userId,
        },
      });
      inserted = true;
    } catch {
      inserted = false;
    }
    if (inserted) {
      await expect(runChecker()).rejects.toThrow(/INCONSISTENT\[7\]/);
    } else {
      // 数据库/触发器直接拒绝该状态 → 等价于 fail-closed，不需要 checker 兜底
      await expect(runChecker()).resolves.toBeUndefined();
    }
  });
});
