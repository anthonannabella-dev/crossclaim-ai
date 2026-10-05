/**
 * Recovery SI P2-E v1 -- Prisma 单一事务端口 + lineage 落库反查（必修 2 / 必修 3 的 DB 侧）
 *
 * 授权：MSG-20261005-22（P2-E v1 设计 = PASS WITH REVISE；P2_E_V1_OPTION = A）。
 *
 * 职责边界（严格，不得扩张）：
 *   - 只有在 persistRecoveryPackageWithinTransaction 拿到 gate = ALLOW 之后才被调用；
 *   - RecoveryPackage / FileAsset / RecoveryPackageArtifact / AuditLog 四个单元必须在
 *     同一个 prisma.$transaction 内写入；任一步抛错 -> 由 Prisma 整体回滚，不留下
 *     孤儿 artifact / 孤立文件资产 / 半条审计；
 *   - manifest 与 digest 由既有纯函数产出后原样透传，本层不重算；
 *   - 不依赖 claim.submit 门禁结果（P2_E_GUARD_ACTION 由调用方以 claim.prepare 判定）；
 *   - 不消费审批、不调用 executor；不写 Claim submission / CustomsSubmissionAttempt /
 *     PlatformWriteAttempt / Payment / Settlement / RecoveryLedger / Billing；
 *   - 无 HTTP / 路由 / 运行时常驻接线（RUNTIME_WIRING = NONE），不做外部网络与凭据读取。
 */

import type { PrismaClient } from '@prisma/client';

import {
  RECOVERY_PACKAGE_DELETE_GUARD,
  RECOVERY_PERSIST_TRANSACTION_UNITS,
  persistRecoveryPackageWithinTransaction,
  buildRecoveryPackageLineageProjection,
  type RecoveryLineageProjection,
  type RecoveryPersistGateOutcome,
  type RecoveryPersistResult,
  type RecoveryPersistTransactionPort,
  type RecoveryPersistUnitWrite,
} from './recovery-persist-gate';

/** 与 schema 枚举一致的字面量联合（避免测试运行期依赖生成类型的具体形态）。 */
export type RecoveryPackageArtifactKindName = 'PDF' | 'JSON_MANIFEST';
export type FileKindName = 'PDF' | 'XLSX' | 'CSV' | 'DOCX' | 'IMAGE' | 'XML' | 'OTHER';
export type AuditActorTypeName = 'USER' | 'SYSTEM' | 'AI' | 'EXTERNAL';

export interface RecoveryPackageWritePayload {
  id?: string;
  organizationId: string;
  claimItemId: string;
  caseId?: string | null;
  packageVersion: string;
  digestVersion: string;
  packageDigest: string;
  completenessSnapshot?: unknown;
  generatedByUserId?: string | null;
  generatedAt?: Date;
}

export interface FileAssetWritePayload {
  id?: string;
  organizationId: string;
  kind: FileKindName;
  storageKey: string;
  originalName: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  sha256?: string | null;
  uploadedBy?: string | null;
  sourceRef?: string | null;
}

export interface RecoveryPackageArtifactWritePayload {
  id?: string;
  organizationId: string;
  packageId: string;
  artifactKind: RecoveryPackageArtifactKindName;
  fileAssetId: string;
  sha256: string;
  exportedByUserId?: string | null;
  exportedAt?: Date;
}

export interface AuditLogWritePayload {
  id?: string;
  organizationId: string;
  actorType: AuditActorTypeName;
  /** USER actor 必须指向真实 User（FK）；非 USER 用 actorRef 表达身份 */
  actorUserId?: string | null;
  actorRef?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  changes?: unknown;
}

export interface RecoveryPersistPrismaPayloads {
  package: RecoveryPackageWritePayload;
  fileAsset: FileAssetWritePayload;
  artifact: RecoveryPackageArtifactWritePayload;
  auditLog: AuditLogWritePayload;
}

/**
 * tenant 四点绑定的写入侧最小校验：四个单元必须落在同一个 organizationId。
 * 跨租户混批 -> fail-closed（不触库）。
 */
export function assertRecoveryPersistTenantCoherence(units: readonly RecoveryPersistUnitWrite[]): void {
  const orgs = new Set<string>();
  for (const unit of units) {
    const payload = unit.payload as { organizationId?: unknown };
    if (typeof payload?.organizationId !== 'string' || payload.organizationId === '') {
      throw new Error('P2E_UNIT_ORGANIZATION_REQUIRED: unit ' + unit.unit + ' 缺少 organizationId');
    }
    orgs.add(payload.organizationId);
  }
  if (orgs.size !== 1) {
    throw new Error(
      'P2E_TENANT_MIXED_BATCH: units must share one organizationId, got ' + [...orgs].sort().join(','),
    );
  }
}

/** 把四个单元 payload 组装成标准批（顺序固定，便于编排与取证）。 */
export function buildRecoveryPersistUnits(
  payloads: RecoveryPersistPrismaPayloads,
): RecoveryPersistUnitWrite[] {
  return [
    { unit: 'RecoveryPackage', payload: payloads.package },
    { unit: 'FileAsset', payload: payloads.fileAsset },
    { unit: 'RecoveryPackageArtifact', payload: payloads.artifact },
    { unit: 'AuditLog', payload: payloads.auditLog },
  ];
}

/**
 * 单一事务端口：把四个单元收进同一个 prisma.$transaction。
 * 写入顺序 = RecoveryPackage -> FileAsset -> RecoveryPackageArtifact -> AuditLog
 * （artifact 的外键同时指向 package 与 FileAsset，故排在两者之后）。
 */
export function createPrismaRecoveryPersistPort(prisma: PrismaClient): RecoveryPersistTransactionPort {
  return {
    async runInTransaction(units: readonly RecoveryPersistUnitWrite[]): Promise<void> {
      assertRecoveryPersistTenantCoherence(units);
      const byUnit = new Map(units.map((u) => [u.unit, u.payload] as const));
      const pkg = byUnit.get('RecoveryPackage') as RecoveryPackageWritePayload | undefined;
      const asset = byUnit.get('FileAsset') as FileAssetWritePayload | undefined;
      const artifact = byUnit.get('RecoveryPackageArtifact') as RecoveryPackageArtifactWritePayload | undefined;
      const auditLog = byUnit.get('AuditLog') as AuditLogWritePayload | undefined;
      if (!pkg || !asset || !artifact || !auditLog) {
        throw new Error('P2E_TRANSACTION_UNIT_SET_MISMATCH: 缺少四个批准单元之一');
      }

      await prisma.$transaction(async (tx) => {
        await tx.recoveryPackage.create({
          data: {
            ...(pkg.id ? { id: pkg.id } : {}),
            organizationId: pkg.organizationId,
            claimItemId: pkg.claimItemId,
            caseId: pkg.caseId ?? null,
            packageVersion: pkg.packageVersion,
            digestVersion: pkg.digestVersion,
            packageDigest: pkg.packageDigest,
            completenessSnapshot: (pkg.completenessSnapshot ?? null) as never,
            generatedByUserId: pkg.generatedByUserId ?? null,
            ...(pkg.generatedAt ? { generatedAt: pkg.generatedAt } : {}),
          },
        });

        await tx.fileAsset.create({
          data: {
            ...(asset.id ? { id: asset.id } : {}),
            organizationId: asset.organizationId,
            kind: asset.kind,
            storageKey: asset.storageKey,
            originalName: asset.originalName,
            mimeType: asset.mimeType ?? null,
            sizeBytes: asset.sizeBytes ?? null,
            sha256: asset.sha256 ?? null,
            uploadedBy: asset.uploadedBy ?? null,
            sourceRef: asset.sourceRef ?? null,
          },
        });

        await tx.recoveryPackageArtifact.create({
          data: {
            ...(artifact.id ? { id: artifact.id } : {}),
            organizationId: artifact.organizationId,
            packageId: artifact.packageId,
            artifactKind: artifact.artifactKind,
            fileAssetId: artifact.fileAssetId,
            sha256: artifact.sha256,
            exportedByUserId: artifact.exportedByUserId ?? null,
            ...(artifact.exportedAt ? { exportedAt: artifact.exportedAt } : {}),
          },
        });

        await tx.auditLog.create({
          data: {
            ...(auditLog.id ? { id: auditLog.id } : {}),
            organizationId: auditLog.organizationId,
            actorType: auditLog.actorType,
            actorUserId: auditLog.actorUserId ?? null,
            actorRef: auditLog.actorRef ?? null,
            action: auditLog.action,
            entityType: auditLog.entityType ?? null,
            entityId: auditLog.entityId ?? null,
            changes: (auditLog.changes ?? null) as never,
          },
        });
      });
    },
  };
}

const UNIQUE_VIOLATION = 'P2002';

/** 唯一约束命中（同 (organizationId, claimItemId, packageVersion, packageDigest) 第二次写入）。 */
export function isRecoveryPackageUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === UNIQUE_VIOLATION) return true;
  return String((error as { message?: unknown }).message ?? '').includes('Unique constraint');
}

export interface RecoveryPersistConvergenceResult extends RecoveryPersistResult {
  /** 重放已被既有包吸收（不产生第二条业务包，也不留下孤儿单元）。 */
  converged: boolean;
}

/**
 * 幂等重放入口：第一次 P2E_PERSISTED；同键第二次 -> P2E_PACKAGE_ALREADY_EXISTS（converged）。
 * 说明：唯一性由 DB 唯一约束承担（RecoveryPackage @@unique），失败方整笔事务回滚。
 */
export async function persistRecoveryPackageWithReplayConvergence(input: {
  gate: RecoveryPersistGateOutcome;
  units: readonly RecoveryPersistUnitWrite[];
  port: RecoveryPersistTransactionPort;
}): Promise<RecoveryPersistConvergenceResult> {
  try {
    const result = await persistRecoveryPackageWithinTransaction(input);
    return { ...result, converged: false };
  } catch (error) {
    if (isRecoveryPackageUniqueViolation(error)) {
      return {
        persisted: false,
        code: 'P2E_PACKAGE_ALREADY_EXISTS',
        unitsWritten: 0,
        traceBasis: 'planDigest',
        businessIdentity: 'packageDigest',
        converged: true,
      };
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * 必修 3 的 DB 侧：lineage 落库反查（只读）
 * ------------------------------------------------------------------ */

export interface RecoveryLineageReadInput {
  prisma: PrismaClient;
  organizationId: string;
  packageId: string;
  /** 追溯 basis；缺省时由审计事实反查（见 readRecoveryPackagePlanDigestFromAudit） */
  planDigest?: string | null;
}

/**
 * 反查投影：从真实 DB 读回 package / artifact / FileAsset / AuditLog，
 * 交给 buildRecoveryPackageLineageProjection 做身份与引用一致性整理。
 * 租户不匹配（或不存在）-> 返回 null（不泄露存在性）。
 */
export async function readRecoveryPackageLineage(
  input: RecoveryLineageReadInput,
): Promise<RecoveryLineageProjection | null> {
  const pkg = await input.prisma.recoveryPackage.findFirst({
    where: { id: input.packageId, organizationId: input.organizationId },
    select: {
      id: true,
      organizationId: true,
      claimItemId: true,
      packageVersion: true,
      packageDigest: true,
      status: true,
    },
  });
  if (!pkg) return null;

  const artifacts = await input.prisma.recoveryPackageArtifact.findMany({
    where: { organizationId: input.organizationId, packageId: pkg.id },
    select: { id: true, packageId: true, artifactKind: true, sha256: true, fileAssetId: true },
  });

  const assetIds = [...new Set(artifacts.map((a) => a.fileAssetId))];
  const fileAssets = assetIds.length
    ? await input.prisma.fileAsset.findMany({
        where: { organizationId: input.organizationId, id: { in: assetIds } },
        select: { id: true, organizationId: true, storageKey: true },
      })
    : [];

  const auditLogs = await input.prisma.auditLog.findMany({
    where: { organizationId: input.organizationId, entityId: pkg.id },
    select: { id: true, entityId: true, action: true },
  });

  return buildRecoveryPackageLineageProjection({
    package: {
      id: pkg.id,
      organizationId: pkg.organizationId,
      claimItemId: pkg.claimItemId,
      packageVersion: pkg.packageVersion,
      packageDigest: pkg.packageDigest,
      status: String(pkg.status),
    },
    artifacts: artifacts.map((a) => ({
      id: a.id,
      packageId: a.packageId,
      artifactKind: String(a.artifactKind),
      sha256: a.sha256,
      fileAssetId: a.fileAssetId,
    })),
    fileAssets: fileAssets.map((f) => ({
      id: f.id,
      organizationId: f.organizationId,
      storageKey: f.storageKey,
    })),
    auditLogs: auditLogs.map((l) => ({ id: l.id, entityId: l.entityId, action: l.action })),
    planDigest: input.planDigest ?? null,
  });
}

/**
 * 追溯 basis 反查：从落库审计事实里取回 planDigest（必修 3：planDigest 只作 trace basis，
 * 业务身份仍是 packageDigest）。找不到 -> null，绝不臆造。
 */
export async function readRecoveryPackagePlanDigestFromAudit(input: {
  prisma: PrismaClient;
  organizationId: string;
  packageId: string;
  action: string;
}): Promise<string | null> {
  const rows = await input.prisma.auditLog.findMany({
    where: { organizationId: input.organizationId, entityId: input.packageId, action: input.action },
    select: { changes: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const row of rows) {
    const value = (row.changes as { planDigest?: unknown } | null)?.planDigest;
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** 供实现审计核对：端口覆盖的单元集合必须与批准集合一致。 */
export const RECOVERY_PERSIST_PRISMA_PORT_UNITS: readonly string[] = RECOVERY_PERSIST_TRANSACTION_UNITS;
/** DELETE guard 由 DB 触发器承担；此处仅暴露只读常量，禁止应用层删除。 */
export const RECOVERY_PERSIST_DELETE_GUARD = RECOVERY_PACKAGE_DELETE_GUARD;
