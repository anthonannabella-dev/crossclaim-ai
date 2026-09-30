/**
 * HITL 审批验证器（授权项 ② 第一批；MSG-20260930-16 §6「服务端审批绑定验证」）
 * --------------------------------------------------------------------------
 * 把既有 **审计派生的人工复核状态**（services/workflow/recovery-review.ts：recovery.review_required /
 * approved / rejected，entityType=Case、entityId=caseId、按租户隔离）接到 Action Guard 的审批校验端口上：
 *
 *   审批 = 「针对该租户 + 该目标对象（caseId）+ 该动作」的最新复核状态为 APPROVED
 *
 * 绑定校验（缺一不可）：
 *   - 目标对象（targetRef）必须提供，否则 APPROVAL_TARGET_MISMATCH；
 *   - 目标必须属于该租户（跨租户 caseId → APPROVAL_TENANT_MISMATCH）；
 *   - 状态 PENDING → APPROVAL_NOT_APPROVED；REJECTED → APPROVAL_REJECTED；无记录 → APPROVAL_NOT_FOUND；
 *   - 动作 → 要求状态由 `requiredStateForAction` 决定（默认：所有受保护动作都要求 APPROVED）。
 *
 * 口径控制：本模块只做**只读**状态判定，不写库、不发请求；真实审批写入仍由既有 HITL 流程负责。
 */

import type { PrismaClient } from '@prisma/client';

import { getRecoveryReviewStatus } from '../workflow/recovery-review';
import type {
  ActionGuardApprovalDecision,
  ActionGuardApprovalQuery,
  ActionGuardApprovalVerifier,
} from './approval-verifier';

export type HitlReviewState = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface HitlApprovalVerifierDeps {
  prisma: PrismaClient;
  /** 读取指定租户 + 目标对象的复核状态（默认复用审计派生实现） */
  readReviewState?: (args: { organizationId: string; targetRef: string }) => Promise<HitlReviewState>;
  /** 该动作要求的复核状态（默认全部要求 APPROVED） */
  requiredStateForAction?: (action: string) => HitlReviewState;
}

export function createHitlApprovalVerifier(deps: HitlApprovalVerifierDeps): ActionGuardApprovalVerifier {
  if (!deps?.prisma && !deps?.readReviewState) throw new Error('HITL_VERIFIER_MISSING_REVIEW_STATE_SOURCE');

  const readState =
    deps.readReviewState ??
    (async ({ organizationId, targetRef }) => {
      const status = await getRecoveryReviewStatus(deps.prisma, { organizationId, role: 'OWNER' }, targetRef);
      return status.state as HitlReviewState;
    });

  return {
    async verify(query: ActionGuardApprovalQuery): Promise<ActionGuardApprovalDecision> {
      const targetRef = query.targetRef?.trim();
      if (!targetRef) {
        return { valid: false, reason: 'APPROVAL_TARGET_MISMATCH' };
      }

      let state: HitlReviewState;
      try {
        state = await readState({ organizationId: query.organizationId, targetRef });
      } catch {
        // 目标不存在或不属于该租户（getRecoveryReviewStatus 会抛 NOT_FOUND）
        return { valid: false, reason: 'APPROVAL_TENANT_MISMATCH' };
      }

      const required = deps.requiredStateForAction?.(query.action) ?? 'APPROVED';
      if (required === 'NOT_REQUIRED') {
        return { valid: true };
      }
      if (state === 'APPROVED') {
        return { valid: true };
      }
      if (state === 'REJECTED') {
        return { valid: false, reason: 'APPROVAL_REJECTED' };
      }
      if (state === 'PENDING') {
        return { valid: false, reason: 'APPROVAL_NOT_APPROVED' };
      }
      return { valid: false, reason: 'APPROVAL_NOT_FOUND' };
    },
  };
}
