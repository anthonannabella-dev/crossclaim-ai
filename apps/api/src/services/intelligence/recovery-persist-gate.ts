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
import type { CustomerRecoveryState } from './customer-recovery-state';
import { prioritizeOpportunities } from './recovery-prioritizer';
import { planRecovery, type RecoveryPlanAction } from './recovery-planner';
import type { RecoveryToolRegistry } from './recovery-tool-registry';
import { buildRecoveryPlanDigest } from './recovery-guard-dry-run';

/** 必修 1：P2-E 唯一的 Guard action；出现 claim.submit 即视为配置错误。 */
export const P2_E_GUARD_ACTION = 'claim.prepare' as const;

/** 明确禁止：P2-D 的 external submission 门禁不得被当作持久化前提。 */
export const P2_E_FORBIDDEN_GUARD_ACTIONS: readonly string[] = ['claim.submit', 'platform.write', 'appeal.submit'];

export const P2_E_PERSIST_GATE_BOUNDARY = {
  guardAction: P2_E_GUARD_ACTION,
  requiresP2dAllow: false,
  transactionRequired: true,
  dbDeleteGuardRequired: true,
  canonicalReadyRecheckRequired: true,
  approvalConsumption: 'FORBIDDEN',
  executorInvocation: 'FORBIDDEN',
  businessFactWrite: 'DRY_RUN_ONLY',
  externalAction: 'FORBIDDEN',
  runtimeWiring: 'NONE',
} as const;

/**
 * 必修（MSG-20261005-22 + MSG-20261005-23 RISKS）：持久化入口**自己**必须重算 canonical READY。
 * 不得因为上游传入 `ALLOW` 快照就跳过；重算发生在任何 Action Guard 调用与任何 DB 写入之前。
 */
export const P2_E_CANONICAL_RECHECK_BOUNDARY = {
  canonicalReadyRecheckRequired: true,
  recheckBeforeGuardCall: true,
  recheckBeforeAnyDbWrite: true,
  trustsUpstreamAllowSnapshot: false,
  suppliedReadyMustEqualCanonicalPlannerReady: true,
  staleStatePolicy: 'DENY',
  tenantPolicy: 'DENY',
} as const;

/**
 * 必修（MSG-20261005-23 CHANGE 2）：lineage 审计必须使用**独立** action，
 * 不得复用既有 `recovery.package_generated`（否则两种语义混在同一个 action 里）。
 */
export const RECOVERY_SI_PACKAGE_PERSISTED_ACTION = 'recovery.si_package_persisted' as const;

/** lineage 审计 changes 的固定白名单（多键即 fail-closed） */
export const RECOVERY_SI_PACKAGE_LINEAGE_CHANGE_KEYS: readonly string[] = [
  'packageId',
  'packageVersion',
  'packageDigest',
  'planDigestVersion',
  'planDigest',
  'basisVersion',
  'opportunityRef',
  'domain',
  'guardAction',
];

export function assertRecoverySiPackageLineageChanges(changes: Record<string, unknown>): void {
  const extra = Object.keys(changes).filter((key) => !RECOVERY_SI_PACKAGE_LINEAGE_CHANGE_KEYS.includes(key));
  if (extra.length > 0) {
    throw new Error('RECOVERY_SI_LINEAGE_CHANGES_NOT_WHITELISTED: ' + extra.sort().join(','));
  }
}

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([key, nested]) => JSON.stringify(key) + ':' + stableStringify(nested)).join(',') + '}';
};

const canonicalDecimal = (value: number | null | undefined): string | null =>
  value === null || value === undefined ? null : Number(value).toFixed(4);

/** 与 P2-D CHANGE D1 相同的 execution-relevant 身份投影（本模块独立实现，不改动已 CLOSED 的 P2-D 模块）。 */
const executionIdentity = (action: RecoveryPlanAction): string =>
  stableStringify({
    domain: action.domain,
    opportunityRef: action.opportunityRef,
    proposedAction: action.proposedAction,
    toolRef: action.toolRef,
    executionMode: action.executionMode,
    authorizationRequired: action.authorizationRequired,
    ownerApprovalRequired: action.ownerApprovalRequired,
    expectedRecovery:
      action.expectedRecovery === null
        ? null
        : {
            amount: canonicalDecimal(action.expectedRecovery.amount),
            currency: action.expectedRecovery.currency.trim().toUpperCase(),
          },
  });

export interface RecoveryPersistCanonicalInput {
  /** fresh state（必须 tenantVerified） */
  state: CustomerRecoveryState;
  registry: RecoveryToolRegistry;
  /** 上游声称 READY_FOR_EXECUTION 的 action（写入请求依据） */
  suppliedReadyActions: readonly RecoveryPlanAction[];
  nowMs: number;
  maxSnapshotAgeMs?: number;
}

export type RecoveryPersistCanonicalCheck =
  | { ok: true; canonicalPlanDigest: string; canonicalReadyCount: number }
  | { ok: false; code: string; reasons: readonly string[] };

/**
 * canonical READY 重算（写入口硬前置）：
 *   fresh state → prioritize → canonical planRecovery → supplied READY 必须等于 canonical planner READY
 * 任一不成立 → fail-closed，且**不调用** Action Guard、不触库。
 */
export function verifyRecoveryPersistCanonicalReady(input: RecoveryPersistCanonicalInput): RecoveryPersistCanonicalCheck {
  const { state } = input;
  const maxAgeMs = input.maxSnapshotAgeMs ?? 15 * 60 * 1000;

  if (
    state.tenantVerified !== true ||
    state.opportunities.some((slice) => slice.organizationId !== state.organizationId)
  ) {
    return {
      ok: false,
      code: 'P2E_CANONICAL_TENANT_MISMATCH',
      reasons: ['canonical 重算前置：state 未通过租户校验 → fail-closed（不调用 Action Guard）'],
    };
  }

  const observedMs = Date.parse(state.observedAt);
  if (!Number.isFinite(observedMs) || input.nowMs - observedMs > maxAgeMs || observedMs > input.nowMs) {
    return {
      ok: false,
      code: 'P2E_CANONICAL_STATE_STALE',
      reasons: ['canonical 重算前置：state 陈旧或时间倒置 → fail-closed（不调用 Action Guard）'],
    };
  }

  if (input.suppliedReadyActions.length === 0) {
    return {
      ok: false,
      code: 'P2E_CANONICAL_READY_MISSING',
      reasons: ['没有提供任何 READY_FOR_EXECUTION action → fail-closed（不允许在无可验证依据时写入）'],
    };
  }

  const priority = prioritizeOpportunities(state);
  const canonicalPlan = planRecovery({
    state,
    ranked: priority.ranked,
    registry: input.registry,
    generatedAt: state.observedAt,
  });
  const canonicalReady = new Map<string, RecoveryPlanAction>();
  for (const action of canonicalPlan.actions) {
    if (action.proposedAction === 'READY_FOR_EXECUTION') canonicalReady.set(action.opportunityRef, action);
  }

  for (const supplied of input.suppliedReadyActions) {
    const canonical = canonicalReady.get(supplied.opportunityRef);
    if (supplied.proposedAction !== 'READY_FOR_EXECUTION' || canonical === undefined || executionIdentity(canonical) !== executionIdentity(supplied)) {
      return {
        ok: false,
        code: 'P2E_CANONICAL_READY_MISMATCH',
        reasons: [
          'supplied READY_FOR_EXECUTION 与内部重算 canonical planner READY 不一致（授权 / OWNER gate / provider / evidence / 工具 / 金额 / actionKind 篡改）→ fail-closed（不调用 Action Guard）',
        ],
      };
    }
  }

  return {
    ok: true,
    canonicalPlanDigest: buildRecoveryPlanDigest({ plan: canonicalPlan, verifiedActions: [...canonicalReady.values()] }),
    canonicalReadyCount: canonicalReady.size,
  };
}

export type RecoveryPersistGateDecision = 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL';

export interface RecoveryPersistGateOutcome {
  decision: RecoveryPersistGateDecision;
  code: string;
  reasons: readonly string[];
  guardAction: string | null;
  guardEvaluated: boolean;
  /** canonical READY 重算是否通过（写入口硬前置） */
  canonicalReadyVerified: boolean;
  /** 重算出的 canonical planDigest（仅作 lineage trace basis；写入失败时为 null） */
  canonicalPlanDigest: string | null;
  /** lineage 审计必须使用的独立 action（MSG-20261005-23 CHANGE 2） */
  lineageAction: string;
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
  /** 必修：写入口 canonical READY 重算输入（缺失即 fail-closed，不得跳过） */
  canonical?: RecoveryPersistCanonicalInput;
}): Promise<RecoveryPersistGateOutcome> {
  const base = {
    guardAction: P2_E_GUARD_ACTION as string | null,
    canonicalReadyVerified: false,
    canonicalPlanDigest: null as string | null,
    lineageAction: RECOVERY_SI_PACKAGE_PERSISTED_ACTION as string,
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

  // 必修（MSG-20261005-22 / MSG-20261005-23 RISKS）：写入口自己重算 canonical READY。
  if (!input.canonical) {
    return {
      ...base,
      decision: 'DENY',
      code: 'P2E_CANONICAL_RECHECK_INPUT_REQUIRED',
      reasons: ['缺少 canonical READY 重算输入（state / registry / suppliedReadyActions）→ fail-closed，且不调用 Action Guard'],
      guardEvaluated: false,
    };
  }
  if (input.canonical.state.organizationId !== input.organizationId) {
    return {
      ...base,
      decision: 'DENY',
      code: 'P2E_CANONICAL_TENANT_MISMATCH',
      reasons: ['canonical state 租户与目标租户不一致 → fail-closed，且不调用 Action Guard'],
      guardEvaluated: false,
    };
  }
  const canonicalCheck = verifyRecoveryPersistCanonicalReady(input.canonical);
  if (!canonicalCheck.ok) {
    return {
      ...base,
      decision: 'DENY',
      code: canonicalCheck.code,
      reasons: canonicalCheck.reasons,
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
    canonicalReadyVerified: true,
    canonicalPlanDigest: canonicalCheck.canonicalPlanDigest,
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
 * 真正的拒绝由数据库触发器实现（迁移 20261005040000_recovery_package_delete_guard +
 * tools/tenant-triggers/append-only-triggers.json 清单登记），本常量只声明要求与当前状态。
 */
export const RECOVERY_PACKAGE_DELETE_GUARD = {
  applicationDeleteAllowed: false,
  dbTriggerRequired: true,
  migrationStatus: 'APPLIED',
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
