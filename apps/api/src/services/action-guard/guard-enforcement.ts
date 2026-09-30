/**
 * ACTION GUARD — ENFORCEMENT WRAPPER（MSG-20260930-03 授权项 ②）
 * -------------------------------------------------------------------
 * 目的：给 service / route / job runner 提供一个**统一执行助手**，让受保护动作在同一个调用点完成
 * 「先过闸、再执行」。
 *
 * CHANGE B（MSG-20260930-12）：本模块**不声称**「唯一入口 / 已不可绕过」；
 * 类型系统无法禁止调用方绕过本助手直接调用业务函数，覆盖面由业务接入清单与集成验收证明。
 *
 *   const result = await withActionGuard({ guard, input, work: async () => doTheThing() });
 *
 * 合同：
 *   1) 先 assertAllowed（DENY → 抛 ActionGuardDeniedError；缺审批 → 抛 ActionGuardApprovalRequiredError）；
 *   2) 需要人工审批的动作：ALLOW 之前还必须做**服务端审批绑定校验**（授权项 ② 冻结要求）——
 *      verifier 缺失 / 抛异常 / 校验不通过 → 抛 ActionGuardApprovalVerificationError（fail closed）；
 *   3) 只有上述全部通过才执行 work（且恰好一次）；
 *   4) 被拒时 work **绝不执行**（零业务/资金副作用；安全审计允许新增），并由守卫写入审计；
 *   5) 本模块不读 env、不写库、不发请求。
 */

import type { ActionGuardInput, ActionGuardResult } from './action-guard';
import type { RuntimeActionGuard } from './runtime-guard';
import {
  ActionGuardApprovalVerificationError,
  actionRequiresHumanApproval,
  verifyApprovalOrThrow,
  type ActionGuardApprovalVerifier,
} from './approval-verifier';
import type { ActionGuardAuditPort } from './runtime-guard';

/** 受保护入口未接入守卫（缺依赖分支）——与默认装配 READ_ONLY 是两条不同路径（CHANGE D） */
export class ActionGuardNotConfiguredError extends Error {
  readonly code = 'ACTION_GUARD_NOT_CONFIGURED';
  constructor(action: string) {
    super(`ACTION_GUARD_NOT_CONFIGURED: ${action}`);
    this.name = 'ActionGuardNotConfiguredError';
  }
}

export interface WithActionGuardOptions<T> {
  guard: RuntimeActionGuard;
  input: ActionGuardInput;
  /** 仅在 ALLOW 之后执行；被拒时不会被调用 */
  work: (decision: ActionGuardResult) => Promise<T> | T;
  /** 服务端审批绑定校验端口：需要人工审批的动作必须提供 */
  approvals?: ActionGuardApprovalVerifier;
  /** 审批绑定的目标对象 / 证据版本（可选） */
  approvalTargetRef?: string;
  /** 审批核验结果审计端口（CHANGE D）：记录 action_guard.approval_verified / approval_rejected */
  audit?: ActionGuardAuditPort;
  /** 操作关联标识（写入审计，便于与资金/消费事件对齐） */
  operationId?: string;
  /** 本次提交的操作载荷（服务端会规范化后与审批绑定逐项比对） */
  approvalPayload?: {
    recoveredAmount?: unknown;
    currency?: unknown;
    basisReference?: unknown;
    evidenceArtifactId?: unknown;
  };
}

export async function withActionGuard<T>(options: WithActionGuardOptions<T>): Promise<T> {
  const { guard, input, work, approvals, approvalTargetRef, approvalPayload, audit, operationId } =
    options ?? ({} as WithActionGuardOptions<T>);
  if (!guard?.assertAllowed) throw new Error('ACTION_GUARD_MISSING_RUNTIME_GUARD');
  if (typeof work !== 'function') throw new Error('ACTION_GUARD_MISSING_WORK_FUNCTION');

  const decision = await guard.assertAllowed(input);
  const action = String(input?.action ?? '');
  if (actionRequiresHumanApproval(action)) {
    try {
      await verifyApprovalOrThrow({
      verifier: approvals,
      query: {
        approvalId: String(input?.approvalId ?? ''),
        organizationId: String(input?.organizationId ?? ''),
        action,
        actorUserId: String(input?.actorUserId ?? ''),
        targetRef: approvalTargetRef,
        payload: approvalPayload,
      },
    });
    } catch (error) {
      const e = error as { code?: string; reason?: string };
      // CHANGE D：审批核验结果单独成一条可关联的安全审计（不记录凭据/原始载荷）。
      // R3 CHANGE D：拒绝路径的审计失败**不得覆盖原错误**（放行路径仍必须失败关闭）。
      try {
        await writeApprovalAudit(audit, {
          code: e?.code ?? 'ACTION_GUARD_APPROVAL_NOT_VERIFIED',
          action,
          organizationId: String(input?.organizationId ?? ''),
          actorUserId: String(input?.actorUserId ?? ''),
          approvalId: String(input?.approvalId ?? ''),
          targetRef: approvalTargetRef ?? null,
          operationId: operationId ?? null,
          reason: e?.reason ?? null,
        });
      } catch {
        // 审计不可用不改变拒绝判定：原始审批错误优先
      }
      throw error;
    }
    // CHANGE D：放行路径必须有可落库的审批审计；端口缺失或写入失败一律拒绝（work=0）
    if (!audit) {
      throw new ActionGuardApprovalVerificationError({
        code: 'ACTION_GUARD_APPROVAL_AUDIT_UNAVAILABLE',
        approvalId: String(input?.approvalId ?? ''),
        action,
        reason: 'AUDIT_UNAVAILABLE',
      });
    }
    await writeApprovalAudit(audit, {
      code: 'ACTION_GUARD_APPROVAL_VERIFIED',
      action,
      organizationId: String(input?.organizationId ?? ''),
      actorUserId: String(input?.actorUserId ?? ''),
      approvalId: String(input?.approvalId ?? ''),
      targetRef: approvalTargetRef ?? null,
      operationId: operationId ?? null,
      reason: null,
    });
  }
  return work(decision);
}

/**
 * 审批核验审计（CHANGE D）：结构化白名单字段（目标/操作/原因独立字段，不再混入 reasonCodes）。
 * 调用方（放行路径）负责在端口缺失或写入失败时拒绝执行；拒绝路径的审计失败不覆盖原错误。
 */
async function writeApprovalAudit(
  audit: ActionGuardAuditPort | undefined,
  fields: {
    code: string;
    action: string;
    organizationId: string;
    actorUserId: string;
    approvalId: string;
    targetRef: string | null;
    operationId: string | null;
    reason: string | null;
  },
): Promise<void> {
  if (!audit) return;
  await audit.write({
    action: 'action_guard.approval_decision',
    actionName: fields.action,
    decision: fields.code === 'ACTION_GUARD_APPROVAL_VERIFIED' ? 'ALLOW' : 'DENY',
    code: fields.code,
    risk: 'EXTERNAL_WRITE',
    actorUserId: fields.actorUserId,
    organizationId: fields.organizationId,
    approvalId: fields.approvalId || null,
    reasonCodes: fields.reason ? [fields.reason] : [],
    targetRef: fields.targetRef,
    operationId: fields.operationId,
    reason: fields.reason,
    evaluatedAt: new Date().toISOString(),
  });
}

/** 需要在 service/route/job 层显式过闸的动作（供**有限静态约定检查**与后续接入清单使用）。 */
export const GUARD_ENFORCED_ACTIONS = [
  'claim.submit',
  'appeal.submit',
  'platform.write',
  'commission.charge',
  'payment.capture',
  'secret.rotate',
] as const;
