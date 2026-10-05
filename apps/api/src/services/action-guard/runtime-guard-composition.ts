/**
 * APP-LEVEL ACTION GUARD COMPOSITION（授权项 ② 第一批：把守卫接到真实服务端依赖）
 * ------------------------------------------------------------------------------
 * 组合根：把真实依赖接成一个可直接注入 service / route / job 的 RuntimeActionGuard：
 *   - Kill Switch：services/operations/kill-switch-resolver（可注入，便于测试）
 *   - 审计落地：Prisma AuditLog（actorType=AI + actorRef，满足 cc_audit_actor_shape_check）
 *   - 控制面配置：由注入的只读配置提供方给出；**缺省 READ_ONLY / Gate=NOT_SATISFIED（拒绝）**
 *
 * 纪律：
 *   - 默认拒绝：未显式提供配置源时不会放行任何写入动作；
 *   - 不读 env（配置由调用方在组合根决定，便于审计）；
 *   - 本模块只做装配，不改变任何领域语义。
 */

import type { PrismaClient } from '@prisma/client';

import { createEffectiveKillSwitchResolver } from '../operations/kill-switch-resolver';
import type { ControlPlaneConfig, ControlPlaneConfigPort } from './control-plane';
import { createWiredControlPlane } from './control-plane-wiring';
import { createKillSwitchReadPort, type KillSwitchResolverLike } from './kill-switch-adapter';
import type { ActionGuardAuditPort, ActionGuardAuditRecord, RuntimeActionGuard } from './runtime-guard';

export const ACTION_GUARD_AUDIT_ACTOR_REF = 'action-guard-runtime/v1';

/**
 * PHASE 3 FINAL2: trusted provenance for app-composed guards.
 * Only guards produced by createAppActionGuard() are registered, so a caller cannot hand a
 * structural fake RuntimeActionGuard (e.g. one that always returns ALLOW) into a runtime.
 */
const APP_ACTION_GUARDS = new WeakSet<RuntimeActionGuard>();

/** Prisma 版审计落地端口（白名单字段写入 AuditLog；不含敏感值） */
export function createPrismaActionGuardAuditPort(prisma: PrismaClient): ActionGuardAuditPort {
  return {
    async write(record: ActionGuardAuditRecord) {
      await prisma.auditLog.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: record.organizationId,
          actorType: 'AI',
          actorRef: ACTION_GUARD_AUDIT_ACTOR_REF,
          action: record.action,
          // CHANGE D：目标与操作关联使用结构化字段（不再混入 reasonCodes）
          entityType: record.targetRef ? 'ActionGuardTarget' : 'ActionGuardDecision',
          entityId: record.targetRef ?? null,
          changes: {
            actionName: record.actionName,
            decision: record.decision,
            code: record.code,
            risk: record.risk,
            reasonCodes: record.reasonCodes,
            // R3：执行主体必须可关联（AuditLog.actorType=AI 时 actorUserId 必须为空，故记入 changes）
            actorUserId: record.actorUserId,
            approvalId: record.approvalId ?? null,
            operationId: record.operationId ?? null,
            reason: record.reason ?? null,
            evaluatedAt: record.evaluatedAt,
          } as never,
          createdAt: new Date(),
        },
      });
    },
  };
}

export interface AppActionGuardDeps {
  prisma: PrismaClient;
  /** 只读控制面配置提供方；缺省 → READ_ONLY / NOT_SATISFIED（拒绝写入） */
  config?: ControlPlaneConfigPort;
  /** 可注入的 Kill Switch resolver（测试用）；缺省使用真实 Prisma 端口 */
  killSwitchResolver?: KillSwitchResolverLike;
  /** 可注入的审计端口（测试用）；缺省写 Prisma AuditLog */
  audit?: ActionGuardAuditPort;
}

export function createAppActionGuard(deps: AppActionGuardDeps): RuntimeActionGuard {
  if (!deps?.prisma && !deps?.killSwitchResolver) throw new Error('APP_ACTION_GUARD_MISSING_KILL_SWITCH_SOURCE');

  const resolver =
    deps.killSwitchResolver ??
    createEffectiveKillSwitchResolver({
      controlRequests: { findMany: (args) => deps.prisma.killSwitchRequest.findMany(args) },
    });

  const plane = createWiredControlPlane({
    killSwitch: createKillSwitchReadPort(resolver),
    audit: deps.audit ?? createPrismaActionGuardAuditPort(deps.prisma),
    config: deps.config,
  });

  const guard = plane.guard;
  APP_ACTION_GUARDS.add(guard);
  return guard;
}

/** Read-only provenance check: only factory-composed app guards are trusted. */
export function isAppActionGuard(guard: RuntimeActionGuard): boolean {
  return APP_ACTION_GUARDS.has(guard);
}

/** 便捷：由静态配置构造只读配置端口（组合根/测试均可）；缺省即拒绝写入 */
export function staticControlPlaneConfig(config: ControlPlaneConfig): ControlPlaneConfigPort {
  return { read: () => config };
}
