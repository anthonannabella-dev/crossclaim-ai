/**
 * Recovery SI P2-E v1 —— 持久化入口门禁（纯判定，不落库）
 * ---------------------------------------------------------------
 * 授权：MSG-20261005-22（P2-E v1 设计 = PASS WITH REVISE；`P2_E_V1_OPTION = A`）。
 *
 * 必修 1（裁决原文）：不得以「P2-D claim.submit = ALLOW」作为 P2-E 写入前提。
 * 正确入口：
 *   fresh state → canonical READY alignment → verified P2-C preview/facts
 *     → trusted ProductionControlPlane → evaluate claim.prepare → ALLOW
 *     → persistence transaction
 * 即 `P2_E_GUARD_ACTION = claim.prepare`。
 *
 * 本模块只做判定：不写库、不建事务、不消费审批、不调 executor；真正的写入必须由调用方
 * 在 ALLOW 之后放进**单一事务**（必修 2），并依赖 DB 层 DELETE guard（必修 4）。
 */

import type { ProductionControlPlane } from '../action-guard/control-plane';
import type { ActionGuardResult } from '../action-guard/action-guard';

/** 必修 1：P2-E 唯一的 Guard action；出现 claim.submit 即视为配置错误。 */
export const P2_E_GUARD_ACTION = 'claim.prepare' as const;

/** 明确禁止：P2-D 的 external submission 门禁不得被当作持久化前提。 */
export const P2_E_FORBIDDEN_GUARD_ACTIONS: readonly string[] = ['claim.submit', 'platform.write', 'appeal.submit'];

export const P2_E_PERSIST_GATE_BOUNDARY = {
  guardAction: P2_E_GUARD_ACTION,
  requiresP2dAllow: false,
  transactionRequired: true,
  dbDeleteGuardRequired: true,
  approvalConsumption: 'FORBIDDEN',
  executorInvocation: 'FORBIDDEN',
  businessFactWrite: 'DRY_RUN_ONLY',
  externalAction: 'FORBIDDEN',
  runtimeWiring: 'NONE',
} as const;

export type RecoveryPersistGateDecision = 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL';

export interface RecoveryPersistGateOutcome {
  decision: RecoveryPersistGateDecision;
  code: string;
  reasons: readonly string[];
  guardAction: string | null;
  guardEvaluated: boolean;
  /** 恒为 false：门禁通过 ≠ 已持久化。 */
  persisted: false;
  /** 恒为 true：ALLOW 之后必须走单一事务（必修 2）。 */
  transactionRequired: true;
  /** 恒为 true：DB 层 DELETE guard 必须先就位（必修 4）。 */
  dbDeleteGuardRequired: true;
  approvalConsumed: false;
  executorInvoked: false;
}

const decideFromGuard = (result: ActionGuardResult): RecoveryPersistGateDecision => {
  const decision = String(result.decision);
  if (decision === 'ALLOW') return 'ALLOW';
  if (decision === 'REQUIRES_APPROVAL' || decision === 'REQUIRE_APPROVAL') return 'REQUIRES_APPROVAL';
  return 'DENY';
};

/**
 * 纯判定：给定租户与 actor，通过可信 ProductionControlPlane 评估 `claim.prepare`。
 * 不接收 capabilities（必须来自 Control Plane），不接收 approvalId（P2-E 不消费审批）。
 */
export async function evaluateRecoveryPersistGate(input: {
  organizationId: string;
  actorUserId: string;
  actorOrganizationId: string;
  controlPlane: Pick<ProductionControlPlane, 'snapshotFor' | 'evaluateWithoutAudit'>;
}): Promise<RecoveryPersistGateOutcome> {
  const base = {
    guardAction: P2_E_GUARD_ACTION as string | null,
    persisted: false as const,
    transactionRequired: true as const,
    dbDeleteGuardRequired: true as const,
    approvalConsumed: false as const,
    executorInvoked: false as const,
  };

  if (input.actorOrganizationId !== input.organizationId) {
    return {
      ...base,
      decision: 'DENY',
      code: 'P2E_ACTOR_TENANT_MISMATCH',
      reasons: ['actor 与目标租户不一致 → fail-closed，且不调用 Action Guard'],
      guardEvaluated: false,
    };
  }
  if ((P2_E_FORBIDDEN_GUARD_ACTIONS as readonly string[]).includes(P2_E_GUARD_ACTION)) {
    return {
      ...base,
      decision: 'DENY',
      code: 'P2E_GUARD_ACTION_FORBIDDEN',
      reasons: ['静态配置引用了被禁止的 external submission action → fail-closed'],
      guardEvaluated: false,
    };
  }

  const snapshot = await input.controlPlane.snapshotFor(input.organizationId);
  if (snapshot.degraded) {
    return {
      ...base,
      decision: 'DENY',
      code: 'P2E_CONTROL_PLANE_DEGRADED',
      reasons: ['Control Plane 配置源降级/缺失 → fail-closed（不调用 Action Guard）'],
      guardEvaluated: false,
    };
  }

  const result = await input.controlPlane.evaluateWithoutAudit(
    {
      action: P2_E_GUARD_ACTION,
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      requestedBy: input.actorUserId,
    },
    snapshot.config,
  );

  return {
    ...base,
    decision: decideFromGuard(result),
    code: result.code,
    reasons: result.reasons,
    guardEvaluated: true,
  };
}


/**
 * 必修 2：这些写入单元必须落在**同一个事务**里（任一失败 → 全部回滚，禁止孤儿 artifact / 文件资产 / 半条审计）。
 */
export const RECOVERY_PERSIST_TRANSACTION_UNITS: readonly string[] = [
  'RecoveryPackage',
  'RecoveryPackageArtifact',
  'FileAsset',
  'AuditLog',
];
export const RECOVERY_PERSIST_TRANSACTION_FAILURE_POLICY = 'ROLLBACK_ALL' as const;

/**
 * 必修 3：lineage —— planDigest 只作为**追溯 / verification basis**；
 * 业务包身份仍是 packageDigest（与既有 UNIQUE (organizationId, claimItemId, packageVersion, packageDigest) 一致）。
 */
export const RECOVERY_PERSIST_LINEAGE = {
  businessIdentity: 'packageDigest',
  traceBasis: 'planDigest',
  planDigestReplacesPackageDigest: false,
  reverseLookupKeys: ['organizationId', 'claimItemId', 'packageVersion', 'packageDigest'],
  evidenceRefs: ['RecoveryPlan', 'DecisionEvidence'],
} as const;

/**
 * 必修 4：DB 层 DELETE guard —— 应用层不得删除 RecoveryPackage；
 * 真正的拒绝必须由数据库触发器实现（迁移清单同步），本常量只声明要求。
 */
export const RECOVERY_PACKAGE_DELETE_GUARD = {
  applicationDeleteAllowed: false,
  dbTriggerRequired: true,
  migrationStatus: 'PENDING',
  triggerManifestSyncRequired: true,
} as const;



/* ------------------------------------------------------------------ *
 * 必修 2 接线：单一事务端口（P2-E2）
 * ------------------------------------------------------------------ */

export interface RecoveryPersistUnitWrite {
  /** 必须是 RECOVERY_PERSIST_TRANSACTION_UNITS 之一 */
  unit: string;
  /** 既有 pure functions 产出的 manifest / digest 原样透传，本层不重算 */
  payload: unknown;
}

export interface RecoveryPersistTransactionPort {
  /** 必须在**同一个数据库事务**内写入全部单元；任一失败 → 整体回滚。 */
  runInTransaction(units: readonly RecoveryPersistUnitWrite[]): Promise<void>;
}

export interface RecoveryPersistResult {
  persisted: boolean;
  code: string;
  unitsWritten: number;
  /** planDigest 仅追溯 basis（必修 3） */
  traceBasis: 'planDigest';
  businessIdentity: 'packageDigest';
}

/** 单元集合必须与批准的四个单元完全一致（顺序不限，重复不允许）。 */
export function assertApprovedTransactionUnits(units: readonly RecoveryPersistUnitWrite[]): void {
  const got = [...units.map((u) => u.unit)].sort();
  const want = [...RECOVERY_PERSIST_TRANSACTION_UNITS].sort();
  if (got.length !== want.length || got.some((u, i) => u !== want[i])) {
    throw new Error('P2E_TRANSACTION_UNIT_SET_MISMATCH: units must be exactly ' + want.join(', '));
  }
}

/**
 * P2-E2 编排：门禁 ALLOW 才允许进入持久化，且必须整批交给单一事务端口。
 * 本函数不读库、不建事务本身；它只强制「先门禁、后单事务、整批或全无」。
 */
export async function persistRecoveryPackageWithinTransaction(input: {
  gate: RecoveryPersistGateOutcome;
  units: readonly RecoveryPersistUnitWrite[];
  port: RecoveryPersistTransactionPort;
}): Promise<RecoveryPersistResult> {
  if (input.gate.decision !== 'ALLOW' || input.gate.guardEvaluated !== true) {
    return {
      persisted: false,
      code: 'P2E_GATE_NOT_ALLOWED',
      unitsWritten: 0,
      traceBasis: 'planDigest',
      businessIdentity: 'packageDigest',
    };
  }
  assertApprovedTransactionUnits(input.units);
  await input.port.runInTransaction(input.units);
  return {
    persisted: true,
    code: 'P2E_PERSISTED',
    unitsWritten: input.units.length,
    traceBasis: 'planDigest',
    businessIdentity: 'packageDigest',
  };
}


/* ------------------------------------------------------------------ *
 * 必修 3 接线：lineage 反查投影（P2-E3，纯函数）
 * ------------------------------------------------------------------ */

export const RECOVERY_LINEAGE_CHAIN = [
  'CanonicalSourceFacts',
  'RecoveryPackage',
  'RecoveryPackageArtifact',
  'FileAsset',
  'packageDigest',
  'AuditLog',
] as const;

export interface RecoveryLineageInput {
  package: {
    id: string;
    organizationId: string;
    claimItemId: string;
    packageVersion: string;
    packageDigest: string;
    status: string;
  };
  artifacts: readonly { id: string; packageId: string; artifactKind: string; sha256: string; fileAssetId: string | null }[];
  fileAssets: readonly { id: string; organizationId: string; storageKey: string | null }[];
  auditLogs: readonly { id: string; entityId: string | null; action: string }[];
  planDigest: string | null;
}

export interface RecoveryLineageProjection {
  chain: readonly string[];
  organizationId: string;
  claimItemId: string;
  packageVersion: string;
  businessIdentity: 'packageDigest';
  identityValue: string;
  traceBasis: 'planDigest';
  planDigest: string | null;
  artifactIds: readonly string[];
  fileAssetIds: readonly string[];
  auditLogIds: readonly string[];
  orphanFileAssetIds: readonly string[];
}

/**
 * 反查投影：只做身份/引用一致性整理，不读库、不重算 digest。
 * 跨租户 artifact / fileAsset 一律不进入投影（仅在 orphan 中显式暴露），保证 tenant isolation 可验证。
 */
export function buildRecoveryPackageLineageProjection(input: RecoveryLineageInput): RecoveryLineageProjection {
  const orgId = input.package.organizationId;
  const artifacts = input.artifacts.filter((a) => a.packageId === input.package.id);
  const artifactIds = artifacts.map((a) => a.id).sort();
  const assetIds = new Set(input.fileAssets.filter((f) => f.organizationId === orgId).map((f) => f.id));
  const fileAssetIds = artifacts
    .map((a) => a.fileAssetId)
    .filter((id): id is string => typeof id === 'string' && assetIds.has(id))
    .sort();
  const orphanFileAssetIds = artifacts
    .map((a) => a.fileAssetId)
    .filter((id): id is string => typeof id === 'string' && !assetIds.has(id))
    .sort();
  const auditLogIds = input.auditLogs
    .filter((l) => l.entityId === input.package.id)
    .map((l) => l.id)
    .sort();
  return {
    chain: RECOVERY_LINEAGE_CHAIN,
    organizationId: orgId,
    claimItemId: input.package.claimItemId,
    packageVersion: input.package.packageVersion,
    businessIdentity: 'packageDigest',
    identityValue: input.package.packageDigest,
    traceBasis: 'planDigest',
    planDigest: input.planDigest,
    artifactIds,
    fileAssetIds,
    auditLogIds,
    orphanFileAssetIds,
  };
}
