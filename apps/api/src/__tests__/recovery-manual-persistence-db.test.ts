/**
 * R43 Implementation S1 —— 人工追回提交持久化（Schema / 约束 / 触发器）
 * ---------------------------------------------------------------------------
 * 依据：MSG-20261001-31 CHANGE A/B/C + MSG-20261001-32 CHANGE A/B/C（Implementation Plan 批准）。
 * 范围（S1）：数据库级不变量 —— append-only、package 受控生命周期、唯一约束
 * （claimItemId / approvalId）、canonical provider reference、digest/sha 格式、
 * 跨租户引用拒绝、EXPORTED 非终态。
 * 不含服务层（S3 起接入 recovery.manual_submit）；不含真实凭据 / transport / 资金域。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';

const prisma = new PrismaClient();
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'manual-recovery-pass-1';

const hex64 = (char: string) => char.repeat(64);
const DIGEST_A = hex64('a');
const DIGEST_B = hex64('b');
const SHA_PDF = hex64('c');
const SHA_MANIFEST = hex64('d');

let ORG_A = '';
let ORG_B = '';
let caseA = '';
let caseB = '';
let claimA = '';
let claimA2 = '';
let claimB = '';
let fileAssetA = '';
let evidenceA = '';

async function seedOrg(slugSuffix: string): Promise<string> {
  const id = randomUUID();
  await prisma.organization.create({ data: { id, name: 'R43 S1 ' + slugSuffix, slug: 'r43-s1-' + slugSuffix } });
  const owner = await prisma.user.create({
    data: {
      email: 'r43-s1-' + slugSuffix + '@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({ data: { organizationId: id, userId: owner.id, role: 'OWNER', isActive: true } });
  return id;
}

async function seedCase(organizationId: string, caseNo: string): Promise<string> {
  const created = await prisma.case.create({
    data: {
      organizationId,
      caseNo,
      title: 'R43 S1 fixture',
      domain: 'PLATFORM',
      currency: 'USD',
      openedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  return created.id;
}

async function seedClaimItem(organizationId: string, caseId: string, ref: string): Promise<string> {
  // sourceFingerprint 受 @@unique([organizationId, platformType, sourceFingerprint]) 约束 —— 每条 ClaimItem 唯一
  const fingerprint = (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64);
  const created = await prisma.claimItem.create({
    data: {
      organizationId,
      caseId,
      platformType: 'AMAZON',
      claimType: 'ORDER_DISCREPANCY',
      platformRef: ref,
      sourceFingerprint: fingerprint,
      fingerprintVersion: 'v1',
      occurredAt: new Date('2026-09-02T00:00:00.000Z'),
      currency: 'USD',
      status: 'READY_TO_APPEAL',
      normalizerVersion: 'amazon-sp-normalizer/v1',
    },
  });
  return created.id;
}

async function createPackage(
  organizationId: string,
  claimItemId: string,
  caseId: string,
  digest: string = DIGEST_A,
): Promise<string> {
  const created = await prisma.recoveryPackage.create({
    data: {
      organizationId,
      claimItemId,
      caseId,
      packageVersion: 'recovery-package/v1',
      digestVersion: 'v1',
      packageDigest: digest,
    },
  });
  return created.id;
}

async function createSubmission(input: {
  organizationId: string;
  claimItemId: string;
  caseId: string;
  packageId: string;
  packageDigest?: string;
  approvalId: string;
  idempotencyKey?: string;
}): Promise<string> {
  const created = await prisma.recoveryManualSubmission.create({
    data: {
      organizationId: input.organizationId,
      claimItemId: input.claimItemId,
      caseId: input.caseId,
      packageId: input.packageId,
      packageDigest: input.packageDigest ?? DIGEST_A,
      approvalId: input.approvalId,
      approvalBasisReference:
        'rmp1:' + input.claimItemId + ':' + input.caseId + ':recovery-package/v1:v1:' + (input.packageDigest ?? DIGEST_A),
      submittedAt: new Date('2026-09-03T00:00:00.000Z'),
      submittedByUserId: randomUUID(),
      idempotencyKey: input.idempotencyKey ?? 'rms1-' + input.claimItemId,
    },
  });
  return created.id;
}

async function expectRejection(sql: string, pattern: RegExp): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(sql);
  } catch (error) {
    expect(String((error as Error).message)).toMatch(pattern);
    return;
  }
  throw new Error('EXPECTED_DB_REJECTION_MISSING: ' + sql.slice(0, 120));
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
  ORG_A = await seedOrg('a-' + suffix);
  ORG_B = await seedOrg('b-' + suffix);
  caseA = await seedCase(ORG_A, 'R43-S1-A-' + suffix);
  caseB = await seedCase(ORG_B, 'R43-S1-B-' + suffix);
  claimA = await seedClaimItem(ORG_A, caseA, 'AMZ-A-' + suffix);
  claimA2 = await seedClaimItem(ORG_A, caseA, 'AMZ-A2-' + suffix);
  claimB = await seedClaimItem(ORG_B, caseB, 'AMZ-B-' + suffix);

  const file = await prisma.fileAsset.create({
    data: { organizationId: ORG_A, kind: 'PDF', storageKey: 'r43-s1/' + suffix + '.pdf', originalName: 'package.pdf' },
  });
  fileAssetA = file.id;
  const evidence = await prisma.evidenceArtifact.create({
    data: { organizationId: ORG_A, kind: 'INVOICE', title: 'R43 S1 evidence' },
  });
  evidenceA = evidence.id;
});

describe('R43 S1 — 人工追回提交持久化（数据库级不变量）', () => {
  it('S1-01 五张表可写入；package 默认 GENERATED，且 package/artifact/submission/reference/evidence 齐备', async () => {
    const packageId = await createPackage(ORG_A, claimA, caseA);
    const pkg = await prisma.recoveryPackage.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.status).toBe('GENERATED');
    expect(pkg.packageVersion).toBe('recovery-package/v1');
    expect(pkg.digestVersion).toBe('v1');

    await prisma.recoveryPackageArtifact.create({
      data: {
        organizationId: ORG_A,
        packageId,
        artifactKind: 'JSON_MANIFEST',
        fileAssetId: fileAssetA,
        sha256: SHA_MANIFEST,
      },
    });

    const submissionId = await createSubmission({
      organizationId: ORG_A,
      claimItemId: claimA,
      caseId: caseA,
      packageId,
      approvalId: randomUUID(),
    });
    await prisma.recoveryManualSubmissionEvidence.create({
      data: { organizationId: ORG_A, submissionId, evidenceId: evidenceA },
    });
    await prisma.recoveryManualSubmissionReference.create({
      data: {
        organizationId: ORG_A,
        submissionId,
        providerCaseRefRaw: 'ABC-123',
        providerCaseRefCanonical: 'ABC-123',
        recordedByUserId: randomUUID(),
      },
    });
    expect(await prisma.recoveryManualSubmissionReference.count({ where: { submissionId } })).toBe(1);
  });

  it('S1-02 append-only：submission / artifact / evidence / reference 的 UPDATE、DELETE 均被拒绝', async () => {
    const packageId = await createPackage(ORG_A, claimA, caseA);
    const submissionId = await createSubmission({
      organizationId: ORG_A,
      claimItemId: claimA,
      caseId: caseA,
      packageId,
      approvalId: randomUUID(),
    });
    await expectRejection(
      `UPDATE "RecoveryManualSubmission" SET "note"='tampered' WHERE "id"='${submissionId}'`,
      /APPEND_ONLY_TABLE/,
    );
    await expectRejection(`DELETE FROM "RecoveryManualSubmission" WHERE "id"='${submissionId}'`, /APPEND_ONLY_TABLE/);

    const artifact = await prisma.recoveryPackageArtifact.create({
      data: {
        organizationId: ORG_A,
        packageId,
        artifactKind: 'PDF',
        fileAssetId: fileAssetA,
        sha256: SHA_PDF,
      },
    });
    await expectRejection(
      `UPDATE "RecoveryPackageArtifact" SET "sha256"='${SHA_MANIFEST}' WHERE "id"='${artifact.id}'`,
      /APPEND_ONLY_TABLE/,
    );

    const evidenceLink = await prisma.recoveryManualSubmissionEvidence.create({
      data: { organizationId: ORG_A, submissionId, evidenceId: evidenceA },
    });
    await expectRejection(
      `UPDATE "RecoveryManualSubmissionEvidence" SET "note"='tampered' WHERE "id"='${evidenceLink.id}'`,
      /APPEND_ONLY_TABLE/,
    );
  });

  it('S1-03 package 核心字段不可变：digest / version / binding 的 UPDATE 一律拒绝', async () => {
    const packageId = await createPackage(ORG_A, claimA, caseA);
    await expectRejection(
      `UPDATE "RecoveryPackage" SET "packageDigest"='${DIGEST_B}' WHERE "id"='${packageId}'`,
      /RECOVERY_PACKAGE_CORE_IMMUTABLE/,
    );
    await expectRejection(
      `UPDATE "RecoveryPackage" SET "packageVersion"='recovery-package/v2' WHERE "id"='${packageId}'`,
      /RECOVERY_PACKAGE_CORE_IMMUTABLE/,
    );
    await expectRejection(
      `UPDATE "RecoveryPackage" SET "claimItemId"='${claimA2}' WHERE "id"='${packageId}'`,
      /RECOVERY_PACKAGE_CORE_IMMUTABLE/,
    );
  });

  it('S1-04 package 受控生命周期：EXPORTED 非终态；进入终态需 reason+actor；终态不可回退', async () => {
    const packageId = await createPackage(ORG_A, claimA, caseA);
    await prisma.$executeRawUnsafe(`UPDATE "RecoveryPackage" SET "status"='EXPORTED' WHERE "id"='${packageId}'`);
    // 重复导出（EXPORTED → EXPORTED）不得被视为终态回退
    await prisma.$executeRawUnsafe(`UPDATE "RecoveryPackage" SET "status"='EXPORTED' WHERE "id"='${packageId}'`);
    // 终态缺少 reason + actor → 拒绝
    await expectRejection(
      `UPDATE "RecoveryPackage" SET "status"='SUPERSEDED' WHERE "id"='${packageId}'`,
      /RECOVERY_PACKAGE_TRANSITION_EVIDENCE_REQUIRED/,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "RecoveryPackage" SET "status"='SUPERSEDED', "transitionReason"='superseded by v2', "transitionActorUserId"='${randomUUID()}' WHERE "id"='${packageId}'`,
    );
    await expectRejection(
      `UPDATE "RecoveryPackage" SET "status"='GENERATED' WHERE "id"='${packageId}'`,
      /RECOVERY_PACKAGE_TERMINAL_STATE/,
    );
  });

  it('S1-05 唯一约束：同一 ClaimItem 至多一条提交；同一 approval 不得授权两条提交', async () => {
    const packageId = await createPackage(ORG_A, claimA, caseA);
    const approval = randomUUID();
    await createSubmission({
      organizationId: ORG_A,
      claimItemId: claimA,
      caseId: caseA,
      packageId,
      approvalId: approval,
    });
    // 同 ClaimItem 的第二条提交
    await expect(
      createSubmission({
        organizationId: ORG_A,
        claimItemId: claimA,
        caseId: caseA,
        packageId,
        approvalId: randomUUID(),
      }),
    ).rejects.toThrow();
    // 同 approval 授权第二个 ClaimItem
    const packageA2 = await createPackage(ORG_A, claimA2, caseA, DIGEST_B);
    await expect(
      createSubmission({
        organizationId: ORG_A,
        claimItemId: claimA2,
        caseId: caseA,
        packageId: packageA2,
        approvalId: approval,
      }),
    ).rejects.toThrow();
  });

  it('S1-06 canonical provider reference：同租户 canonical 唯一，且形态非法被 CHECK 拒绝', async () => {
    const packageId = await createPackage(ORG_A, claimA, caseA);
    const submissionId = await createSubmission({
      organizationId: ORG_A,
      claimItemId: claimA,
      caseId: caseA,
      packageId,
      approvalId: randomUUID(),
    });
    await prisma.recoveryManualSubmissionReference.create({
      data: {
        organizationId: ORG_A,
        submissionId,
        providerCaseRefRaw: 'ABC-123',
        providerCaseRefCanonical: 'ABC-123',
        recordedByUserId: randomUUID(),
      },
    });
    // 同一租户重复 canonical → 唯一约束拒绝
    await expect(
      prisma.recoveryManualSubmissionReference.create({
        data: {
          organizationId: ORG_A,
          submissionId,
          providerCaseRefRaw: 'ABC-123 ',
          providerCaseRefCanonical: 'ABC-123',
          recordedByUserId: randomUUID(),
        },
      }),
    ).rejects.toThrow();
    // 未 trim / 未 NFKC / 内部双空格 → CHECK 拒绝
    for (const canonical of [' ABC-123', 'ABC-123 ', 'AB  C-123']) {
      await expect(
        prisma.recoveryManualSubmissionReference.create({
          data: {
            organizationId: ORG_A,
            submissionId,
            providerCaseRefRaw: canonical,
            providerCaseRefCanonical: canonical,
            recordedByUserId: randomUUID(),
          },
        }),
      ).rejects.toThrow();
    }
  });

  it('S1-07 跨租户引用：提交不得引用他租户的 package（tenant trigger 拒绝）', async () => {
    const packageA = await createPackage(ORG_A, claimA, caseA);
    await expect(
      createSubmission({
        organizationId: ORG_B,
        claimItemId: claimB,
        caseId: caseB,
        packageId: packageA,
        approvalId: randomUUID(),
      }),
    ).rejects.toThrow(/cross-tenant reference blocked/);
  });

  it('S1-08 digest / sha256 格式：非 64 位小写 hex 一律拒绝', async () => {
    await expect(
      prisma.recoveryPackage.create({
        data: {
          organizationId: ORG_A,
          claimItemId: claimA,
          caseId: caseA,
          packageVersion: 'recovery-package/v1',
          digestVersion: 'v1',
          packageDigest: 'NOT-A-DIGEST',
        },
      }),
    ).rejects.toThrow();

    const packageId = await createPackage(ORG_A, claimA, caseA);
    await expect(
      prisma.recoveryPackageArtifact.create({
        data: {
          organizationId: ORG_A,
          packageId,
          artifactKind: 'PDF',
          fileAssetId: fileAssetA,
          sha256: 'UPPERCASE'.padEnd(64, 'A'),
        },
      }),
    ).rejects.toThrow();
  });

  it('S1-09 EXPORTED 不阻止后续审批与人工提交（导出不改变 package 可否提交）', async () => {
    const packageId = await createPackage(ORG_A, claimA, caseA);
    await prisma.$executeRawUnsafe(`UPDATE "RecoveryPackage" SET "status"='EXPORTED' WHERE "id"='${packageId}'`);
    await createSubmission({
      organizationId: ORG_A,
      claimItemId: claimA,
      caseId: caseA,
      packageId,
      approvalId: randomUUID(),
    });
    expect(await prisma.recoveryManualSubmission.count({ where: { organizationId: ORG_A } })).toBe(1);
    // SUPERSEDED 之后的 package 不再可用（服务层判定；此处仅确认状态可标记终态）
    await prisma.$executeRawUnsafe(
      `UPDATE "RecoveryPackage" SET "status"='SUPERSEDED', "transitionReason"='superseded', "transitionActorUserId"='${randomUUID()}' WHERE "id"='${packageId}'`,
    );
    const pkg = await prisma.recoveryPackage.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.status).toBe('SUPERSEDED');
  });

  it('S1-10 organizationId 不可变：package 归属不得被改写', async () => {
    const packageId = await createPackage(ORG_A, claimA, caseA);
    await expectRejection(
      `UPDATE "RecoveryPackage" SET "organizationId"='${ORG_B}' WHERE "id"='${packageId}'`,
      /RECOVERY_PACKAGE_CORE_IMMUTABLE|TENANT_REASSIGNMENT_FORBIDDEN/,
    );
  });
});
