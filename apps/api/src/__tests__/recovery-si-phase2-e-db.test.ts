/**
 * Recovery SI P2-E1/E3(后半)/E4 —— 真实 PostgreSQL 取证
 * 依据：MSG-20261005-22（P2-E v1 = PASS WITH REVISE；Option A）
 *   必修 2：package / FileAsset / artifact / audit 必须收进单一事务（任一步失败整笔回滚）
 *   必修 3：lineage 落库可反查（planDigest 只作 trace basis，业务身份仍是 packageDigest）
 *   必修 4：RecoveryPackage / RecoveryPackageArtifact 的 DB 层 DELETE 拒绝
 *
 * 本文件的证据全部来自**真实数据库**（读 + 受控写入后清理），不使用 mock：
 *   · 只读取证（pg_trigger / pg_proc / 触发器清单）不写业务事实；
 *   · 写入取证只在测试租户内进行，afterAll TRUNCATE（TRUNCATE 不触发行级 DELETE 守卫）。
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createProductionControlPlane, type ControlPlaneConfig } from '../services/action-guard/control-plane';
import {
  RECOVERY_PACKAGE_VERSION,
  RECOVERY_PACKAGE_DIGEST_VERSION,
  sha256Hex,
} from '../services/recovery/recovery-package';
import {
  evaluateRecoveryPersistGate,
  RECOVERY_SI_PACKAGE_PERSISTED_ACTION,
  type RecoveryPersistGateOutcome,
  type RecoveryPersistUnitWrite,
} from '../services/intelligence/recovery-persist-gate';
import {
  buildRecoveryPersistUnits,
  buildRecoverySiPackageLineageAuditLog,
  createPrismaRecoveryPersistPort,
  persistRecoveryPackageWithReplayConvergence,
  readRecoveryPackageLineage,
  readRecoveryPackagePlanDigestFromAudit,
  type RecoveryPersistPrismaPayloads,
} from '../services/intelligence/recovery-persist-prisma-port';

const prisma = new PrismaClient();
const REPO_ROOT = path.resolve(process.cwd(), '..', '..');

const plane = (config: Partial<ControlPlaneConfig>) =>
  createProductionControlPlane({
    killSwitch: {
      async resolve(scope, organizationId) {
        return { scope, organizationId, value: 'enabled' as const, degraded: false };
      },
    },
    config: {
      read: () => ({
        globalDisabled: false,
        mode: 'WRITE_ENABLED',
        productionGate: 'SATISFIED',
        platformEnabled: { 'claim.prepare': true },
        tenantFeatureEnabled: { 'claim.prepare': true },
        hostApprovalGranted: true,
        ...config,
      }),
    },
  });

const ALLOW_CONFIG: Partial<ControlPlaneConfig> = {};

interface TenantFixture {
  organizationId: string;
  caseId: string;
  claimItemId: string;
  userId: string;
}

let orgA: TenantFixture;
let orgB: TenantFixture;

async function seedTenant(tag: string): Promise<TenantFixture> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const organizationId = randomUUID();
  await prisma.organization.create({
    data: { id: organizationId, name: 'P2E DB ' + tag, slug: 'p2e-db-' + tag + '-' + suffix },
  });
  const owner = await prisma.user.create({
    data: {
      email: 'p2e-db-' + tag + '-' + suffix + '@example.com',
      passwordHash: 'x',
      displayName: 'P2E ' + tag,
      status: 'ACTIVE',
      emailVerified: true,
    },
  });
  await prisma.membership.create({
    data: { organizationId, userId: owner.id, role: 'OWNER', isActive: true },
  });
  const createdCase = await prisma.case.create({
    data: {
      organizationId,
      caseNo: 'P2E-DB-' + tag.toUpperCase() + '-' + suffix,
      title: 'P2E DB fixture ' + tag,
      domain: 'PLATFORM',
      currency: 'USD',
      openedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  const claim = await prisma.claimItem.create({
    data: {
      organizationId,
      caseId: createdCase.id,
      platformType: 'AMAZON',
      claimType: 'ORDER_DISCREPANCY',
      platformRef: 'P2E-DB-' + tag.toUpperCase() + '-' + suffix,
      sourceFingerprint: (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64),
      fingerprintVersion: 'v1',
      occurredAt: new Date('2026-09-02T00:00:00.000Z'),
      currency: 'USD',
      status: 'READY_TO_APPEAL',
      normalizerVersion: 'amazon-sp-normalizer/v1',
    },
  });
  return {
    organizationId,
    caseId: createdCase.id,
    claimItemId: claim.id,
    userId: owner.id,
  };
}

const PLAN_DIGEST = sha256Hex('p2e-db-plan-digest-v1');

function payloads(
  tenant: TenantFixture,
  overrides: {
    digest?: string;
    auditActorUserId?: string | null;
    artifactFileAssetId?: string;
    fileAssetId?: string;
    packageId?: string;
    artifactId?: string;
    organizationId?: string;
  } = {},
): RecoveryPersistPrismaPayloads {
  const organizationId = overrides.organizationId ?? tenant.organizationId;
  const digest = overrides.digest ?? sha256Hex('p2e-db-package:' + tenant.claimItemId);
  const fileAssetId = overrides.fileAssetId ?? randomUUID();
  const packageId = overrides.packageId ?? randomUUID();
  return {
    package: {
      id: packageId,
      organizationId,
      claimItemId: tenant.claimItemId,
      caseId: tenant.caseId,
      packageVersion: RECOVERY_PACKAGE_VERSION,
      digestVersion: RECOVERY_PACKAGE_DIGEST_VERSION,
      packageDigest: digest,
      completenessSnapshot: ['evidence-1'],
      generatedByUserId: tenant.userId,
    },
    fileAsset: {
      id: fileAssetId,
      organizationId,
      kind: 'PDF',
      storageKey: 'p2e-db/' + fileAssetId + '.pdf',
      originalName: 'recovery-package.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      sha256: sha256Hex('p2e-db-pdf-v1'),
      uploadedBy: tenant.userId,
    },
    artifact: {
      id: overrides.artifactId ?? randomUUID(),
      organizationId,
      packageId,
      artifactKind: 'PDF',
      fileAssetId: overrides.artifactFileAssetId ?? fileAssetId,
      sha256: sha256Hex('p2e-db-pdf-v1'),
      exportedByUserId: tenant.userId,
    },
    auditLog: {
      ...buildRecoverySiPackageLineageAuditLog({
        organizationId,
        actorUserId: overrides.auditActorUserId ?? tenant.userId,
        packageId,
        packageVersion: RECOVERY_PACKAGE_VERSION,
        packageDigest: digest,
        planDigestVersion: 'plan-digest/v1',
        planDigest: PLAN_DIGEST,
        basisVersion: 'recovery-execution-basis/v1',
        opportunityRef: 'opp-p2e-db',
        domain: 'CARRIER',
      }),
      id: randomUUID(),
    },
  };
}

async function gateFor(tenant: TenantFixture, config: Partial<ControlPlaneConfig> = ALLOW_CONFIG) {
  return evaluateRecoveryPersistGate({
    organizationId: tenant.organizationId,
    actorUserId: tenant.userId,
    actorOrganizationId: tenant.organizationId,
    controlPlane: plane(config),
  });
}

const ALLOW_GATE: RecoveryPersistGateOutcome = {
  decision: 'ALLOW',
  code: 'ALLOW',
  reasons: [],
  guardAction: 'claim.prepare',
  guardEvaluated: true,
  canonicalReadyVerified: true,
  canonicalPlanDigest: sha256Hex('p2e-db-canonical-plan-digest'),
  lineageAction: RECOVERY_SI_PACKAGE_PERSISTED_ACTION,
  persisted: false,
  transactionRequired: true,
  dbDeleteGuardRequired: true,
  approvalConsumed: false,
  executorInvoked: false,
};

const seedPlan = async () => {
  orgA = await seedTenant('a');
  orgB = await seedTenant('b');
};

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  await seedPlan();
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

describe('Recovery SI P2-E DB · DELETE guard 触发器取证（只读）', () => {
  it('P2E-DB1 cc_no_delete__RecoveryPackage / __RecoveryPackageArtifact 已部署且为 BEFORE DELETE', async () => {
    const rows = await prisma.$queryRawUnsafe<{ tgname: string; def: string }[]>(
      `SELECT t.tgname AS tgname, pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal
          AND t.tgname IN ('cc_no_delete__RecoveryPackage', 'cc_no_delete__RecoveryPackageArtifact')`,
    );
    const byName = new Map(rows.map((r) => [r.tgname, r.def]));
    expect([...byName.keys()].sort()).toEqual([
      'cc_no_delete__RecoveryPackage',
      'cc_no_delete__RecoveryPackageArtifact',
    ]);
    for (const def of byName.values()) {
      expect(def).toMatch(/BEFORE DELETE/i);
    }
  });

  it('P2E-DB2 DELETE guard 函数体仍抛 RECOVERY_PACKAGE_DELETE_FORBIDDEN（迁移可追溯）', async () => {
    const rows = await prisma.$queryRawUnsafe<{ src: string }[]>(
      `SELECT prosrc AS src FROM pg_proc WHERE proname IN ('cc_recovery_package_no_delete', 'cc_recovery_package_artifact_no_delete')`,
    );
    const all = rows.map((r) => r.src).join('\n');
    expect(all).toContain('RECOVERY_PACKAGE_DELETE_FORBIDDEN');
    expect(all).toContain('RECOVERY_PACKAGE_ARTIFACT_DELETE_FORBIDDEN');
  });
});

describe('Recovery SI P2-E DB · 触发器清单 ↔ 运行库一致（E4）', () => {
  it('P2E-DB3 tenant / append-only 两份清单校验 SQL 在真实库上直接通过', async () => {
    for (const script of ['emit-check-sql.mjs', 'emit-check-append-only-sql.mjs']) {
      const sql = execFileSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'tenant-triggers', script)], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      expect(sql).toContain('DO $$');
      // RAISE EXCEPTION 会让这一行抛出；顺利返回即证明清单与运行库一致。
      await prisma.$executeRawUnsafe(sql);
    }
  });

  it('P2E-DB4 清单真源已登记两条 DELETE guard（名称 + 表 + tgtype=11）', async () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'tools', 'tenant-triggers', 'append-only-triggers.json'), 'utf8'),
    ) as { triggers: { name: string; table: string; tgtype: number }[]; unexpectedPrefixes: string[] };
    const guards = manifest.triggers.filter((t) => t.name.startsWith('cc_no_delete__'));
    expect(guards.map((t) => [t.name, t.table, t.tgtype]).sort()).toEqual([
      ['cc_no_delete__RecoveryPackage', 'RecoveryPackage', 11],
      ['cc_no_delete__RecoveryPackageArtifact', 'RecoveryPackageArtifact', 11],
    ]);
    expect(manifest.unexpectedPrefixes).toContain('cc_no_delete__%');
  });
});

describe('Recovery SI P2-E DB · 单一事务写入 / 原子性 / 幂等（必修 2）', () => {
  it('P2E-DB5 gate=ALLOW → 四单元在同一事务落库，且零外部业务事实写入', async () => {
    const payload = payloads(orgA);
    const port = createPrismaRecoveryPersistPort(prisma);

    // 门禁契约（canonical READY 重算 + claim.prepare）由 unit 套件 P2E-G1..G22 覆盖；
    // 本 DB 套件聚焦「门禁 ALLOW 之后」的事务/DB 行为，故这里直接使用 ALLOW 门禁结果。
    const result = await persistRecoveryPackageWithReplayConvergence({
      gate: ALLOW_GATE,
      units: buildRecoveryPersistUnits(payload),
      port,
    });

    expect(result.persisted).toBe(true);
    expect(result.code).toBe('P2E_PERSISTED');
    expect(result.unitsWritten).toBe(4);
    expect(result.businessIdentity).toBe('packageDigest');
    expect(result.traceBasis).toBe('planDigest');

    const stored = await prisma.recoveryPackage.findUniqueOrThrow({ where: { id: payload.package.id } });
    expect(stored.organizationId).toBe(orgA.organizationId);
    expect(stored.packageDigest).toBe(payload.package.packageDigest);
    expect(stored.packageVersion).toBe(RECOVERY_PACKAGE_VERSION);
    expect(stored.digestVersion).toBe(RECOVERY_PACKAGE_DIGEST_VERSION);

    expect(await prisma.fileAsset.count({ where: { id: payload.fileAsset.id! } })).toBe(1);
    expect(await prisma.recoveryPackageArtifact.count({ where: { id: payload.artifact.id! } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { id: payload.auditLog.id! } })).toBe(1);

    // P2E-06：零外写 —— 八类业务事实一律为 0
    expect(await prisma.claim.count()).toBe(0);
    expect(await prisma.platformWriteAttempt.count()).toBe(0);
    expect(await prisma.customsSubmissionAttempt.count()).toBe(0);
    expect(await prisma.recoveryManualSubmission.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.settlement.count()).toBe(0);
    expect(await prisma.recoveryLedgerEntry.count()).toBe(0);
    expect(await prisma.billingInvoice.count()).toBe(0);
  });

  it('P2E-DB6 任一单元失败 → 整笔回滚（无孤儿 package / fileAsset / artifact / audit）', async () => {
    const failing = payloads(orgA, { auditActorUserId: randomUUID() });
    const port = createPrismaRecoveryPersistPort(prisma);

    await expect(
      persistRecoveryPackageWithReplayConvergence({
        gate: ALLOW_GATE,
        units: buildRecoveryPersistUnits(failing),
        port,
      }),
    ).rejects.toBeTruthy();

    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.fileAsset.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.recoveryPackageArtifact.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
  });

  it('P2E-DB7 同键重放 → 单包 + 唯一收敛，且不产生孤儿单元', async () => {
    const gate = ALLOW_GATE;
    const first = payloads(orgA, { digest: sha256Hex('p2e-db-replay') });
    const second = payloads(orgA, {
      digest: first.package.packageDigest,
      packageId: randomUUID(),
      fileAssetId: randomUUID(),
      artifactId: randomUUID(),
    });
    const port = createPrismaRecoveryPersistPort(prisma);

    const r1 = await persistRecoveryPackageWithReplayConvergence({
      gate,
      units: buildRecoveryPersistUnits(first),
      port,
    });
    const r2 = await persistRecoveryPackageWithReplayConvergence({
      gate,
      units: buildRecoveryPersistUnits(second),
      port,
    });

    expect(r1.persisted).toBe(true);
    expect(r2.persisted).toBe(false);
    expect(r2.converged).toBe(true);
    expect(r2.code).toBe('P2E_PACKAGE_ALREADY_EXISTS');
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(1);
    expect(await prisma.fileAsset.count({ where: { organizationId: orgA.organizationId } })).toBe(1);
    expect(await prisma.recoveryPackageArtifact.count({ where: { organizationId: orgA.organizationId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: orgA.organizationId } })).toBe(1);
  });

  it('P2E-DB8 并发同键 → 唯一赢家（单包 + 无孤儿单元）', async () => {
    const gate = ALLOW_GATE;
    const digest = sha256Hex('p2e-db-concurrent');
    const port = createPrismaRecoveryPersistPort(prisma);

    const attempt = async () =>
      persistRecoveryPackageWithReplayConvergence({
        gate,
        units: buildRecoveryPersistUnits(payloads(orgA, { digest })),
        port,
      });

    const settled = await Promise.allSettled([attempt(), attempt()]);
    const persisted = settled.filter(
      (r) => r.status === 'fulfilled' && r.value.persisted,
    ).length;
    expect(persisted).toBe(1);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(1);
    expect(await prisma.fileAsset.count({ where: { organizationId: orgA.organizationId } })).toBe(1);
    expect(await prisma.recoveryPackageArtifact.count({ where: { organizationId: orgA.organizationId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: orgA.organizationId } })).toBe(1);
  });

  it('P2E-DB9 gate 非 ALLOW → 端口零调用、DB 零写入', async () => {
    const gate = await gateFor(orgA, { globalDisabled: true });
    let called = 0;
    const port = {
      async runInTransaction(_units: readonly RecoveryPersistUnitWrite[]) {
        called += 1;
      },
    };
    const result = await persistRecoveryPackageWithReplayConvergence({
      gate,
      units: buildRecoveryPersistUnits(payloads(orgA)),
      port,
    });
    expect(result.persisted).toBe(false);
    expect(result.code).toBe('P2E_GATE_NOT_ALLOWED');
    expect(called).toBe(0);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
  });
});

describe('Recovery SI P2-E DB · 租户隔离（必修 2/3）', () => {
  it('P2E-DB10 跨租户混批 fail-closed（应用层）+ DB 层跨租户引用被租户触发器拒绝', async () => {
    const port = createPrismaRecoveryPersistPort(prisma);

    // ① 应用层：同一批里出现两个 organizationId → fail-closed，且不触库
    const mixed = buildRecoveryPersistUnits(payloads(orgA, { digest: sha256Hex('p2e-db-tenant-mixed') })).map(
      (unit, index) =>
        index === 1
          ? { ...unit, payload: { ...(unit.payload as Record<string, unknown>), organizationId: orgB.organizationId } }
          : unit,
    );
    await expect(
      persistRecoveryPackageWithReplayConvergence({ gate: ALLOW_GATE, units: mixed, port }),
    ).rejects.toThrow(/P2E_TENANT_MIXED_BATCH/);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgB.organizationId } })).toBe(0);

    // ② 真实 DB：orgB 的 package 引用 orgA 的 ClaimItem → 租户触发器 cross-tenant reference blocked
    const crossTenantClaim = payloads(orgA, {
      digest: sha256Hex('p2e-db-tenant-cross'),
      organizationId: orgB.organizationId,
    });
    await expect(
      persistRecoveryPackageWithReplayConvergence({
        gate: ALLOW_GATE,
        units: buildRecoveryPersistUnits(crossTenantClaim),
        port,
      }),
    ).rejects.toThrow(/cross-tenant reference blocked/);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgB.organizationId } })).toBe(0);

    // ③ 真实落库后：orgB 的 artifact 不得引用 orgA 的 package（DB 触发器拒绝）
    const own = payloads(orgA, { digest: sha256Hex('p2e-db-tenant') });
    await persistRecoveryPackageWithReplayConvergence({
      gate: ALLOW_GATE,
      units: buildRecoveryPersistUnits(own),
      port,
    });
    await expect(
      prisma.recoveryPackageArtifact.create({
        data: {
          id: randomUUID(),
          organizationId: orgB.organizationId,
          packageId: own.package.id!,
          artifactKind: 'PDF',
          fileAssetId: randomUUID(),
          sha256: sha256Hex('cross-tenant-attempt'),
        },
      }),
    ).rejects.toThrow(/cross-tenant reference blocked|foreign key|violates/i);
  });

  it('P2E-DB11 反查受租户约束：跨租户 packageId 反查返回 null', async () => {
    const own = payloads(orgA, { digest: sha256Hex('p2e-db-tenant-read') });
    await persistRecoveryPackageWithReplayConvergence({
      gate: ALLOW_GATE,
      units: buildRecoveryPersistUnits(own),
      port: createPrismaRecoveryPersistPort(prisma),
    });
    expect(
      await readRecoveryPackageLineage({
        prisma,
        organizationId: orgA.organizationId,
        packageId: own.package.id!,
      }),
    ).not.toBeNull();
    expect(
      await readRecoveryPackageLineage({
        prisma,
        organizationId: orgB.organizationId,
        packageId: own.package.id!,
      }),
    ).toBeNull();
  });
});

describe('Recovery SI P2-E DB · lineage 落库反查（必修 3）', () => {
  it('P2E-DB12 反查链完整：packageDigest 是业务身份，planDigest 仅 trace basis', async () => {
    const payload = payloads(orgA, { digest: sha256Hex('p2e-db-lineage') });
    await persistRecoveryPackageWithReplayConvergence({
      gate: ALLOW_GATE,
      units: buildRecoveryPersistUnits(payload),
      port: createPrismaRecoveryPersistPort(prisma),
    });

    // CHANGE 2（MSG-20261005-23）：lineage 反查只认独立 action，不复用 recovery.package_generated
    const action = RECOVERY_SI_PACKAGE_PERSISTED_ACTION;
    const planDigest = await readRecoveryPackagePlanDigestFromAudit({
      prisma,
      organizationId: orgA.organizationId,
      packageId: payload.package.id!,
      action,
    });
    expect(planDigest).toBe(PLAN_DIGEST);
    expect(
      await readRecoveryPackagePlanDigestFromAudit({
        prisma,
        organizationId: orgA.organizationId,
        packageId: payload.package.id!,
        action: 'recovery.package_generated',
      }),
    ).toBeNull();

    const projection = await readRecoveryPackageLineage({
      prisma,
      organizationId: orgA.organizationId,
      packageId: payload.package.id!,
      planDigest,
    });
    expect(projection).not.toBeNull();
    expect(projection!.chain).toEqual([
      'CanonicalSourceFacts',
      'RecoveryPackage',
      'RecoveryPackageArtifact',
      'FileAsset',
      'packageDigest',
      'AuditLog',
    ]);
    expect(projection!.businessIdentity).toBe('packageDigest');
    expect(projection!.identityValue).toBe(payload.package.packageDigest);
    expect(projection!.identityValue).not.toBe(planDigest);
    expect(projection!.traceBasis).toBe('planDigest');
    expect(projection!.planDigest).toBe(PLAN_DIGEST);
    expect(projection!.claimItemId).toBe(orgA.claimItemId);
    expect(projection!.artifactIds).toEqual([payload.artifact.id!]);
    expect(projection!.fileAssetIds).toEqual([payload.fileAsset.id!]);
    expect(projection!.orphanFileAssetIds).toEqual([]);
    expect(projection!.auditLogIds).toEqual([payload.auditLog.id!]);
  });
});

describe('Recovery SI P2-E DB · DELETE guard 行为取证（必修 4，写入后仍拒绝删除）', () => {
  it('P2E-DB13 对已落库的 RecoveryPackage / artifact 直接 DELETE 必须被 DB 拒绝且行保留', async () => {
    const payload = payloads(orgA, { digest: sha256Hex('p2e-db-delete-guard') });
    await persistRecoveryPackageWithReplayConvergence({
      gate: ALLOW_GATE,
      units: buildRecoveryPersistUnits(payload),
      port: createPrismaRecoveryPersistPort(prisma),
    });

    // RecoveryPackage：删除由本批新增的 cc_no_delete__RecoveryPackage 拒绝
    await expect(prisma.recoveryPackage.delete({ where: { id: payload.package.id! } })).rejects.toThrow(
      /RECOVERY_PACKAGE_DELETE_FORBIDDEN/,
    );
    // RecoveryPackageArtifact：删除被 BEFORE UPDATE OR DELETE 的既有 append-only 守卫先拦下
    // （tgtype 27 与新增 tgtype 11 同级，按名称序 cc_append_only__ 先触发）；
    // 无论哪一条拒绝，结论都是「DB 层不可删除」——新增 guard 的存在性由 P2E-DB1 取证。
    await expect(prisma.recoveryPackageArtifact.delete({ where: { id: payload.artifact.id! } })).rejects.toThrow(
      /APPEND_ONLY_TABLE|RECOVERY_PACKAGE_ARTIFACT_DELETE_FORBIDDEN/,
    );

    expect(await prisma.recoveryPackage.count({ where: { id: payload.package.id! } })).toBe(1);
    expect(await prisma.recoveryPackageArtifact.count({ where: { id: payload.artifact.id! } })).toBe(1);
  });
});
