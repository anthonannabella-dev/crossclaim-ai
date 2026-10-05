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
