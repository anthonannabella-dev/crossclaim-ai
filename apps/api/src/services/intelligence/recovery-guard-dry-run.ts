/**
 * Recovery SI —— P2-D v1：Action Guard dry-run（只判定，不授权）
 * ---------------------------------------------------------------
 * 授权：MSG-20261005-19（`P2_D_V1_IMPLEMENTATION = AUTHORIZED_WITH_CONDITIONS`、`P2_D_DRY_RUN_ONLY = AUTHORIZED`；
 * `APPROVAL_CONSUMPTION / EXECUTOR_INVOCATION / BUSINESS_FACT_WRITE / EXTERNAL_ACTION = FORBIDDEN`）。
 *
 * 允许链路（到此停止）：
 *   fresh verified READY_FOR_EXECUTION
 *     → immutable execution basis
 *     → trusted Control Plane capability snapshot（ProductionControlPlane.snapshotFor）
 *     → existing Action Guard dry-run evaluation（evaluateWithoutAudit，不写审计）
 *     → ALLOW / DENY / REQUIRES_APPROVAL
 *     → STOP
 *
 * 必修 A（MSG-19）：**不得复用 recovery-policy 的 RSI 映射**。本模块自带
 *   「Recovery execution intent → 既有 ACTION_GUARD_CATALOG action」的**静态**映射；
 *   `NO_DYNAMIC_ACTION_NAME` / `NO_MODEL_GENERATED_ACTION` / `NO_FALLBACK_GUESS`；
 *   未映射（含 `CUSTOMS_FILING` 这一类在 catalog 无等价 action 的意图）→ **DENY 且零 Guard 调用**。
 * 必修 B（MSG-19）：capabilities **必须**来自可信 `ProductionControlPlane`；
 *   `SI_SELF_SUPPLIED_CAPABILITIES = FORBIDDEN`（本模块从不构造 capabilities 字段）。
 */

import type { CustomerRecoveryState, RecoveryDomain } from './customer-recovery-state';
import { prioritizeOpportunities } from './recovery-prioritizer';
import type { RecoveryActionKind, RecoveryPlan, RecoveryPlanAction } from './recovery-planner';
import { planRecovery } from './recovery-planner';
import type { RecoveryToolRegistry } from './recovery-tool-registry';
import { verifyRecoveryPlan } from './recovery-verifier';
import type { ProductionControlPlane, ControlPlaneSnapshot } from '../action-guard/control-plane';
import type { ActionGuardResult } from '../action-guard/action-guard';
import { sha256Hex } from '../recovery/recovery-package';

export const RECOVERY_PLAN_DIGEST_VERSION = 'plan-digest/v1';
export const RECOVERY_EXECUTION_BASIS_VERSION = 'recovery-execution-basis/v1';

/**
 * 静态映射：READY_FOR_EXECUTION 的「执行意图」→ 既有 Action Guard Catalog action。
 * `CUSTOMS: null` = Customs Filing 在 catalog 无等价 action（绝不能偷换成 customs.recovery.start），
 * 结果是永久拒绝且零 Guard 调用。
 */
export const RECOVERY_GUARD_ACTION_MAP: Record<RecoveryDomain, string | null> = {
  PLATFORM: 'claim.submit',
  CARRIER: 'claim.submit',
  INDEPENDENT_SITE: 'claim.submit',
  CUSTOMS: null,
};

/** 非执行类 SI 动作 → catalog action（仅用于可验证的静态映射；未映射一律 null） */
export const RECOVERY_ACTION_GUARD_MAP: Record<RecoveryActionKind, string | null> = {
  EXECUTE_READ_ONLY_CHECK: 'evidence.read',
  PREPARE_PACKAGE: 'claim.prepare',
  REQUEST_EVIDENCE: null,
  REQUEST_AUTHORIZATION: null,
  REQUEST_OWNER_APPROVAL: null,
  WAIT_PROVIDER: null,
  FILE_MODE_FALLBACK: null,
  HOLD: null,
  READY_FOR_EXECUTION: null,
};

/** 本模块只允许引用这些既有 catalog action；出现其它名字即视为配置错误（fail-closed） */
export const RECOVERY_ALLOWED_GUARD_ACTIONS: readonly string[] = ['claim.submit', 'claim.prepare', 'evidence.read'];

export interface RecoveryExecutionBasis {
  basisVersion: string;
  organizationId: string;
  opportunityRef: string;
  domain: RecoveryDomain;
  recoveryActionKind: RecoveryActionKind;
  toolRef: string | null;
  guardAction: string | null;
  snapshotObservedAt: string;
  planDigestVersion: string;
  planDigest: string;
}

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([key, nested]) => JSON.stringify(key) + ':' + stableStringify(nested)).join(',') + '}';
};

const canonicalDecimal = (value: number | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  return Number(value).toFixed(4);
};

/**
 * planDigest（MSG-19 ③）：canonical projection + SHA-256；**不含** generatedAt / objective / UI 展示字段。
 */
export function buildRecoveryPlanDigest(input: {
  plan: RecoveryPlan;
  verifiedActions: readonly RecoveryPlanAction[];
}): string {
  const actions = [...input.verifiedActions]
    .map((action) => ({
      domain: action.domain,
      opportunityRef: action.opportunityRef,
      proposedAction: action.proposedAction,
      toolRef: action.toolRef,
      prerequisites: [...action.prerequisites].sort(),
      reasonCodes: [...action.reasonCodes].sort(),
      authorizationRequired: action.authorizationRequired,
      ownerApprovalRequired: action.ownerApprovalRequired,
      expectedRecovery:
        action.expectedRecovery === null
          ? null
          : {
              amount: canonicalDecimal(action.expectedRecovery.amount),
              currency: action.expectedRecovery.currency.trim().toUpperCase(),
            },
      executionMode: action.executionMode,
    }))
    .sort((a, b) => {
      const key = (entry: typeof a) => `${entry.domain}|${entry.opportunityRef}|${entry.proposedAction}|${entry.toolRef ?? ''}`;
      return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
    });

  const projection = {
    version: RECOVERY_PLAN_DIGEST_VERSION,
    organizationId: input.plan.organizationId,
    snapshotObservedAt: input.plan.snapshotObservedAt,
    verifiedActions: actions,
  };
  return sha256Hex(stableStringify(projection));
}

export function resolveGuardAction(action: RecoveryPlanAction): string | null {
  if (action.proposedAction === 'READY_FOR_EXECUTION') return RECOVERY_GUARD_ACTION_MAP[action.domain];
  return RECOVERY_ACTION_GUARD_MAP[action.proposedAction];
}

export type RecoveryGuardDryRunDecision = 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL';

export interface RecoveryGuardDryRunOutcome {
  opportunityRef: string;
  domain: RecoveryDomain;
  guardAction: string | null;
  decision: RecoveryGuardDryRunDecision;
  code: string;
  reasons: readonly string[];
  executionAuthorized: false;
  executorInvoked: false;
  submitted: false;
  persisted: false;
  approvalConsumed: false;
  guardEvaluated: boolean;
  basis: RecoveryExecutionBasis | null;
}

export type RecoveryGuardDryRunResult =
  | { ok: false; reason: 'TENANT_MISMATCH' | 'STALE_STATE'; outcomes: readonly RecoveryGuardDryRunOutcome[]; guardCallCount: 0 }
  | { ok: true; outcomes: readonly RecoveryGuardDryRunOutcome[]; guardCallCount: number };

const decideFromGuard = (result: ActionGuardResult): RecoveryGuardDryRunDecision => {
  const decision = String(result.decision);
  if (decision === 'ALLOW') return 'ALLOW';
  if (decision === 'REQUIRES_APPROVAL' || decision === 'REQUIRE_APPROVAL') return 'REQUIRES_APPROVAL';
  return 'DENY';
};

/**
 * dry-run 入口：只有 fresh verified `READY_FOR_EXECUTION` 才会进入 Guard 判定；
 * 任何未映射意图都在调用 Guard 之前 fail-closed（guardCallCount 不增加）。
 */
export async function runRecoveryGuardDryRun(input: {
  state: CustomerRecoveryState;
  plan: RecoveryPlan;
  registry: RecoveryToolRegistry;
  controlPlane: Pick<ProductionControlPlane, 'snapshotFor' | 'evaluateWithoutAudit'>;
  actorUserId: string;
  actorOrganizationId: string;
  nowMs: number;
  maxSnapshotAgeMs?: number;
}): Promise<RecoveryGuardDryRunResult> {
  const maxAgeMs = input.maxSnapshotAgeMs ?? 15 * 60 * 1000;
  const empty: RecoveryGuardDryRunOutcome[] = [];

  const tenantBroken =
    input.state.tenantVerified !== true ||
    input.plan.organizationId !== input.state.organizationId ||
    input.actorOrganizationId !== input.state.organizationId ||
    input.state.opportunities.some((slice) => slice.organizationId !== input.state.organizationId);
  if (tenantBroken) return { ok: false, reason: 'TENANT_MISMATCH', outcomes: empty, guardCallCount: 0 };

  const observedMs = Date.parse(input.state.observedAt);
  if (!Number.isFinite(observedMs) || input.nowMs - observedMs > maxAgeMs || observedMs > input.nowMs) {
    return { ok: false, reason: 'STALE_STATE', outcomes: empty, guardCallCount: 0 };
  }

  const priority = prioritizeOpportunities(input.state);
  const verification = verifyRecoveryPlan({
    plan: input.plan,
    state: input.state,
    registry: input.registry,
    priority,
    nowMs: input.nowMs,
    maxSnapshotAgeMs: maxAgeMs,
  });
  const verifiedActions = verification.ok ? verification.verifiedActions : [];
  const planDigest = buildRecoveryPlanDigest({ plan: input.plan, verifiedActions });

  // CHANGE D1（MSG-20261005-20）：supplied READY 必须等于内部重算的 canonical planner READY。
  // 只读重算（同 state / 同 ranked / 同 registry），不读取 input.plan 的任何字段，因此
  // authorizationReady / riskClass / providerApproval / evidenceComplete / PREPARE tool 篡改，
  // 以及 actionKind 升级（REQUEST_AUTHORIZATION|REQUEST_OWNER_APPROVAL|WAIT_PROVIDER → READY_FOR_EXECUTION）
  // 都在这里 fail-closed，且不调用 Action Guard。
  const canonicalPlan = planRecovery({
    state: input.state,
    ranked: priority.ranked,
    registry: input.registry,
    generatedAt: input.state.observedAt,
  });
  const canonicalReady = new Map<string, RecoveryPlanAction>();
  for (const canonicalAction of canonicalPlan.actions) {
    if (canonicalAction.proposedAction === 'READY_FOR_EXECUTION') {
      canonicalReady.set(canonicalAction.opportunityRef, canonicalAction);
    }
  }
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

  const outcomes: RecoveryGuardDryRunOutcome[] = [];
  let guardCallCount = 0;

  for (const action of verifiedActions) {
    if (action.proposedAction !== 'READY_FOR_EXECUTION') continue;
    const guardAction = resolveGuardAction(action);
    const base = {
      opportunityRef: action.opportunityRef,
      domain: action.domain,
      guardAction,
      executionAuthorized: false as const,
      executorInvoked: false as const,
      submitted: false as const,
      persisted: false as const,
      approvalConsumed: false as const,
    };
    const basis: RecoveryExecutionBasis = {
      basisVersion: RECOVERY_EXECUTION_BASIS_VERSION,
      organizationId: input.state.organizationId,
      opportunityRef: action.opportunityRef,
      domain: action.domain,
      recoveryActionKind: action.proposedAction,
      toolRef: action.toolRef,
      guardAction,
      snapshotObservedAt: input.state.observedAt,
      planDigestVersion: RECOVERY_PLAN_DIGEST_VERSION,
      planDigest,
    };

    if (guardAction === null) {
      outcomes.push({
        ...base,
        decision: 'DENY',
        code: action.domain === 'CUSTOMS' ? 'GUARD_ACTION_UNMAPPED_L5_NO_CATALOG_ACTION' : 'GUARD_ACTION_UNMAPPED',
        reasons: [
          '执行意图在 ACTION_GUARD_CATALOG 无等价 action → fail-closed，且不调用 Action Guard',
        ],
        guardEvaluated: false,
        basis,
      });
      continue;
    }
    if (!RECOVERY_ALLOWED_GUARD_ACTIONS.includes(guardAction)) {
      outcomes.push({
        ...base,
        decision: 'DENY',
        code: 'GUARD_ACTION_NOT_ALLOWLISTED',
        reasons: ['静态映射引用了非白名单 action → fail-closed'],
        guardEvaluated: false,
        basis,
      });
      continue;
    }

    const canonicalReadyAction = canonicalReady.get(action.opportunityRef);
    if (
      canonicalReadyAction === undefined ||
      executionIdentity(canonicalReadyAction) !== executionIdentity(action)
    ) {
      outcomes.push({
        ...base,
        decision: 'DENY',
        code: 'CANONICAL_READY_MISMATCH',
        reasons: [
          'supplied READY_FOR_EXECUTION 与内部重算 canonical plan 的 READY 不一致（授权 / OWNER gate / provider / evidence / 工具 / 金额篡改）→ fail-closed，且不调用 Action Guard',
        ],
        guardEvaluated: false,
        basis,
      });
      continue;
    }

    const snapshot: ControlPlaneSnapshot = await input.controlPlane.snapshotFor(input.state.organizationId);
    if (snapshot.degraded) {
      outcomes.push({
        ...base,
        decision: 'DENY',
        code: 'CONTROL_PLANE_DEGRADED',
        reasons: ['Control Plane 配置源降级/缺失 → fail-closed（不调用 Action Guard）'],
        guardEvaluated: false,
        basis,
      });
      continue;
    }

    // capabilities 一律来自可信 Control Plane（本模块不构造 capabilities）
    const guard = await input.controlPlane.evaluateWithoutAudit(
      {
        action: guardAction,
        actorUserId: input.actorUserId,
        organizationId: input.state.organizationId,
        requestedBy: input.actorUserId,
      },
      snapshot.config,
    );
    guardCallCount += 1;
    outcomes.push({
      ...base,
      decision: decideFromGuard(guard),
      code: guard.code,
      reasons: guard.reasons,
      guardEvaluated: true,
      basis,
    });
  }

  return { ok: true, outcomes, guardCallCount };
}

export const RECOVERY_GUARD_DRY_RUN_BOUNDARY = {
  dryRunOnly: true,
  approvalConsumption: 'FORBIDDEN',
  executorInvocation: 'FORBIDDEN',
  businessFactWrite: 'FORBIDDEN',
  externalAction: 'FORBIDDEN',
  staticGuardActionMapping: true,
  dynamicActionNames: false,
  modelGeneratedActionNames: false,
  fallbackGuess: false,
  unmappedIntentFailsClosed: true,
  siSelfSuppliedCapabilities: false,
  capabilitiesSource: 'ProductionControlPlane.snapshotFor',
  guardEvaluationEntry: 'ProductionControlPlane.evaluateWithoutAudit',
  controlPlaneDegradedFailsClosed: true,
  canonicalReadyAlignment: 'supplied READY_FOR_EXECUTION must equal internally recomputed canonical planner READY (execution-relevant fields)',
  approvalVerificationOwner: 'existing approval verifier / HITL channel',
  networkCalls: 0,
  credentialReads: 0,
  runtimeWiring: 'NONE',
  actionGuardCatalogUnchanged: true,
  planDigestVersion: RECOVERY_PLAN_DIGEST_VERSION,
} as const;
