/**
 * HITL 审批验证器 v3（MSG-20260930-17 CHANGE A/B：**操作级**审批授权）
 * ---------------------------------------------------------------------
 * 与 v2 的本质区别：**不再以"案件状态"充当审批**。
 *
 *   approvalId = `recovery.review_approved` 审计事件的 **id**
 *
 * 校验清单（任一不满足即拒绝，且不再统一伪报为 TENANT_MISMATCH）：
 *   - 审批事件必须存在、属于该租户、entityType=Case、entityId=目标案件；
 *   - 绑定动作 boundAction 必须等于本次动作；
 *   - 审批人必须是该租户 ACTIVE 成员（角色在允许集合内）；
 *   - 执行人必须存在、是该租户 ACTIVE 成员、且角色具有执行权限（与审批人分别校验）；
 *   - 绑定载荷指纹必须与本次提交的规范化载荷**逐项一致**；
 *   - 有效期：now >= expiresAt → EXPIRED；
 *   - 撤销：晚于该审批的 rejected/revoked 事件 → REVOKED；
 *   - 消费：存在同 approvalId 的 approval_consumed 事件 → ALREADY_CONSUMED；
 *   - 审批轮次：审批事件必须晚于它对应的 review_required；
 *   - 数据源异常 → SOURCE_ERROR（不猜测、不放行）。
 *
 * 原子消费（"首次资金写入 + 消费"）由执行侧在资金事务内用 advisory lock 完成（见契约 §4），
 * 本模块只负责**只读**校验。
 */

import type { PrismaClient } from '@prisma/client';

import { normalizeBoundPayload } from '../workflow/recovery-review';
import type {
  ActionGuardApprovalDecision,
  ActionGuardApprovalQuery,
  ActionGuardApprovalVerifier,
} from './approval-verifier';

export const APPROVAL_EVENT_ACTION = 'recovery.review_approved';
export const APPROVAL_REQUIRED_EVENT_ACTION = 'recovery.review_required';
export const APPROVAL_REJECTED_EVENT_ACTION = 'recovery.review_rejected';
export const APPROVAL_REVOKED_EVENT_ACTION = 'recovery.approval_revoked';
export const APPROVAL_CONSUMED_EVENT_ACTION = 'recovery.approval_consumed';

export const APPROVAL_ACTOR_ROLES = ['OWNER', 'ADMIN'] as const;
export const EXECUTOR_ROLES = ['OWNER', 'ADMIN', 'FINANCE'] as const;

export interface ApprovalEventRow {
  id: string;
  organizationId: string;
  actorUserId: string | null;
  entityType: string | null;
  entityId: string | null;
  changes: unknown;
  createdAt: Date;
}

export interface HitlApprovalVerifierDeps {
  prisma: PrismaClient;
  /** 只读：按 id 读取审批事件（默认查 AuditLog） */
  readApprovalEvent?: (args: { organizationId: string; approvalId: string }) => Promise<ApprovalEventRow | null>;
  /** 只读：目标对象所属租户（默认查 Case；null = 不存在） */
  resolveTargetTenant?: (args: { targetRef: string }) => Promise<string | null>;
  /** 只读：执行人在该租户的角色（null = 非 ACTIVE 成员） */
  resolveExecutorRole?: (args: { organizationId: string; actorUserId: string }) => Promise<string | null>;
  /** 只读：审批人角色（同上） */
  resolveApproverRole?: (args: { organizationId: string; actorUserId: string }) => Promise<string | null>;
  /** 只读：该审批之后是否出现 rejected/revoked 事件 */
  hasLaterRevocation?: (args: { organizationId: string; caseId: string; approvalCreatedAt: Date }) => Promise<boolean>;
  /** 只读：同 approvalId 是否已被消费 */
  isConsumed?: (args: { organizationId: string; approvalId: string }) => Promise<boolean>;
  /** 只读：该审批之前是否存在对应的 review_required（轮次校验） */
  hasPriorRequired?: (args: { organizationId: string; caseId: string; approvalCreatedAt: Date }) => Promise<boolean>;
  now?: () => Date;
  /** P3（② 第二批）：事件族与目标实体（缺省 = recovery + Case）。PAYMENT 变体传 payment.review_* 与 BillingInvoice。 */
  approvalEventAction?: string;
  requiredEventAction?: string;
  rejectedEventAction?: string;
  revokedEventAction?: string;
  consumedEventAction?: string;
  targetEntityType?: string;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function boundPayloadOf(changes: unknown): Record<string, unknown> | null {
  if (!changes || typeof changes !== 'object') return null;
  const bound = (changes as { boundPayload?: unknown }).boundPayload;
  return bound && typeof bound === 'object' ? (bound as Record<string, unknown>) : null;
}

function boundActionOf(changes: unknown): string | null {
  if (!changes || typeof changes !== 'object') return null;
  return str((changes as { boundAction?: unknown }).boundAction);
}

function expiresAtOf(changes: unknown): Date | null {
  if (!changes || typeof changes !== 'object') return null;
  const raw = (changes as { expiresAt?: unknown }).expiresAt;
  if (typeof raw !== 'string') return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function createHitlApprovalVerifier(deps: HitlApprovalVerifierDeps): ActionGuardApprovalVerifier {
  if (!deps?.prisma) throw new Error('HITL_VERIFIER_MISSING_PRISMA');
  const now = deps.now ?? (() => new Date());
  const approvalAction = deps.approvalEventAction ?? APPROVAL_EVENT_ACTION;
  const requiredAction = deps.requiredEventAction ?? APPROVAL_REQUIRED_EVENT_ACTION;
  const rejectedAction = deps.rejectedEventAction ?? APPROVAL_REJECTED_EVENT_ACTION;
  const revokedAction = deps.revokedEventAction ?? APPROVAL_REVOKED_EVENT_ACTION;
  const consumedAction = deps.consumedEventAction ?? APPROVAL_CONSUMED_EVENT_ACTION;
  const targetEntityType = deps.targetEntityType ?? 'Case';

  const readApprovalEvent =
    deps.readApprovalEvent ??
    (async ({ organizationId, approvalId }) => {
      const row = await deps.prisma.auditLog.findFirst({
        where: { id: approvalId, organizationId, action: approvalAction },
        select: { id: true, organizationId: true, actorUserId: true, entityType: true, entityId: true, changes: true, createdAt: true },
      });
      return row ?? null;
    });

  const resolveTargetTenant =
    deps.resolveTargetTenant ??
    (async ({ targetRef }) => {
      const kase = await deps.prisma.case.findUnique({ where: { id: targetRef }, select: { organizationId: true } });
      return kase?.organizationId ?? null;
    });

  /**
   * R3 CHANGE A：主体有效性 = 用户状态 ACTIVE + 有效成员关系 + 角色；
   * 三者缺一即返回 null（拒绝），不只看 membership.isActive。
   */
  const resolveMemberRole = async ({ organizationId, actorUserId }: { organizationId: string; actorUserId: string }) => {
    const user = await deps.prisma.user.findFirst({ where: { id: actorUserId, status: 'ACTIVE' }, select: { id: true } });
    if (!user) return null;
    const membership = await deps.prisma.membership.findFirst({
      where: { organizationId, userId: actorUserId, isActive: true },
      select: { role: true },
    });
    return membership?.role ?? null;
  };

  const hasLaterRevocation =
    deps.hasLaterRevocation ??
    (async ({ organizationId, caseId, approvalCreatedAt }) => {
      const count = await deps.prisma.auditLog.count({
        where: {
          organizationId,
          entityType: targetEntityType,
          entityId: caseId,
          action: { in: [rejectedAction, revokedAction] },
          createdAt: { gt: approvalCreatedAt },
        },
      });
      return count > 0;
    });

  const isConsumed =
    deps.isConsumed ??
    (async ({ organizationId, approvalId }) => {
      const count = await deps.prisma.auditLog.count({
        where: {
          organizationId,
          action: consumedAction,
          changes: { path: ['approvalId'], equals: approvalId } as never,
        },
      });
      return count > 0;
    });

  const hasPriorRequired =
    deps.hasPriorRequired ??
    (async ({ organizationId, caseId, approvalCreatedAt }) => {
      const count = await deps.prisma.auditLog.count({
        where: {
          organizationId,
          entityType: targetEntityType,
          entityId: caseId,
          action: requiredAction,
          createdAt: { lt: approvalCreatedAt },
        },
      });
      return count > 0;
    });

  return {
    async verify(query: ActionGuardApprovalQuery): Promise<ActionGuardApprovalDecision> {
      const targetRef = str(query.targetRef);
      if (!targetRef) return { valid: false, reason: 'APPROVAL_TARGET_MISMATCH' };
      if (!str(query.approvalId)) return { valid: false, reason: 'APPROVAL_NOT_FOUND' };

      let event: ApprovalEventRow | null;
      try {
        event = await readApprovalEvent({ organizationId: query.organizationId, approvalId: query.approvalId });
      } catch {
        return { valid: false, reason: 'APPROVAL_SOURCE_ERROR' };
      }
      if (!event) return { valid: false, reason: 'APPROVAL_NOT_FOUND' };
      if (event.entityType !== targetEntityType || str(event.entityId) !== targetRef) {
        return { valid: false, reason: 'APPROVAL_TARGET_MISMATCH' };
      }

      let targetTenant: string | null;
      try {
        targetTenant = await resolveTargetTenant({ targetRef });
      } catch {
        return { valid: false, reason: 'APPROVAL_SOURCE_ERROR' };
      }
      if (!targetTenant) return { valid: false, reason: 'APPROVAL_TARGET_MISMATCH' };
      if (targetTenant !== query.organizationId) return { valid: false, reason: 'APPROVAL_TENANT_MISMATCH' };

      // 动作绑定
      const boundAction = boundActionOf(event.changes);
      if (!boundAction || boundAction !== query.action) return { valid: false, reason: 'APPROVAL_ACTION_MISMATCH' };

      const approverUserId = str(event.actorUserId);
      if (!approverUserId) return { valid: false, reason: 'APPROVAL_ACTOR_MISMATCH' };

      let approverRole: string | null;
      let executorRole: string | null;
      try {
        approverRole = await resolveMemberRole({ organizationId: query.organizationId, actorUserId: approverUserId });
        executorRole = await resolveMemberRole({ organizationId: query.organizationId, actorUserId: query.actorUserId });
      } catch {
        return { valid: false, reason: 'APPROVAL_SOURCE_ERROR' };
      }
      if (!approverRole || !(APPROVAL_ACTOR_ROLES as readonly string[]).includes(approverRole)) {
        return { valid: false, reason: 'APPROVAL_ACTOR_MISMATCH' };
      }
      if (!executorRole || !(EXECUTOR_ROLES as readonly string[]).includes(executorRole)) {
        return { valid: false, reason: 'APPROVAL_ACTOR_MISMATCH' };
      }

      // 载荷绑定
      const bound = boundPayloadOf(event.changes);
      if (!bound) return { valid: false, reason: 'APPROVAL_PAYLOAD_MISMATCH' };
      // R3 CHANGE A：读取时校验指纹版本（缺失或未知一律拒绝）
      if (bound.fingerprintVersion !== 'v1') return { valid: false, reason: 'APPROVAL_VERSION_UNSUPPORTED' };
      const submitted = normalizeBoundPayload(query.payload);
      if (!submitted) return { valid: false, reason: 'APPROVAL_PAYLOAD_MISMATCH' };
      for (const key of ['amount', 'currency', 'basisReference', 'evidenceArtifactId']) {
        if ((bound[key] ?? null) !== (submitted[key] ?? null)) {
          return { valid: false, reason: 'APPROVAL_PAYLOAD_MISMATCH' };
        }
      }

      // 轮次 / 有效期 / 撤销 / 消费
      try {
        if (!(await hasPriorRequired({ organizationId: query.organizationId, caseId: targetRef, approvalCreatedAt: event.createdAt }))) {
          return { valid: false, reason: 'APPROVAL_NOT_APPROVED' };
        }
        if (await hasLaterRevocation({ organizationId: query.organizationId, caseId: targetRef, approvalCreatedAt: event.createdAt })) {
          return { valid: false, reason: 'APPROVAL_REVOKED' };
        }

        const expiresAt = expiresAtOf(event.changes);
        if (!expiresAt) return { valid: false, reason: 'APPROVAL_SOURCE_ERROR' };
        const at = query.now ? new Date(query.now) : now();
        if (at.getTime() >= expiresAt.getTime()) return { valid: false, reason: 'APPROVAL_EXPIRED' };
        // R2 CHANGE B2：审批之后若出现新的 REQUEST（新一轮），旧审批失效
        const superseded = await deps.prisma.auditLog.count({
          where: {
            organizationId: query.organizationId,
            entityType: 'Case',
            entityId: targetRef,
            action: APPROVAL_REQUIRED_EVENT_ACTION,
            createdAt: { gt: event.createdAt },
          },
        });
        if (superseded > 0) return { valid: false, reason: 'APPROVAL_NOT_APPROVED' };
        if (await isConsumed({ organizationId: query.organizationId, approvalId: query.approvalId })) {
          // R2 CHANGE B2：同审批、同载荷、策略与权限仍满足 → 允许进入幂等返回既有结果分支；
          // 消费/风险审计仍会记录，且业务层不会再次创建资金对象。
          return { valid: true, consumed: true };
        }
      } catch {
        return { valid: false, reason: 'APPROVAL_SOURCE_ERROR' };
      }

      return { valid: true };
    },
  };
}
