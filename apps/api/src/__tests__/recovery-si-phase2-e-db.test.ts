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
  buildCustomerRecoveryState,
  type CapabilitySlice,
  type OpportunitySlice,
} from '../services/intelligence/customer-recovery-state';
import { planRecovery } from '../services/intelligence/recovery-planner';
import { prioritizeOpportunities } from '../services/intelligence/recovery-prioritizer';
import {
  createRecoveryToolRegistry,
  type RecoveryToolRegistry,
} from '../services/intelligence/recovery-tool-registry';
import {
  evaluateRecoveryPersistGate,
  RECOVERY_SI_PACKAGE_PERSISTED_ACTION,
  type RecoveryPersistGateOutcome,
  type RecoveryPersistTransactionPort,
  type RecoveryPersistUnitWrite,
} from '../services/intelligence/recovery-persist-gate';
import {
  buildRecoveryPersistUnits,
  buildRecoverySiPackageLineageAuditLog,
  persistRecoverySiPackageWithinTransaction,
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
  opportunityRef: string;
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
  const opportunity = await prisma.recoveryOpportunity.create({
    data: {
      id: 'opp-p2e-db-' + tag + '-' + suffix,
      organizationId,
      // DB 侧枚举是 LOGISTICS（SI 侧称 CARRIER）；opportunityRef 仍是 RecoveryOpportunity.id
      domain: 'LOGISTICS',
      channel: 'AMAZON_OTHER',
      opportunityType: 'CARRIER_RECOVERY',
      title: 'P2E DB opportunity ' + tag,
      currency: 'USD',
      detectedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  const claim = await prisma.claimItem.create({
    data: {
      organizationId,
      caseId: createdCase.id,
      opportunityId: opportunity.id,
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
    opportunityRef: opportunity.id,
  };
}

/** 写入口 canonical READY 重算夹具（参数化 organizationId，因为 DB 租户是随机的） */
const p2eStateFor = (
  organizationId: string,
  observedAt: string,
  opportunityRef: string,
): ReturnType<typeof buildCustomerRecoveryState> => {
  const capability = (domain: CapabilitySlice['domain']): CapabilitySlice => ({
    domain,
    readOnlyTools: [],
    providerApproval: 'READY',
  });
  const opportunity: OpportunitySlice = {
    opportunityRef,
    domain: 'CARRIER',
    organizationId,
    recoverable: { amount: 680, currency: 'USD', source: 'CANONICAL_FACT' },
    eligibility: 'ELIGIBLE',
    evidenceComplete: true,
    missingEvidence: [],
    authorizationReady: true,
    deadline: '2026-11-01T00:00:00.000Z',
    providerCostUsd: 0,
    expectedOperationalCostUsd: 0,
    riskClass: 'LOW',
    observedAt,
  };
  return buildCustomerRecoveryState({
    organizationId,
    observedAt,
    opportunities: [opportunity],
    capability: [
      capability('CARRIER'),
      capability('CUSTOMS'),
      capability('PLATFORM'),
      capability('INDEPENDENT_SITE'),
    ],
  });
};

const p2eRegistry = (): RecoveryToolRegistry =>
  createRecoveryToolRegistry([
    {
      name: 'recovery.carrier.package_preview.prepare',
      domain: 'CARRIER',
      access: 'PREPARE',
      description: 'fixture',
      invoke: async () => ({}),
    },
  ]);

const P2E_OBSERVED_AT = '2026-10-05T04:00:00.000Z';
const P2E_NOW_MS = Date.parse(P2E_OBSERVED_AT);

/** 真实可信 gate（唯一 permit 签发者） */
async function allowGateFor(tenant: TenantFixture): Promise<RecoveryPersistGateOutcome> {
  const built = p2eStateFor(tenant.organizationId, P2E_OBSERVED_AT, tenant.opportunityRef);
  if (!built.ok) throw new Error('fixture tenant mismatch');
  const registry = p2eRegistry();
  const plan = planRecovery({
    state: built.state,
    ranked: prioritizeOpportunities(built.state).ranked,
    registry,
    generatedAt: P2E_OBSERVED_AT,
  });
  const suppliedReadyActions = plan.actions.filter((action) => action.proposedAction === 'READY_FOR_EXECUTION');
  const outcome = await evaluateRecoveryPersistGate({
    organizationId: tenant.organizationId,
    actorUserId: tenant.userId,
    actorOrganizationId: tenant.organizationId,
    controlPlane: plane({}),
    canonical: { state: built.state, registry, suppliedReadyActions, nowMs: P2E_NOW_MS },
  });
  if (outcome.decision !== 'ALLOW') {
    throw new Error('fixture canonical gate not ALLOW: ' + outcome.code);
  }
  return outcome;
}

function payloads(
  tenant: TenantFixture,
  gate: RecoveryPersistGateOutcome,
  overrides: {
    /** canonical manifest 的区分标记；packageDigest = sha256(canonicalJson) 由其派生 */
    marker?: string;
    auditActorUserId?: string | null;
    artifactFileAssetId?: string;
    fileAssetId?: string;
    pdfFileAssetId?: string;
    packageId?: string;
    artifactId?: string;
    pdfArtifactId?: string;
    pdfArtifactKind?: 'PDF' | 'JSON_MANIFEST';
    pdfArtifactSha256?: string;
    claimItemId?: string;
    opportunityRef?: string;
    organizationId?: string;
  } = {},
): RecoveryPersistPrismaPayloads {
  // 默认取可信 gate 的租户（保持批内一致，便于构造「同租户但跨租户 ClaimItem」的负例）
  const organizationId = overrides.organizationId ?? gate.persistedBasis!.organizationId;
  const marker = overrides.marker ?? 'p2e-db-package:' + tenant.claimItemId;
  const claimItemId = overrides.claimItemId ?? tenant.claimItemId;
  const canonicalJson = JSON.stringify({
    packageVersion: RECOVERY_PACKAGE_VERSION,
    claimItemId,
    marker,
  });
  const digest = sha256Hex(canonicalJson);
  const pdfDigest = sha256Hex('p2e-db-pdf-bytes:' + tenant.claimItemId);
  const fileAssetId = overrides.fileAssetId ?? randomUUID();
  const pdfFileAssetId = overrides.pdfFileAssetId ?? randomUUID();
  const packageId = overrides.packageId ?? randomUUID();
  return {
    package: {
      id: packageId,
      organizationId,
      claimItemId,
      caseId: tenant.caseId,
      packageVersion: RECOVERY_PACKAGE_VERSION,
      digestVersion: RECOVERY_PACKAGE_DIGEST_VERSION,
      packageDigest: digest,
      opportunityRef: overrides.opportunityRef ?? gate.persistedBasis!.opportunityRef,
      canonicalJson,
      completenessSnapshot: ['evidence-1'],
      generatedByUserId: tenant.userId,
    },
    jsonFileAsset: {
      id: fileAssetId,
      organizationId,
      kind: 'OTHER',
      storageKey: 'p2e-db/' + fileAssetId + '.json',
      originalName: 'recovery-package.json',
      mimeType: 'application/json',
      sizeBytes: canonicalJson.length,
      sha256: digest,
      uploadedBy: tenant.userId,
    },
    pdfFileAsset: {
      id: pdfFileAssetId,
      organizationId,
      kind: 'PDF',
      storageKey: 'p2e-db/' + pdfFileAssetId + '.pdf',
      originalName: 'recovery-package.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      sha256: pdfDigest,
      uploadedBy: tenant.userId,
    },
    jsonArtifact: {
      id: overrides.artifactId ?? randomUUID(),
      organizationId,
      packageId,
      artifactKind: 'JSON_MANIFEST',
      fileAssetId: overrides.artifactFileAssetId ?? fileAssetId,
      sha256: digest,
      exportedByUserId: tenant.userId,
    },
    pdfArtifact: {
      id: overrides.pdfArtifactId ?? randomUUID(),
      organizationId,
      packageId,
      artifactKind: overrides.pdfArtifactKind ?? 'PDF',
      fileAssetId: pdfFileAssetId,
      sha256: overrides.pdfArtifactSha256 ?? pdfDigest,
      exportedByUserId: tenant.userId,
    },
    auditLog: {
      ...buildRecoverySiPackageLineageAuditLog({
        gate,
        actorUserId: overrides.auditActorUserId ?? tenant.userId,
        packageId,
        packageVersion: RECOVERY_PACKAGE_VERSION,
        packageDigest: digest,
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

const seedPlan = async () => {
  orgA = await seedTenant('a');
  orgB = await seedTenant('b');
};

/**
 * 生产推荐入口（CHANGE E4）：permit ↔ 批次绑定 + claimItem↔opportunity 绑定校验后，再进入单一事务。
 * 测试里统一走这条路径，避免「手工拼 gate/units 直接落库」。
 */
const persistBound = (input: {
  gate: RecoveryPersistGateOutcome;
  units: readonly RecoveryPersistUnitWrite[];
  port?: RecoveryPersistTransactionPort;
}) =>
  persistRecoverySiPackageWithinTransaction({
    prisma,
    gate: input.gate,
    units: input.units,
  });

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
  it('P2E-DB5 真实 gate=ALLOW → 六单元在同一事务落库（JSON+PDF），且零外部业务事实写入', async () => {
    const gate = await allowGateFor(orgA);
    const payload = payloads(orgA, gate);

    const result = await persistBound({
      gate,
      units: buildRecoveryPersistUnits(payload),
    });

    expect(result.persisted).toBe(true);
    expect(result.code).toBe('P2E_PERSISTED');
    expect(result.unitsWritten).toBe(6);
    expect(result.businessIdentity).toBe('packageDigest');
    expect(result.traceBasis).toBe('planDigest');

    const stored = await prisma.recoveryPackage.findUniqueOrThrow({ where: { id: payload.package.id } });
    expect(stored.organizationId).toBe(orgA.organizationId);
    expect(stored.packageDigest).toBe(payload.package.packageDigest);
    expect(stored.packageVersion).toBe(RECOVERY_PACKAGE_VERSION);
    expect(stored.digestVersion).toBe(RECOVERY_PACKAGE_DIGEST_VERSION);

    // E3：两份 FileAsset（JSON manifest + PDF）与两条 artifact（JSON_MANIFEST + PDF）
    expect(await prisma.fileAsset.count({ where: { organizationId: orgA.organizationId } })).toBe(2);
    expect(await prisma.fileAsset.count({ where: { id: payload.jsonFileAsset.id!, kind: 'OTHER' } })).toBe(1);
    expect(await prisma.fileAsset.count({ where: { id: payload.pdfFileAsset.id!, kind: 'PDF' } })).toBe(1);
    expect(await prisma.recoveryPackageArtifact.count({ where: { organizationId: orgA.organizationId } })).toBe(2);
    const artifactKinds = (
      await prisma.recoveryPackageArtifact.findMany({
        where: { organizationId: orgA.organizationId },
        select: { artifactKind: true, sha256: true },
      })
    )
      .map((row) => [String(row.artifactKind), row.sha256] as [string, string])
      .sort();
    expect(artifactKinds).toEqual([
      ['JSON_MANIFEST', payload.jsonArtifact.sha256],
      ['PDF', payload.pdfArtifact.sha256],
    ]);
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
    const gate = await allowGateFor(orgA);
    const failing = payloads(orgA, gate, { auditActorUserId: randomUUID() });

    await expect(
      persistBound({
        gate,
        units: buildRecoveryPersistUnits(failing),
      }),
    ).rejects.toBeTruthy();

    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.fileAsset.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.recoveryPackageArtifact.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
  });

  it('P2E-DB7 同键重放 → 单包 + 唯一收敛，且不产生孤儿单元', async () => {
    const gate = await allowGateFor(orgA);
    const first = payloads(orgA, gate, { marker: 'p2e-db-replay' });
    const second = payloads(orgA, gate, {
      marker: 'p2e-db-replay',
      packageId: randomUUID(),
      fileAssetId: randomUUID(),
      pdfFileAssetId: randomUUID(),
      artifactId: randomUUID(),
      pdfArtifactId: randomUUID(),
    });

    const r1 = await persistBound({
      gate,
      units: buildRecoveryPersistUnits(first),
    });
    const r2 = await persistBound({
      gate,
      units: buildRecoveryPersistUnits(second),
    });

    expect(r1.persisted).toBe(true);
    expect(r2.persisted).toBe(false);
    expect(r2.converged).toBe(true);
    expect(r2.code).toBe('P2E_PACKAGE_ALREADY_EXISTS');
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(1);
    expect(await prisma.fileAsset.count({ where: { organizationId: orgA.organizationId } })).toBe(2);
    expect(await prisma.recoveryPackageArtifact.count({ where: { organizationId: orgA.organizationId } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { organizationId: orgA.organizationId } })).toBe(1);
  });

  it('P2E-DB8 并发同键 → 唯一赢家（单包 + 无孤儿单元）', async () => {
    const gate = await allowGateFor(orgA);
    const marker = sha256Hex('p2e-db-concurrent');

    const attempt = async () =>
      persistBound({
        gate,
        units: buildRecoveryPersistUnits(payloads(orgA, gate, { marker })),
      });

    const settled = await Promise.allSettled([attempt(), attempt()]);
    const persisted = settled.filter(
      (r) => r.status === 'fulfilled' && r.value.persisted,
    ).length;
    expect(persisted).toBe(1);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(1);
    expect(await prisma.fileAsset.count({ where: { organizationId: orgA.organizationId } })).toBe(2);
    expect(await prisma.recoveryPackageArtifact.count({ where: { organizationId: orgA.organizationId } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { organizationId: orgA.organizationId } })).toBe(1);
  });

  it('P2E-DB9 gate 非 ALLOW → 端口零调用、DB 零写入', async () => {
    const gate = await gateFor(orgA, { globalDisabled: true });
    const unitsForDeniedAttempt = buildRecoveryPersistUnits(payloads(orgA, await allowGateFor(orgA)));
    let called = 0;
    // 生产入口在任何 DB 写入前先要求「trusted + ALLOW + persistedBasis」→ 非 ALLOW 直接 fail-closed
    // （软返回 `P2E_GATE_NOT_ALLOWED` 的低层路径由 unit 套件 P2E-G9 覆盖）
    await expect(
      persistBound({
        gate,
        units: unitsForDeniedAttempt,
        port: { async runInTransaction() { called += 1; } },
      }),
    ).rejects.toThrow(/P2E_LINEAGE_REQUIRES_TRUSTED_ALLOW_GATE/);
    expect(called).toBe(0);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
  });
});

describe('Recovery SI P2-E DB · 租户隔离（必修 2/3）', () => {
  it('P2E-DB10 跨租户混批 fail-closed（应用层）+ DB 层跨租户引用被租户触发器拒绝', async () => {
    const gateA = await allowGateFor(orgA);
    const gateB = await allowGateFor(orgB);

    // ① 应用层：同一批里出现两个 organizationId → fail-closed，且不触库
    const mixed = buildRecoveryPersistUnits(payloads(orgA, gateA, { marker: sha256Hex('p2e-db-tenant-mixed') })).map(
      (unit, index) =>
        index === 1
          ? { ...unit, payload: { ...(unit.payload as Record<string, unknown>), organizationId: orgB.organizationId } }
          : unit,
    );
    await expect(
      persistBound({ gate: gateA, units: mixed }),
    ).rejects.toThrow(/P2E_PERMIT_BATCH_TENANT_MISMATCH|P2E_TENANT_MIXED_BATCH/);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgB.organizationId } })).toBe(0);

    // ② 真实 DB：orgB 的 package 引用 orgA 的 ClaimItem → 租户触发器 cross-tenant reference blocked
    const crossTenantClaim = payloads(orgA, gateB, {
      marker: sha256Hex('p2e-db-tenant-cross'),
    });
    // 生产入口在事务前即发现「orgB 的 permit/payload 引用了 orgA 的 ClaimItem」→ fail-closed
    // （DB 层 tenant 触发器的拒绝路径由 ③ 独立覆盖）
    await expect(
      persistBound({
        gate: gateB,
        units: buildRecoveryPersistUnits(crossTenantClaim),
      }),
    ).rejects.toThrow(/P2E_PACKAGE_OPPORTUNITY_BINDING_MISMATCH|cross-tenant reference blocked/);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgB.organizationId } })).toBe(0);

    // ③ 真实落库后：orgB 的 artifact 不得引用 orgA 的 package（DB 触发器拒绝）
    const own = payloads(orgA, gateA, { marker: sha256Hex('p2e-db-tenant') });
    await persistBound({
      gate: gateA,
      units: buildRecoveryPersistUnits(own),
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
    const gateA = await allowGateFor(orgA);
    const own = payloads(orgA, gateA, { marker: sha256Hex('p2e-db-tenant-read') });
    await persistBound({
      gate: gateA,
      units: buildRecoveryPersistUnits(own),
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
    const gateA = await allowGateFor(orgA);
    const payload = payloads(orgA, gateA, { marker: sha256Hex('p2e-db-lineage') });
    await persistBound({
      gate: gateA,
      units: buildRecoveryPersistUnits(payload),
    });

    // CHANGE 2（MSG-20261005-23）：lineage 反查只认独立 action，不复用 recovery.package_generated
    const action = RECOVERY_SI_PACKAGE_PERSISTED_ACTION;
    const planDigest = await readRecoveryPackagePlanDigestFromAudit({
      prisma,
      organizationId: orgA.organizationId,
      packageId: payload.package.id!,
      action,
    });
    // E2：lineage 的 planDigest 来自可信 gate 的 canonicalPlanDigest
    expect(planDigest).toBe(gateA.persistedBasis!.canonicalPlanDigest);
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
    expect(projection!.planDigest).toBe(gateA.persistedBasis!.canonicalPlanDigest);
    expect(projection!.claimItemId).toBe(orgA.claimItemId);
    expect([...projection!.artifactIds].sort()).toEqual([payload.jsonArtifact.id!, payload.pdfArtifact.id!].sort());
    expect([...projection!.fileAssetIds].sort()).toEqual(
      [payload.jsonFileAsset.id!, payload.pdfFileAsset.id!].sort(),
    );
    expect(projection!.orphanFileAssetIds).toEqual([]);
    expect(projection!.auditLogIds).toEqual([payload.auditLog.id!]);
  });
});

describe('Recovery SI P2-E DB · DELETE guard 行为取证（必修 4，写入后仍拒绝删除）', () => {
  it('P2E-DB13 对已落库的 RecoveryPackage / artifact 直接 DELETE 必须被 DB 拒绝且行保留', async () => {
    const gateA = await allowGateFor(orgA);
    const payload = payloads(orgA, gateA, { marker: sha256Hex('p2e-db-delete-guard') });
    await persistBound({
      gate: gateA,
      units: buildRecoveryPersistUnits(payload),
    });

    // RecoveryPackage：删除由本批新增的 cc_no_delete__RecoveryPackage 拒绝
    await expect(prisma.recoveryPackage.delete({ where: { id: payload.package.id! } })).rejects.toThrow(
      /RECOVERY_PACKAGE_DELETE_FORBIDDEN/,
    );
    // RecoveryPackageArtifact：删除被 BEFORE UPDATE OR DELETE 的既有 append-only 守卫先拦下
    // （tgtype 27 与新增 tgtype 11 同级，按名称序 cc_append_only__ 先触发）；
    // 无论哪一条拒绝，结论都是「DB 层不可删除」——新增 guard 的存在性由 P2E-DB1 取证。
    await expect(prisma.recoveryPackageArtifact.delete({ where: { id: payload.jsonArtifact.id! } })).rejects.toThrow(
      /APPEND_ONLY_TABLE|RECOVERY_PACKAGE_ARTIFACT_DELETE_FORBIDDEN/,
    );

    expect(await prisma.recoveryPackage.count({ where: { id: payload.package.id! } })).toBe(1);
    expect(await prisma.recoveryPackageArtifact.count({ where: { id: payload.jsonArtifact.id! } })).toBe(1);
  });
});


describe('Recovery SI P2-E DB · FINAL-2 修订负例（F3E-01 / 02 / 04）', () => {
  it('P2E-DB14（F3E-01）手工伪造 ALLOW gate → 拒绝且 DB 零写入', async () => {
    const gateA = await allowGateFor(orgA);
    const forged = JSON.parse(JSON.stringify(gateA)) as RecoveryPersistGateOutcome;
    const payload = payloads(orgA, gateA);
    await expect(
      persistBound({
        gate: forged,
        units: buildRecoveryPersistUnits(payload),
      }),
    ).rejects.toThrow(/P2E_CALLER_SUPPLIED_GATE_FORBIDDEN/);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.fileAsset.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.recoveryPackageArtifact.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
  });

  it('P2E-DB15（F3E-02）lineage planDigest 与可信 gate 不一致 → fail-closed 且 DB 零写入', async () => {
    const gateA = await allowGateFor(orgA);
    expect(() =>
      buildRecoverySiPackageLineageAuditLog({
        gate: gateA,
        packageId: 'pkg-claimed-digest',
        packageVersion: RECOVERY_PACKAGE_VERSION,
        packageDigest: sha256Hex('p2e-db-claimed-package'),
        claimedPlanDigest: sha256Hex('p2e-db-other-plan'),
      }),
    ).toThrow(/P2E_LINEAGE_DIGEST_MISMATCH/);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.recoveryPackageArtifact.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
  });

  it('P2E-DB16（F3E-04）第二条 artifact 失败 → 整笔回滚（package/fileAsset/artifact/audit 全 0）', async () => {
    const gateA = await allowGateFor(orgA);
    const payload = payloads(orgA, gateA, { marker: sha256Hex('p2e-db-second-artifact') });
    const units = buildRecoveryPersistUnits(payload).map((unit) => {
      const body = unit.payload as Record<string, unknown>;
      if (unit.unit === 'RecoveryPackageArtifact' && body.artifactKind === 'PDF') {
        // 与 JSON_MANIFEST artifact 同 (organizationId, packageId, artifactKind, sha256) → 唯一约束命中
        return { ...unit, payload: { ...body, artifactKind: 'JSON_MANIFEST', sha256: payload.jsonArtifact.sha256 } };
      }
      return unit;
    });
    await expect(
      persistBound({
        gate: gateA,
        units,
      }),
    ).rejects.toBeTruthy();
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.fileAsset.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.recoveryPackageArtifact.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
  });
});


describe('Recovery SI P2-E DB · FINAL-4 修订负例（permit ↔ 批次不可变绑定）', () => {
  it('P2E-DB17（F4E-01）合法 permit + 整批属于别的 tenant → PERMIT_BATCH_TENANT_MISMATCH 且零写入', async () => {
    const gateA = await allowGateFor(orgA);
    const units = buildRecoveryPersistUnits(payloads(orgA, gateA, { marker: 'p2e-db-f4e-01' })).map((unit) => ({
      ...unit,
      payload: { ...(unit.payload as Record<string, unknown>), organizationId: orgB.organizationId },
    }));
    await expect(persistBound({ gate: gateA, units })).rejects.toThrow(/P2E_PERMIT_BATCH_TENANT_MISMATCH/);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgB.organizationId } })).toBe(0);
    expect(await prisma.fileAsset.count({ where: { organizationId: orgB.organizationId } })).toBe(0);
    expect(await prisma.recoveryPackageArtifact.count({ where: { organizationId: orgB.organizationId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: orgB.organizationId } })).toBe(0);
  });

  it('P2E-DB18（F4E-02）package.claimItem 不属于 permit 的 opportunity → PACKAGE_OPPORTUNITY_BINDING_MISMATCH 且零写入', async () => {
    const gateA = await allowGateFor(orgA);
    const otherClaim = await prisma.claimItem.create({
      data: {
        organizationId: orgA.organizationId,
        caseId: orgA.caseId,
        opportunityId: null,
        platformType: 'AMAZON',
        claimType: 'ORDER_DISCREPANCY',
        platformRef: 'P2E-DB-F4E02-' + randomUUID().slice(0, 8),
        sourceFingerprint: (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64),
        fingerprintVersion: 'v1',
        occurredAt: new Date('2026-09-02T00:00:00.000Z'),
        currency: 'USD',
        status: 'READY_TO_APPEAL',
        normalizerVersion: 'amazon-sp-normalizer/v1',
      },
    });
    const units = buildRecoveryPersistUnits(
      payloads(orgA, gateA, { marker: 'p2e-db-f4e-02', claimItemId: otherClaim.id }),
    );
    await expect(persistBound({ gate: gateA, units })).rejects.toThrow(
      /P2E_PACKAGE_OPPORTUNITY_BINDING_MISMATCH/,
    );
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.fileAsset.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.recoveryPackageArtifact.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
  });

  it('P2E-DB19（F4E-03）手工伪造 lineage AuditLog → LINEAGE_AUDIT_NOT_GATE_BOUND 且零写入', async () => {
    const gateA = await allowGateFor(orgA);
    const units = buildRecoveryPersistUnits(payloads(orgA, gateA, { marker: 'p2e-db-f4e-03' })).map((unit) =>
      unit.unit === 'AuditLog'
        ? {
            ...unit,
            payload: {
              ...(unit.payload as Record<string, unknown>),
              changes: {
                ...((unit.payload as { changes?: Record<string, unknown> }).changes ?? {}),
                planDigest: sha256Hex('forged-plan-digest'),
              },
            },
          }
        : unit,
    );
    await expect(persistBound({ gate: gateA, units })).rejects.toThrow(/P2E_LINEAGE_AUDIT_NOT_GATE_BOUND/);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.recoveryPackageArtifact.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
  });

  it('P2E-DB20（F4E-04）artifact 交叉接线（packageId/fileAssetId）→ 事务前 fail-closed 且零写入', async () => {
    const gateA = await allowGateFor(orgA);
    const base = payloads(orgA, gateA, { marker: 'p2e-db-f4e-04' });
    const units = buildRecoveryPersistUnits(base).map((unit) =>
      unit.unit === 'RecoveryPackageArtifact' &&
      (unit.payload as { artifactKind?: string }).artifactKind === 'JSON_MANIFEST'
        ? {
            ...unit,
            payload: {
              ...(unit.payload as Record<string, unknown>),
              fileAssetId: base.pdfFileAsset.id,
            },
          }
        : unit,
    );
    await expect(persistBound({ gate: gateA, units })).rejects.toThrow(/P2E_BATCH_IDENTITY_MISMATCH/);
    expect(await prisma.recoveryPackage.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.fileAsset.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.recoveryPackageArtifact.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { organizationId: orgA.organizationId } })).toBe(0);
  });
});
