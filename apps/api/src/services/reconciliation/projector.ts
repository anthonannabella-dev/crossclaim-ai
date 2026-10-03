/**
 * R45 S3 —— deterministic projector（IO 层：锁内固定输入 → 重建 → 整体替换 membership）
 * ---------------------------------------------------------------------------
 * 依据：MSG-20261002-48（批准进入 R45 S3；事务顺序与永久验收已冻结）。
 *
 * 冻结事务顺序（任何一步失败 → 整个事务 rollback，旧 header + 旧 membership 完整恢复）：
 *   lock projection / claim scope
 *   → 固定输入集合（effective facts / effective basis / effective policy / 合法 override）
 *   → 强校验 basis / policy 引用
 *   → deterministic rebuild（纯函数）
 *   → 计算 inputDigest
 *   → DELETE old membership
 *   → CAS header 到新 generation/version/inputDigest
 *   → INSERT new membership
 *   → audit
 *   → commit
 *
 * 边界：projector **不写任何 immutable Fact**；旧 Projection 只用于 CAS/version coordination，
 *   **绝不**作为业务计算输入。NO Settlement · NO Billing · NO Fee · NO RecoveryLedger mutation · NO platform write。
 */

import { Prisma, type PrismaClient } from '@prisma/client';

import { prepareAuditInsert } from '../audit';
import { canonicalProvider } from './fingerprint';
import {
  PROJECTION_ALGORITHM_VERSION,
  computeProjection,
  type ProjectionComputation,
  type ProjectionFactInput,
  type ProjectionOverrideInput,
  type ProjectionPolicyInput,
  type ProjectionStatus,
} from './projection-compute';

export const RECONCILIATION_PROJECTION_REBUILT_ACTION = 'reconciliation.projection_rebuilt';
/** 显式系统 exact policy（CHANGE C）——缺失时必须受控、幂等创建，不得代码隐式 fallback */
export const SYSTEM_EXACT_POLICY_ID = 'cc0f0000-0000-4000-8000-000000000001';
export const RECONCILIATION_POLICY_OPERATION = 'RECONCILIATION';

export class ReconciliationProjectorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(code + ': ' + message);
    this.name = 'ReconciliationProjectorError';
    this.code = code;
  }
}

export interface ProjectionRebuildInput {
  organizationId: string;
  claimItemId: string;
  /** 触发原因（写入 projection rebuild audit） */
  reason: string;
  actorUserId?: string | null;
}

export interface ProjectionRebuildResult {
  projectionId: string;
  status: ProjectionStatus;
  projectionVersion: number;
  previousProjectionVersion: number | null;
  previousInputDigest: string | null;
  inputDigest: string;
  memberCount: number;
  netMatchedObservedAmount: string;
  basisId: string | null;
  tolerancePolicyId: string;
  policyVersion: string;
  created: boolean;
}

export interface ProjectorDeps {
  now?: () => Date;
  /** 故障注入缝隙（仅用于永久验收：验证 DELETE/CAS/INSERT 中途失败必须完整回滚） */
  hooks?: {
    afterDeleteBeforeCas?: () => void | Promise<void>;
    afterCasBeforeInsert?: () => void | Promise<void>;
  };
}

interface ClaimRow {
  id: string;
  platformType: string;
  currency: string;
}

interface BasisRow {
  id: string;
  amount: string;
  currency: string;
  basisVersion: string;
  claimItemId: string;
}

interface PolicyRow {
  id: string;
  policyVersion: string;
  absoluteTolerance: string;
  relativeTolerance: string;
}

interface FactRow {
  id: string;
  amount: string;
  currency: string;
  providerEventId: string | null;
  providerCaseRefCanonical: string | null;
  occurredAt: Date;
}

interface OverrideRow {
  reimbursementFactId: string;
  decisionKind: 'MATCHED' | 'UNMATCHED';
}

interface ProjectionRow {
  id: string;
  projectionVersion: number;
  inputDigest: string;
  basisId: string | null;
  tolerancePolicyId: string;
}

interface BasisRefRow {
  id: string;
  organizationId: string;
  claimItemId: string;
  supersededAt: Date | null;
}

interface PolicyRefRow {
  id: string;
  organizationId: string | null;
  provider: string | null;
  operation: string | null;
  supersededAt: Date | null;
}

type TxClient = Prisma.TransactionClient;

function requireNonEmpty(value: string | null | undefined, code: string, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) throw new ReconciliationProjectorError(code, label + ' 必填');
  return text;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

/**
 * CHANGE C：显式系统 exact policy 的确定性取用 / 幂等创建。
 * 先查询唯一 system exact policy → 缺失时受控创建 → 并发创建由 unique scope 收敛。
 */
async function ensureSystemExactPolicy(tx: TxClient, now: Date): Promise<PolicyRow> {
  const query = () =>
    tx.$queryRaw<PolicyRow[]>`
      SELECT "id", "policyVersion", "absoluteTolerance"::text AS "absoluteTolerance", "relativeTolerance"::text AS "relativeTolerance"
        FROM "ReconciliationTolerancePolicy"
       WHERE "organizationId" IS NULL AND "provider" IS NULL AND "operation" IS NULL AND "supersededAt" IS NULL
       ORDER BY "policyVersion" ASC`;

  const found = await query();
  if (found.length > 1) {
    throw new ReconciliationProjectorError('POLICY_NOT_UNIQUE', 'system exact policy 存在多条 effective 记录');
  }
  if (found.length === 1) return found[0];

  try {
    await tx.$executeRaw`
      INSERT INTO "ReconciliationTolerancePolicy"
        ("id", "organizationId", "provider", "operation", "policyVersion",
         "absoluteTolerance", "relativeTolerance", "effectiveAt", "createdByUserId")
      VALUES (${SYSTEM_EXACT_POLICY_ID}, NULL, NULL, NULL, 'v1', 0, 0, ${now}, 'SYSTEM_EXACT_POLICY_ENSURED')`;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error; // 并发创建 → 由 unique scope 收敛
  }

  const after = await query();
  if (after.length !== 1) {
    throw new ReconciliationProjectorError('SYSTEM_POLICY_UNAVAILABLE', 'system exact policy 不可用');
  }
  return after[0];
}

/** 有效容差策略：provider-specific（scope 内唯一）优先，否则显式系统 exact policy。 */
async function resolveEffectivePolicy(
  tx: TxClient,
  input: { organizationId: string; provider: string; now: Date },
): Promise<PolicyRow> {
  const scoped = await tx.$queryRaw<PolicyRow[]>`
    SELECT "id", "policyVersion", "absoluteTolerance"::text AS "absoluteTolerance", "relativeTolerance"::text AS "relativeTolerance"
      FROM "ReconciliationTolerancePolicy"
     WHERE "organizationId" = ${input.organizationId}
       AND "provider" = ${input.provider}
       AND "operation" = ${RECONCILIATION_POLICY_OPERATION}
       AND "supersededAt" IS NULL
     ORDER BY "policyVersion" ASC`;
  if (scoped.length > 1) {
    throw new ReconciliationProjectorError('POLICY_NOT_UNIQUE', '同一 scope 存在多条 effective policy');
  }
  if (scoped.length === 1) return scoped[0];
  return ensureSystemExactPolicy(tx, input.now);
}

/**
 * MSG-20261002-49 CHANGE A：**引用损坏必须 fail-closed**，不得降级成「业务上还没建立 basis」。
 * 校验：(1) 既有 Projection 的弱引用（basisId / tolerancePolicyId）存在且归属正确；
 *       (2) 本 claim 的 basis supersede 链没有非法漂移（指向不存在或跨 claim 的后继）。
 */
async function assertWeakReferencesIntact(
  tx: TxClient,
  input: { organizationId: string; claimItemId: string; previous: ProjectionRow | null },
): Promise<void> {
  const { organizationId, claimItemId, previous } = input;

  if (previous?.basisId) {
    const rows = await tx.$queryRaw<BasisRefRow[]>`
      SELECT "id", "organizationId", "claimItemId", "supersededAt"
        FROM "ExpectedRecoveryBasis" WHERE "id" = ${previous.basisId}`;
    const row = rows[0];
    if (!row || row.organizationId !== organizationId || row.claimItemId !== claimItemId) {
      throw new ReconciliationProjectorError(
        'PROJECTION_BASIS_REFERENCE_INVALID',
        '既有 Projection 引用的 basis 不存在 / 跨租户 / 跨 claim（引用损坏必须 fail-closed）',
      );
    }
  }

  if (previous?.tolerancePolicyId) {
    const rows = await tx.$queryRaw<PolicyRefRow[]>`
      SELECT "id", "organizationId", "provider", "operation", "supersededAt"
        FROM "ReconciliationTolerancePolicy" WHERE "id" = ${previous.tolerancePolicyId}`;
    const row = rows[0];
    const tenantOk = row != null && (row.organizationId === organizationId || row.organizationId === null);
    if (!row || !tenantOk) {
      throw new ReconciliationProjectorError(
        'PROJECTION_POLICY_REFERENCE_INVALID',
        '既有 Projection 引用的 tolerance policy 不存在或跨租户（引用损坏必须 fail-closed）',
      );
    }
  }

  // basis supersede 链漂移检测：本 claim 的历史 basis 若被判为 superseded，其 successor 必须存在且属于同一 claim
  const chain = await tx.$queryRaw<{ id: string; successorId: string | null; successorOk: boolean }[]>`
    SELECT b."id",
           b."supersededByBasisId" AS "successorId",
           COALESCE(s."organizationId" = b."organizationId" AND s."claimItemId" = b."claimItemId", false) AS "successorOk"
      FROM "ExpectedRecoveryBasis" b
      LEFT JOIN "ExpectedRecoveryBasis" s ON s."id" = b."supersededByBasisId"
     WHERE b."organizationId" = ${organizationId} AND b."claimItemId" = ${claimItemId}
       AND b."supersededAt" IS NOT NULL`;
  const broken = chain.filter((row) => !row.successorId || !row.successorOk);
  if (broken.length > 0) {
    throw new ReconciliationProjectorError(
      'BASIS_SUPERSEDE_CHAIN_INVALID',
      'basis supersede 链非法漂移（后继缺失或跨 claim/租户）：' + broken.map((row) => row.id).join(','),
    );
  }
}

/**
 * 重建某个 ClaimItem 的对账投影（幂等 + 确定性；同事务整体替换 membership）。
 */
export async function rebuildClaimReconciliationProjection(
  prisma: PrismaClient,
  input: ProjectionRebuildInput,
  deps: ProjectorDeps = {},
): Promise<ProjectionRebuildResult> {
  const organizationId = requireNonEmpty(input.organizationId, 'ORGANIZATION_REQUIRED', 'organizationId');
  const claimItemId = requireNonEmpty(input.claimItemId, 'CLAIM_ITEM_REQUIRED', 'claimItemId');
  const reason = requireNonEmpty(input.reason, 'REASON_REQUIRED', 'reason');
  const now = deps.now ? deps.now() : new Date();

  return prisma.$transaction(async (tx) => {
    // 1) 锁定 claim scope（并发 rebuild 串行化）
    const claims = await tx.$queryRaw<ClaimRow[]>`
      SELECT "id", "platformType", "currency"
        FROM "ClaimItem"
       WHERE "id" = ${claimItemId} AND "organizationId" = ${organizationId}
       FOR UPDATE`;
    if (claims.length !== 1) {
      throw new ReconciliationProjectorError('CLAIM_ITEM_NOT_FOUND', 'ClaimItem 不存在或不属于该租户');
    }
    const claim = claims[0];

    // 2) 固定输入集合：effective basis / effective policy / effective facts / 合法 override
    const basisRows = await tx.$queryRaw<BasisRow[]>`
      SELECT "id", "expectedRecoveryAmount"::text AS "amount", "currency", "basisVersion", "claimItemId"
        FROM "ExpectedRecoveryBasis"
       WHERE "organizationId" = ${organizationId}
         AND "claimItemId" = ${claimItemId}
         AND "supersededAt" IS NULL`;
    if (basisRows.length > 1) {
      throw new ReconciliationProjectorError('BASIS_NOT_UNIQUE', '同一 claimItem 存在多条 effective basis');
    }
    // 3) 强校验 basis 弱引用（CHANGE A）：必须同租户 + 同 claimItem + effective
    const basisRow = basisRows[0] ?? null;
    if (basisRow && basisRow.claimItemId !== claimItemId) {
      throw new ReconciliationProjectorError('BASIS_BINDING_MISMATCH', 'basis 与 claimItem 绑定不一致');
    }

    const policyRow = await resolveEffectivePolicy(tx, {
      organizationId,
      provider: canonicalProvider(claim.platformType),
      now,
    });

    const factRows = await tx.$queryRaw<FactRow[]>`
      SELECT f."id", f."amount"::text AS "amount", f."currency", f."providerEventId",
             f."providerCaseRefCanonical", f."occurredAt"
        FROM "ReimbursementFact" f
       WHERE f."organizationId" = ${organizationId}
         AND f."claimItemId" = ${claimItemId}
         AND f."kind" = 'OBSERVED'
         AND NOT EXISTS (
           SELECT 1 FROM "ReimbursementFact" r
            WHERE r."organizationId" = ${organizationId} AND r."reversesFactId" = f."id")
       ORDER BY f."id" ASC`;

    const overrideRows = await tx.$queryRaw<OverrideRow[]>`
      SELECT "reimbursementFactId", "decisionKind"
        FROM "ReconciliationOverrideDecision"
       WHERE "organizationId" = ${organizationId} AND "claimItemId" = ${claimItemId}
       ORDER BY "reimbursementFactId" ASC`;

    const facts: ProjectionFactInput[] = factRows.map((row) => ({
      id: row.id,
      amount: row.amount,
      currency: row.currency,
      providerEventId: row.providerEventId,
      providerCaseRefCanonical: row.providerCaseRefCanonical,
      occurredAt: row.occurredAt.toISOString(),
    }));
    const policy: ProjectionPolicyInput = {
      id: policyRow.id,
      policyVersion: policyRow.policyVersion,
      absoluteTolerance: policyRow.absoluteTolerance,
      relativeTolerance: policyRow.relativeTolerance,
    };
    const overrides: ProjectionOverrideInput[] = overrideRows.map((row) => ({
      reimbursementFactId: row.reimbursementFactId,
      decisionKind: row.decisionKind,
    }));

    // 4–5) deterministic rebuild + inputDigest（纯函数，禁旧 Projection 参与）
    const computation: ProjectionComputation = computeProjection({
      claimItemId,
      facts,
      basis: basisRow
        ? {
            id: basisRow.id,
            expectedRecoveryAmount: basisRow.amount,
            currency: basisRow.currency,
            basisVersion: basisRow.basisVersion,
          }
        : null,
      policy,
      overrides,
    });

    // 锁定 projection header（若存在）
    const existing = await tx.$queryRaw<ProjectionRow[]>`
      SELECT "id", "projectionVersion", "inputDigest", "basisId", "tolerancePolicyId"
        FROM "ClaimReconciliationProjection"
       WHERE "organizationId" = ${organizationId} AND "claimItemId" = ${claimItemId}
       FOR UPDATE`;
    if (existing.length > 1) {
      throw new ReconciliationProjectorError('PROJECTION_NOT_UNIQUE', '同一 claimItem 存在多条 projection');
    }
    const previous = existing[0] ?? null;
    const nextVersion = previous ? previous.projectionVersion + 1 : 1;

    // CHANGE A：引用完整性在任何写入之前判定（损坏 → fail-closed，绝不静默降级）
    await assertWeakReferencesIntact(tx, { organizationId, claimItemId, previous });

    let projectionId: string;
    if (previous) {
      // 6) DELETE old membership（必须先于版本提升：DB 立即触发器约束）
      await tx.$executeRaw`
        DELETE FROM "ClaimReconciliationProjectionFact"
         WHERE "organizationId" = ${organizationId} AND "projectionId" = ${previous.id}`;

      if (deps.hooks?.afterDeleteBeforeCas) await deps.hooks.afterDeleteBeforeCas();

      // 7) CAS header（同事务；旧版本必须与锁内读到的一致）
      const affected = await tx.$executeRaw`
        UPDATE "ClaimReconciliationProjection"
           SET "status" = ${computation.status}::"ReconciliationProjectionStatus",
               "basisId" = ${computation.basisId},
               "expectedAmount" = ${computation.expectedAmount}::numeric,
               "currency" = ${computation.currency},
               "netMatchedObservedAmount" = ${computation.netMatchedObservedAmount}::numeric,
               "matchedFactIds" = ${computation.matchedFactIds}::text[],
               "tolerancePolicyId" = ${computation.tolerancePolicyId},
               "policyVersion" = ${computation.policyVersion},
               "inputDigest" = ${computation.inputDigest},
               "projectionVersion" = ${nextVersion},
               "computedAt" = ${now},
               "updatedAt" = ${now}
         WHERE "id" = ${previous.id} AND "projectionVersion" = ${previous.projectionVersion}`;
      if (affected !== 1) {
        throw new ReconciliationProjectorError('CAS_CONFLICT', 'projection 版本 CAS 失败（不应发生：已在锁内）');
      }
      projectionId = previous.id;
    } else {
      if (deps.hooks?.afterDeleteBeforeCas) await deps.hooks.afterDeleteBeforeCas();
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "ClaimReconciliationProjection"
          ("id", "organizationId", "claimItemId", "status", "basisId", "expectedAmount", "currency",
           "netMatchedObservedAmount", "matchedFactIds", "tolerancePolicyId", "policyVersion",
           "inputDigest", "projectionVersion", "computedAt", "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, ${organizationId}, ${claimItemId},
                ${computation.status}::"ReconciliationProjectionStatus", ${computation.basisId},
                ${computation.expectedAmount}::numeric, ${computation.currency},
                ${computation.netMatchedObservedAmount}::numeric, ${computation.matchedFactIds}::text[],
                ${computation.tolerancePolicyId}, ${computation.policyVersion},
                ${computation.inputDigest}, 1, ${now}, ${now}, ${now})
        RETURNING "id"`;
      projectionId = inserted[0].id;
    }

    if (deps.hooks?.afterCasBeforeInsert) await deps.hooks.afterCasBeforeInsert();

    // 8) INSERT new membership（绑定当前 generation）
    if (computation.memberFactIds.length > 0) {
      await tx.claimReconciliationProjectionFact.createMany({
        data: computation.memberFactIds.map((reimbursementFactId) => ({
          organizationId,
          projectionId,
          projectionVersion: nextVersion,
          reimbursementFactId,
        })),
      });
    }

    // 9) audit（projection rebuild audit：previous/new digest + version + reason + actor + rebuiltAt）
    const isUserActor = Boolean(input.actorUserId);
    const auditRow = prepareAuditInsert(
      {
        organizationId,
        actorType: isUserActor ? 'USER' : 'SYSTEM',
        actorUserId: isUserActor ? (input.actorUserId as string) : undefined,
        // 非 USER actor 必须提供 actorRef（审计契约）
        actorRef: isUserActor ? undefined : 'reconciliation-projector',
        action: RECONCILIATION_PROJECTION_REBUILT_ACTION,
        entityType: 'ClaimReconciliationProjection',
        entityId: projectionId,
        changes: {
          claimItemId,
          algorithmVersion: PROJECTION_ALGORITHM_VERSION,
          previousInputDigest: previous?.inputDigest ?? null,
          newInputDigest: computation.inputDigest,
          previousProjectionVersion: previous?.projectionVersion ?? null,
          projectionVersion: nextVersion,
          status: computation.status,
          ambiguityReasons: computation.ambiguityReasons,
          reason,
          actor: input.actorUserId ?? 'SYSTEM',
          rebuiltAt: now.toISOString(),
        },
      },
      { maxStringLength: 512, now: () => now },
    );
    await tx.auditLog.create({
      data: {
        organizationId: auditRow.organizationId,
        actorType: auditRow.actorType,
        actorUserId: auditRow.actorUserId ?? undefined,
        actorRef: auditRow.actorRef,
        action: auditRow.action,
        entityType: auditRow.entityType,
        entityId: auditRow.entityId,
        changes: (auditRow.changes ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: auditRow.ip ?? undefined,
        userAgent: auditRow.userAgent ?? undefined,
        createdAt: now,
      },
      select: { id: true },
    });

    return {
      projectionId,
      status: computation.status,
      projectionVersion: nextVersion,
      previousProjectionVersion: previous?.projectionVersion ?? null,
      previousInputDigest: previous?.inputDigest ?? null,
      inputDigest: computation.inputDigest,
      memberCount: computation.memberFactIds.length,
      netMatchedObservedAmount: computation.netMatchedObservedAmount,
      basisId: computation.basisId,
      tolerancePolicyId: computation.tolerancePolicyId,
      policyVersion: computation.policyVersion,
      created: previous === null,
    };
  }, { timeout: 20000 });
}
