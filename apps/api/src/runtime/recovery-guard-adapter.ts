/**
 * STEP 3 FINAL-3（CHANGE B）—— 真实 Shared Action Guard / Control Plane adapter
 * ---------------------------------------------------------------
 * 目的：把 domain pack 的 guard intent 接到**项目现有**共享安全组件，而不是 fail-closed 占位端口：
 *   intent → resolveGuardAction → 本 adapter → shared Action Guard 运行时
 *          （Control Plane 能力快照 + Kill Switch 读端口 + ACTION_GUARD_CATALOG 闸门）
 *   → ALLOW 才允许执行 deterministic read tool。
 *
 * 硬约束：
 *   - 不创建第二套 Action Guard / Control Plane / Kill Switch / approval engine / tenant policy engine；
 *     本文件只做**映射**（共享决策 → domain pack 端口语义）；
 *   - DENY / REQUIRE_APPROVAL / Kill Switch / Control Plane 不可用（抛错）→ fail-closed，toolCallCount = 0；
 *   - 未知 / 畸形决策 → DENY（绝不放行）。
 */

import type { RuntimeActionGuard } from '../services/action-guard/runtime-guard';
import {
  createAppActionGuard,
  type AppActionGuardDeps,
} from '../services/action-guard/runtime-guard-composition';
import type {
  RsiRecoveryGuardPort,
  RsiRecoveryGuardRequest,
  RsiRecoveryGuardVerdict,
} from './recovery-si-pack';

export const RECOVERY_GUARD_ADAPTER_ACTOR_REF = 'recovery-si-runtime/v1';

export const RECOVERY_GUARD_ADAPTER_BOUNDARY = {
  reusesSharedGuard: 'services/action-guard/runtime-guard-composition#createAppActionGuard（唯一 shared Action Guard）',
  controlPlaneOwner: 'services/action-guard/control-plane.ts（唯一 Control Plane）',
  killSwitchOwner: 'services/action-guard/kill-switch-adapter.ts + services/operations/kill-switch.ts（唯一 Kill Switch）',
  secondGuardImplementation: 'FORBIDDEN',
  onUnavailable: 'DENY + degraded（fail-closed；不得 fallback 绕过 Guard）',
  onRequireApproval: 'REQUIRES_APPROVAL（toolCallCount = 0；保持等待人工/HITL）',
  onKillSwitch: 'DENY + killSwitchActive（toolCallCount = 0）',
} as const;

/** 共享运行时 guard → domain pack 端口决策语义映射（纯映射，无第二实现）。 */
export function createSharedRecoveryGuardAdapter(input: {
  guard: RuntimeActionGuard;
  actorUserId?: string;
}): RsiRecoveryGuardPort {
  const actorUserId = input.actorUserId ?? RECOVERY_GUARD_ADAPTER_ACTOR_REF;
  return {
    async evaluate(request: RsiRecoveryGuardRequest): Promise<RsiRecoveryGuardVerdict> {
      let result;
      try {
        result = await input.guard.evaluate({
          action: request.action,
          actorUserId,
          organizationId: request.organizationId,
          requestedBy: request.packId,
        });
      } catch (error) {
        // Control Plane / Kill Switch 不可用 → fail-closed（不 fallback）
        return {
          decision: 'DENY',
          reason:
            'RECOVERY_GUARD_UNAVAILABLE:' + (error instanceof Error ? error.message : String(error)),
          degraded: true,
        };
      }
      const reasons = Array.isArray(result.reasons) ? result.reasons : [];
      const killSwitchActive = /kill/i.test(result.code) || reasons.some((r) => /kill/i.test(r));
      const decision =
        result.decision === 'ALLOW'
          ? 'ALLOW'
          : result.decision === 'REQUIRE_APPROVAL'
            ? 'REQUIRES_APPROVAL'
            : 'DENY';
      return {
        decision,
        reason: result.code,
        ...(killSwitchActive ? { killSwitchActive: true } : {}),
      };
    },
  };
}

/** 便捷入口：直接用共享 App Action Guard 依赖构造 adapter（不新建第二 Guard）。 */
export function createSharedRecoveryGuardAdapterFromAppGuard(
  deps: AppActionGuardDeps,
): RsiRecoveryGuardPort {
  return createSharedRecoveryGuardAdapter({ guard: createAppActionGuard(deps) });
}
