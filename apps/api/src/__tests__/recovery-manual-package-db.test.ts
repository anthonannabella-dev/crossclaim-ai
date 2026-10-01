/**
 * R43 S2 —— Recovery Package 持久化：幂等生成 / CAS 生命周期 / artifact 落库
 * 覆盖 MSG-20261001-33 TEST 7–10、12（DB 部分）+ 边界不变量（无 SUBMITTED_MANUAL、不消费 approval、不创建 submission）。
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../services/auth';
import {
  RECOVERY_NOT_SUBMITTED_LABEL,
  RECOVERY_PACKAGE_VERSION,
  buildRecoveryManifest,
  computePackageDigest,
  generateRecoveryPackage,
  persistPackageArtifacts,
  transitionRecoveryPackage,
  type RecoveryManifestFactInput,
} from '../services/recovery/recovery-package';

const prisma = new PrismaClient();
const FAST_PARAMS = { N: 1024, r: 8, p: 1, keyLength: 64 };
const PASSWORD = 'recovery-package-pass-1';

let ORG = '';
let caseId = '';
let claimItemId = '';
let actorUserId = '';
let evidenceId = '';

function fact(overrides: Partial<RecoveryManifestFactInput> = {}): RecoveryManifestFactInput {
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
    ...overrides,
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
  await prisma.organization.create({ data: { id: ORG, name: 'R43 S2 租户', slug: 'r43-s2-' + suffix } });
  const owner = await prisma.user.create({
    data: {
      email: 'r43-s2-' + suffix + '@example.com',
      passwordHash: hashPassword(PASSWORD, FAST_PARAMS),
      displayName: 'OWNER',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  actorUserId = owner.id;
  await prisma.membership.create({ data: { organizationId: ORG, userId: owner.id, role: 'OWNER', isActive: true } });

  const createdCase = await prisma.case.create({
    data: {
      organizationId: ORG,
      caseNo: 'R43-S2-' + suffix,
      title: 'R43 S2 fixture',
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
      platformRef: 'AMZ-S2-' + suffix,
      sourceFingerprint: (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64),
      fingerprintVersion: 'v1',
      occurredAt: new Date('2026-09-02T00:00:00.000Z'),
      currency: 'USD',
      status: 'READY_TO_APPEAL',
      normalizerVersion: 'amazon-sp-normalizer/v1',
    },
  });
  claimItemId = claim.id;
  const evidence = await prisma.evidenceArtifact.create({
    data: { organizationId: ORG, kind: 'INVOICE', title: 'R43 S2 evidence' },
  });
  evidenceId = evidence.id;
});

describe('R43 S2 — Recovery Package（生成 / CAS / artifact）', () => {
  it('S2-07 相同业务输入重复生成 → 同一 package（不产生第二条逻辑 package）', async () => {
    const first = await generateRecoveryPackage({ fact: fact(), actorUserId }, { prisma });
    expect(first.created).toBe(true);
    expect(first.status).toBe('GENERATED');

    const second = await generateRecoveryPackage({ fact: fact(), actorUserId }, { prisma });
    expect(second.created).toBe(false);
    expect(second.packageId).toBe(first.packageId);
    expect(second.packageDigest).toBe(first.packageDigest);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: ORG } })).toBe(1);
    // 生成审计存在且只登记一次
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: 'recovery.package_generated' } }),
    ).toBe(1);
  });

  it('S2-08 GENERATED → EXPORTED 非终态：重复导出不改变业务含义，package 仍可用于后续提交流程', async () => {
    const generated = await generateRecoveryPackage({ fact: fact(), actorUserId }, { prisma });
    const first = await transitionRecoveryPackage(
      { organizationId: ORG, packageId: generated.packageId, actorUserId, transition: { to: 'EXPORTED' } },
      { prisma },
    );
    expect(first.status).toBe('EXPORTED');
    const again = await transitionRecoveryPackage(
      { organizationId: ORG, packageId: generated.packageId, actorUserId, transition: { to: 'EXPORTED' } },
      { prisma },
    );
    expect(again.changed).toBe(false);
    const pkg = await prisma.recoveryPackage.findUniqueOrThrow({ where: { id: generated.packageId } });
    expect(pkg.status).toBe('EXPORTED');
    // 导出不产生“已提交”事实
    expect(await prisma.recoveryManualSubmission.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.claimItem.findUniqueOrThrow({ where: { id: claimItemId } })).toMatchObject({
      status: 'READY_TO_APPEAL',
    });
  });

  it('S2-09 终态转换：SUPERSEDED 需 reason；终态不可回退；SUPERSEDED 后不可再导出', async () => {
    const generated = await generateRecoveryPackage({ fact: fact(), actorUserId }, { prisma });
    await transitionRecoveryPackage(
      { organizationId: ORG, packageId: generated.packageId, actorUserId, transition: { to: 'EXPORTED' } },
      { prisma },
    );
    await expect(
      transitionRecoveryPackage(
        { organizationId: ORG, packageId: generated.packageId, actorUserId, transition: { to: 'SUPERSEDED', reason: '  ' } },
        { prisma },
      ),
    ).rejects.toThrowError(/TRANSITION_REASON_REQUIRED/);

    const superseded = await transitionRecoveryPackage(
      {
        organizationId: ORG,
        packageId: generated.packageId,
        actorUserId,
        transition: { to: 'SUPERSEDED', reason: 'newer digest v2' },
      },
      { prisma },
    );
    expect(superseded.status).toBe('SUPERSEDED');
    await expect(
      transitionRecoveryPackage(
        { organizationId: ORG, packageId: generated.packageId, actorUserId, transition: { to: 'EXPORTED' } },
        { prisma },
      ),
    ).rejects.toThrowError(/PACKAGE_TERMINAL/);
    const pkg = await prisma.recoveryPackage.findUniqueOrThrow({ where: { id: generated.packageId } });
    expect(pkg.transitionReason).toBe('newer digest v2');
    expect(pkg.transitionActorUserId).toBe(actorUserId);
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: 'recovery.package_superseded' } }),
    ).toBe(1);
  });

  it('S2-10 CAS：并发同一跃迁至多一次真正改变状态（且只写一条审计）；陈旧期望不得写入', async () => {
    const generated = await generateRecoveryPackage({ fact: fact(), actorUserId }, { prisma });
    const results = await Promise.allSettled([
      transitionRecoveryPackage(
        {
          organizationId: ORG,
          packageId: generated.packageId,
          actorUserId,
          transition: { to: 'WITHDRAWN', reason: 'duplicate attempt A' },
        },
        { prisma },
      ),
      transitionRecoveryPackage(
        {
          organizationId: ORG,
          packageId: generated.packageId,
          actorUserId,
          transition: { to: 'WITHDRAWN', reason: 'duplicate attempt B' },
        },
        { prisma },
      ),
    ]);
    const changed = results.filter(
      (r) => r.status === 'fulfilled' && (r.value as { changed: boolean }).changed,
    );
    expect(changed.length).toBe(1);
    const pkg = await prisma.recoveryPackage.findUniqueOrThrow({ where: { id: generated.packageId } });
    expect(pkg.status).toBe('WITHDRAWN');
    expect(['duplicate attempt A', 'duplicate attempt B']).toContain(pkg.transitionReason);
    // 只有一次状态跃迁 → 只有一条终态审计（无重复写入）
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: 'recovery.package_withdrawn' } }),
    ).toBe(1);

    // 陈旧期望：终态之后任何状态写入都必须被拒绝（不得以过期读覆盖）
    await expect(
      transitionRecoveryPackage(
        { organizationId: ORG, packageId: generated.packageId, actorUserId, transition: { to: 'EXPORTED' } },
        { prisma },
      ),
    ).rejects.toThrowError(/PACKAGE_TERMINAL/);
    expect(
      (await prisma.recoveryPackage.findUniqueOrThrow({ where: { id: generated.packageId } })).status,
    ).toBe('WITHDRAWN');
  });

  it('S2-11 artifact 落库：JSON manifest + PDF，引用既有 FileAsset，重复导出不新增第二份', async () => {
    const generated = await generateRecoveryPackage({ fact: fact(), actorUserId }, { prisma });
    const manifest = buildRecoveryManifest(fact());
    const first = await persistPackageArtifacts(
      {
        organizationId: ORG,
        packageId: generated.packageId,
        exportedByUserId: actorUserId,
        storageKeyPrefix: 'recovery-packages',
        originalNameBase: 'recovery-package',
        manifest,
      },
      { prisma },
    );
    const second = await persistPackageArtifacts(
      {
        organizationId: ORG,
        packageId: generated.packageId,
        exportedByUserId: actorUserId,
        storageKeyPrefix: 'recovery-packages',
        originalNameBase: 'recovery-package',
        manifest,
      },
      { prisma },
    );
    expect(second.manifestArtifactId).toBe(first.manifestArtifactId);
    expect(second.pdfArtifactId).toBe(first.pdfArtifactId);
    expect(await prisma.recoveryPackageArtifact.count({ where: { organizationId: ORG } })).toBe(2);

    const artifacts = await prisma.recoveryPackageArtifact.findMany({
      where: { organizationId: ORG },
      include: { fileAsset: true },
    });
    const manifestArtifact = artifacts.find((row) => row.artifactKind === 'JSON_MANIFEST');
    expect(manifestArtifact?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestArtifact?.fileAsset.mimeType).toBe('application/json');
    expect(artifacts.find((row) => row.artifactKind === 'PDF')?.fileAsset.mimeType).toBe('application/pdf');
  });

  it('S2-12 边界：S2 不产生 SUBMITTED_MANUAL、不创建 submission、不消费 approval、不改资金域', async () => {
    const generated = await generateRecoveryPackage({ fact: fact(), actorUserId }, { prisma });
    await persistPackageArtifacts(
      {
        organizationId: ORG,
        packageId: generated.packageId,
        exportedByUserId: actorUserId,
        storageKeyPrefix: 'recovery-packages',
        originalNameBase: 'recovery-package',
        manifest: buildRecoveryManifest(fact()),
      },
      { prisma },
    );
    await transitionRecoveryPackage(
      { organizationId: ORG, packageId: generated.packageId, actorUserId, transition: { to: 'EXPORTED' } },
      { prisma },
    );

    expect(await prisma.recoveryManualSubmission.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.recoveryManualSubmissionReference.count({ where: { organizationId: ORG } })).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { organizationId: ORG, action: 'recovery.approval_consumed' } }),
    ).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: ORG, action: 'recovery.submitted_manual' } })).toBe(0);
    expect(await prisma.payment.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.settlement.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.recoveryLedgerEntry.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await prisma.billingInvoice.count({ where: { organizationId: ORG } })).toBe(0);

    // package 状态语义：EXPORTED ≠ 已提交；manifest 仍标注 NOT SUBMITTED
    const manifest = buildRecoveryManifest(fact());
    expect(manifest.label).toBe(RECOVERY_NOT_SUBMITTED_LABEL);
    expect(manifest.packageVersion).toBe(RECOVERY_PACKAGE_VERSION);
    expect(computePackageDigest(manifest)).toBe(generated.packageDigest);
  });
});
