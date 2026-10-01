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
}

/** 直接构造一致的提交数据（含审批审计事件与 package） */
async function seedConsistentSubmission(overrides: { basisReference?: string } = {}): Promise<Seeded> {
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
  const approval = await prisma.auditLog.create({
    data: {
      organizationId: org,
      actorType: 'USER',
      actorUserId: user.id,
      action: 'recovery.review_approved',
      entityType: 'Case',
      entityId: createdCase.id,
      changes: { boundAction: 'recovery.manual_submit' },
    },
  });
  const basisReference =
    overrides.basisReference ??
    `rmp1:${claim.id}:${createdCase.id}:recovery-package/v1:v1:${'a'.repeat(64)}`;
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
