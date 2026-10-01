/**
 * platform.write 审批端口（事务内重验 + 同事务消费事实）
 * ---------------------------------------------------------------
 * 依据 MSG-20261001-19 CHANGE B（T1 = 原子授权点）与 MSG-20261001-22 §1：
 *   · 核验与消费都必须使用**同一个事务客户端**（tx），与 attempt 的落库同生共死；
 *   · 核验口径复用既有 verifyApprovalBoundary（审批事件族 / 目标 / 载荷指纹 / 有效期 / 撤销 / 轮次）；
 *   · 消费事实写 `recovery.approval_consumed`（含 approvalId / attemptId / boundAction），
 *     是 T1 的同事务产物，不是事后补审计；
 *   · 本模块不读 env、不读凭据、不发网络请求。
 */

import type { Prisma } from '@prisma/client';

import { PLATFORM_WRITE_ACTION } from '../action-guard/approval-verifier';
import {
  APPROVAL_CONSUMED_EVENT_ACTION,
  verifyApprovalBoundary,
} from '../action-guard/approval-tx-verify';
import { prepareAuditInsert } from '../audit';
import type { PlatformWriteApprovalInTxPort } from './prisma-ledger';

/** 事务内审批端口：prisma 客户端由 T1 事务直接传入，因此无需持有连接 */
export function createPrismaPlatformWriteApprovalInTxPort(): PlatformWriteApprovalInTxPort {
  return {
    async verifyInTransaction(tx, args) {
      const result = await verifyApprovalBoundary(tx as Prisma.TransactionClient, {
        organizationId: args.organizationId,
        approvalId: args.approvalId,
        // 绑定动作恒为 platform.write（审批创建时的 boundAction）；
        // args.action 是**审批事件族**（默认 recovery.review_approved），两者语义不同。
        action: PLATFORM_WRITE_ACTION,
        caseId: args.caseId,
        actorUserId: args.actorUserId,
        // platform.write 无金额语义：只绑定服务端快照摘要（与审批创建时的规范化载荷逐项一致）
        payload: {
          amount: null,
          currency: null,
          basisReference: args.snapshotDigest,
          evidenceArtifactId: null,
        },
        now: args.now,
        approvalEventAction: args.action,
      });
      if (!result.ok) {
        return {
          ok: false,
          code: 'PLATFORM_WRITE_APPROVAL_INVALID',
          message: 'platform.write 审批未通过：' + result.reason,
        };
      }
      return { ok: true };
    },

    async consumeInTransaction(tx, args) {
      const row = prepareAuditInsert(
        {
          organizationId: args.organizationId,
          actorType: 'USER',
          actorUserId: args.actorUserId,
          action: APPROVAL_CONSUMED_EVENT_ACTION,
          entityType: 'PlatformWriteAttempt',
          entityId: args.attemptId,
          changes: {
            approvalId: args.approvalId,
            attemptId: args.attemptId,
            boundAction: PLATFORM_WRITE_ACTION,
          },
        },
        { now: () => args.consumedAt },
      );
      await tx.auditLog.create({
        data: {
          organizationId: row.organizationId,
          actorType: row.actorType,
          actorUserId: row.actorUserId,
          actorRef: row.actorRef,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          changes: (row.changes ?? undefined) as Prisma.InputJsonValue | undefined,
          ip: row.ip,
          userAgent: row.userAgent,
        },
      });
    },
  };
}
