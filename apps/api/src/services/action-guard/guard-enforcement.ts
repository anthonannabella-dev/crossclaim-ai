/**
 * ACTION GUARD — ENFORCEMENT WRAPPER（MSG-20260930-03 授权项 ②）
 * -------------------------------------------------------------------
 * 目的：给 service / route / job runner 一个**唯一入口**来执行受保护动作，
 * 使得「忘记调用守卫」在类型与测试层面都不可行：
 *
 *   const result = await withActionGuard({ guard, input, work: async () => doTheThing() });
 *
 * 合同：
 *   1) 先 assertAllowed（DENY → 抛 ActionGuardDeniedError；缺审批 → 抛 ActionGuardApprovalRequiredError）；
 *   2) 需要人工审批的动作：ALLOW 之前还必须做**服务端审批绑定校验**（授权项 ② 冻结要求）——
 *      verifier 缺失 / 抛异常 / 校验不通过 → 抛 ActionGuardApprovalVerificationError（fail closed）；
 *   3) 只有上述全部通过才执行 work（且恰好一次）；
 *   4) 被拒时 work **绝不执行**（零副作用），并由守卫写入审计；
 *   5) 本模块不读 env、不写库、不发请求。
 */

import type { ActionGuardInput, ActionGuardResult } from './action-guard';
import type { RuntimeActionGuard } from './runtime-guard';
import {
  actionRequiresHumanApproval,
  verifyApprovalOrThrow,
  type ActionGuardApprovalVerifier,
} from './approval-verifier';

export interface WithActionGuardOptions<T> {
  guard: RuntimeActionGuard;
  input: ActionGuardInput;
  /** 仅在 ALLOW 之后执行；被拒时不会被调用 */
  work: (decision: ActionGuardResult) => Promise<T> | T;
  /** 服务端审批绑定校验端口：需要人工审批的动作必须提供 */
  approvals?: ActionGuardApprovalVerifier;
  /** 审批绑定的目标对象 / 证据版本（可选） */
  approvalTargetRef?: string;
  /** 本次提交的操作载荷（服务端会规范化后与审批绑定逐项比对） */
  approvalPayload?: {
    recoveredAmount?: unknown;
    currency?: unknown;
    basisReference?: unknown;
    evidenceArtifactId?: unknown;
  };
}

export async function withActionGuard<T>(options: WithActionGuardOptions<T>): Promise<T> {
  const { guard, input, work, approvals, approvalTargetRef, approvalPayload } = options ?? ({} as WithActionGuardOptions<T>);
  if (!guard?.assertAllowed) throw new Error('ACTION_GUARD_MISSING_RUNTIME_GUARD');
  if (typeof work !== 'function') throw new Error('ACTION_GUARD_MISSING_WORK_FUNCTION');

  const decision = await guard.assertAllowed(input);
  const action = String(input?.action ?? '');
  if (actionRequiresHumanApproval(action)) {
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
  }
  return work(decision);
}

/** 需要在 service/route/job 层显式过闸的动作（用于「不可绕过」静态检查）。 */
export const GUARD_ENFORCED_ACTIONS = [
  'claim.submit',
  'appeal.submit',
  'platform.write',
  'commission.charge',
  'payment.capture',
  'secret.rotate',
] as const;
