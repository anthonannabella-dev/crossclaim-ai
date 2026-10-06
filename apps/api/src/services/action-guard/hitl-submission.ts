/**
 * HITL SUBMISSION BOUNDARY（授权项 ② 第一批；MSG-20260930-16 §6）
 * ---------------------------------------------------------------
 * 把「受保护业务动作的提交」收敛到一个边界函数：service / route / job 都通过它进入，
 * 从而同时满足冻结的四条要求：
 *   1) 服务端审批绑定验证（HITL 复核状态 + 租户 + 目标对象）；
 *   2) DENY / REQUIRE_APPROVAL / 能力异常 / 审批异常 / 审计异常 → **零业务副作用**（perform 不被调用）；
 *   3) ALLOW 且审批校验通过 → **恰好执行一次**；
 *   4) 每次提交都重新核验（不缓存 ALLOW；重试同样重新校验审批与闸门）。
 *
 * 说明：
 *   - 边界只负责「是否允许进入业务」，真实业务动作仍由调用方以 `perform` 传入（本模块不写库）；
 *   - 审批校验端口默认使用审计派生的 HITL 复核状态（createHitlApprovalVerifier）；
 *   - 未提供 guard 或 approvals 时一律失败（不允许"无守卫直接执行"）。
 */

import type { PrismaClient } from '@prisma/client';

import type { ActionGuardInput, ActionGuardResult } from './action-guard';
import { withActionGuard } from './guard-enforcement';
import { createHitlApprovalVerifier, type HitlApprovalVerifierDeps } from './hitl-approval-verifier';
import type { ActionGuardApprovalVerifier } from './approval-verifier';
import type { ActionGuardAuditPort } from './runtime-guard';
import type { RuntimeActionGuard } from './runtime-guard';

export interface HitlSubmissionBoundaryDeps {
  guard: RuntimeActionGuard;
  prisma: PrismaClient;
  /** 覆盖默认的复核状态读取（测试或其它 HITL 通道） */
  approvalVerifier?: HitlApprovalVerifierDeps;
  /** 直接注入审批校验器（单元测试用；优先于 approvalVerifier） */
  approvals?: ActionGuardApprovalVerifier;
  /** CHANGE D：审批核验结果审计端口（生产装配写入 action_guard.approval_decision） */
  audit?: ActionGuardAuditPort;
}

export interface HitlSubmissionInput<T> {
  action: string;
  organizationId: string;
  actorUserId: string;
  /** 目标对象 / 证据版本（本批以 caseId 作为审批绑定目标） */
  targetRef: string;
  approvalId?: string;
  /** 操作关联标识（缺省由 approvalId 推导） */
  operationId?: string;
  /** 本次提交的操作载荷（金额/币种/依据/证据），用于与审批绑定逐项比对 */
  payload?: {
    recoveredAmount?: unknown;
    currency?: unknown;
    basisReference?: unknown;
    evidenceArtifactId?: unknown;
  };
  /** SA-3b: optional standing-authorization alternative (wiring-layer decision only). */
  standingAuthorization?: {
    decision: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
    authorizedBy: 'ONE_TIME_APPROVAL' | 'STANDING_AUTHORIZATION' | 'NONE';
    satisfiedGates: readonly string[];
    action: string;
  } | null;
  /** 真实业务动作；仅在守卫与审批校验全部通过后调用一次 */
  perform: (decision: ActionGuardResult) => Promise<T> | T;
}

export interface HitlSubmissionBoundary {
  submit<T>(input: HitlSubmissionInput<T>): Promise<T>;
}

export function createHitlSubmissionBoundary(deps: HitlSubmissionBoundaryDeps): HitlSubmissionBoundary {
  if (!deps?.guard) throw new Error('HITL_SUBMISSION_MISSING_GUARD');
  if (!deps?.prisma && !deps?.approvalVerifier && !deps?.approvals) {
    throw new Error('HITL_SUBMISSION_MISSING_APPROVAL_SOURCE');
  }

  const approvals =
    deps.approvals ??
    (deps.approvalVerifier !== undefined
      ? createHitlApprovalVerifier({ ...deps.approvalVerifier, prisma: deps.prisma })
      : createHitlApprovalVerifier({ prisma: deps.prisma }));

  return {
    async submit<T>(input: HitlSubmissionInput<T>) {
      const guardInput: ActionGuardInput = {
        action: input.action,
        actorUserId: input.actorUserId,
        organizationId: input.organizationId,
        approvalId: input.approvalId,
      };
      return withActionGuard({
        guard: deps.guard,
        input: guardInput,
        standingAuthorization: input.standingAuthorization ?? null,
        approvals,
        approvalTargetRef: input.targetRef,
        approvalPayload: input.payload,
        operationId: input.operationId ?? (input.approvalId ? `approval:${input.approvalId}` : undefined),
        audit: deps.audit,
        work: input.perform,
      });
    },
  };
}
