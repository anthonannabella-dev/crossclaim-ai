/**
 * platform.write 编排（T1 → T2 → T3；R37 P3）
 * ---------------------------------------------------------------
 * 顺序强制（与 docs/releases/INTEGRATION-BOUNDARY-REVIEW-PLAN.md §5 一致）：
 *   守卫（调用方已完成）→ 快照/审批绑定（调用方已完成）→ T1（数据库短事务，执行权 + 消费）
 *   → T2（事务外投递，仅当 transport 双重门控放行）→ T3（独立事务收敛）。
 *
 * 关键纪律：
 *   · transport 双重门控（global gate + adapter 能力 + 授权有效）任一不满足 → 只返回 NEEDS_MANUAL，
 *     **零投递、零账本写入、不消费审批**（绝不把「未放行」写成一条已消费的执行链）；
 *   · T1 只有在真实 transport 被放行时才执行；执行权与审批消费同事务（消费即事务事实）；
 *   · T2 结果不可判定（超时 / 连接中断）→ UNKNOWN_PROVIDER_RESPONSE，**禁止重发写请求**；
 *   · 本模块不读 env、不读凭据、不直接发起网络调用（投递端口由调用方注入且必须 simulated）。
 */

import type { PrismaClient } from '@prisma/client';

import { evaluateTransportGate, type TransportGateDecision } from './adapter-capability';
import { acquireExecutionRight, settleAttempt, type PlatformWriteApprovalInTxPort } from './prisma-ledger';
import { PLATFORM_WRITE_ACTION, type PlatformWriteAttemptState, type PlatformWritePort, type PlatformWriteTargetKind } from './types';

export interface PlatformWriteAttemptInput {
  organizationId: string;
  caseId: string;
  targetKind: PlatformWriteTargetKind;
  targetId: string;
  platform: string;
  snapshotVersion: string;
  snapshotDigest: string;
  idempotencyKey: string;
  actorUserId: string;
  approvalId?: string | null;
  approvalAction?: string;
  now?: () => Date;
}

export interface PlatformWriteOrchestrationResult {
  status:
    | 'NEEDS_MANUAL'
    | 'SUCCEEDED'
    | 'REPLAYED'
    | 'FAILED'
    | 'RETRYABLE'
    | 'UNKNOWN_PROVIDER_RESPONSE';
  attemptId: string | null;
  /** 内部使用：上游引用；HTTP 响应契约不得输出该字段 */
  providerRef: string | null;
  sinkCalls: number;
  gate: TransportGateDecision;
  code?: string | null;
}

export interface PlatformWriteOrchestrationDeps {
  approvals: PlatformWriteApprovalInTxPort;
  /** 投递端口；缺省 = 不可投递（fail-closed，仍返回 NEEDS_MANUAL） */
  sink?: PlatformWritePort | null;
  /** 仅组合根 / 测试可覆盖；生产默认取硬开关（恒 false） */
  globalTransportEnabled?: boolean;
  /** 守卫（platform.write）ALLOW 才为 true；任何其它值一律 fail-closed */
  authorizationValid: boolean;
}

/** 既有执行链的状态 → 本次调用结论（重放绝不产生第二次投递） */
function replayStatusOf(state: PlatformWriteAttemptState): PlatformWriteOrchestrationResult['status'] {
  switch (state) {
    case 'SUCCEEDED':
      return 'REPLAYED';
    case 'MANUAL_REVIEW':
    case 'BLOCKED':
      return 'NEEDS_MANUAL';
    case 'FAILED':
    case 'FAILED_CONFIRMED':
    case 'DEAD_LETTER':
      return 'FAILED';
    case 'UNKNOWN_PROVIDER_RESPONSE':
    case 'RECONCILING':
    case 'IN_FLIGHT':
      return 'UNKNOWN_PROVIDER_RESPONSE';
    default:
      return 'RETRYABLE';
  }
}

function needsManual(
  gate: TransportGateDecision,
  code: string,
): PlatformWriteOrchestrationResult {
  return { status: 'NEEDS_MANUAL', attemptId: null, providerRef: null, sinkCalls: 0, gate, code };
}

/**
 * 一次平台写尝试的编排。返回 NEEDS_MANUAL 时保证：零投递、零账本写入、不消费审批。
 */
export async function runPlatformWriteAttempt(
  prisma: PrismaClient,
  deps: PlatformWriteOrchestrationDeps,
  input: PlatformWriteAttemptInput,
): Promise<PlatformWriteOrchestrationResult> {
  const gate = evaluateTransportGate({
    platform: input.platform,
    authorizationValid: deps.authorizationValid === true,
    ...(deps.globalTransportEnabled !== undefined
      ? { globalTransportEnabled: deps.globalTransportEnabled }
      : {}),
  });
  if (!gate.transportAllowed) {
    return needsManual(gate, gate.reason);
  }
  if (!deps.sink) {
    return needsManual(gate, 'PLATFORM_WRITE_SINK_UNAVAILABLE');
  }
  if (!input.approvalId) {
    // 真实通道必须有审批（T1 亦会拒绝，这里给出稳定原因码且不进入事务）
    return needsManual(gate, 'PLATFORM_WRITE_APPROVAL_REQUIRED');
  }

  // T1：原子授权点（唯一执行链 + 审批唯一绑定 + CAS + 同事务消费事实）
  const acquired = await acquireExecutionRight(prisma, deps.approvals, {
    organizationId: input.organizationId,
    action: PLATFORM_WRITE_ACTION,
    caseId: input.caseId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    platform: input.platform,
    simulated: false,
    approvalId: input.approvalId,
    ...(input.approvalAction ? { approvalAction: input.approvalAction } : {}),
    snapshotVersion: input.snapshotVersion,
    snapshotDigest: input.snapshotDigest,
    idempotencyKey: input.idempotencyKey,
    actorUserId: input.actorUserId,
    ...(input.now ? { now: input.now } : {}),
  });
  if (!acquired.acquired) {
    return {
      status: replayStatusOf(acquired.status),
      attemptId: acquired.attemptId,
      providerRef: null,
      sinkCalls: 0,
      gate,
    };
  }

  // T2：事务外投递（仅 simulated 端口可接线）
  let sinkCalls = 0;
  let outcome;
  try {
    sinkCalls += 1;
    outcome = await deps.sink.submit({
      organizationId: input.organizationId,
      caseId: input.caseId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      platform: input.platform,
      idempotencyKey: input.idempotencyKey,
      snapshotDigest: input.snapshotDigest,
      payload: {},
    });
  } catch {
    // 结果不可判定（超时 / 连接中断 / 响应无法解析）→ 禁止重发写请求，交只读对账
    await settleAttempt(prisma, {
      organizationId: input.organizationId,
      attemptId: acquired.attemptId,
      status: 'MANUAL_REVIEW' as never,
      errorCode: 'UNKNOWN_PROVIDER_RESPONSE',
      convergedReason: 'transport outcome indeterminate; read-only reconciliation required',
      now: input.now,
    } as never);
    return {
      status: 'UNKNOWN_PROVIDER_RESPONSE',
      attemptId: acquired.attemptId,
      providerRef: null,
      sinkCalls,
      gate,
      code: 'UNKNOWN_PROVIDER_RESPONSE',
    };
  }

  // T3：独立事务收敛（仅 IN_FLIGHT 可收敛）
  if (outcome.status === 'SUCCEEDED') {
    await settleAttempt(prisma, {
      organizationId: input.organizationId,
      attemptId: acquired.attemptId,
      status: 'SUCCEEDED',
      providerRef: outcome.externalRef,
      ...(input.now ? { now: input.now } : {}),
    });
    return {
      status: 'SUCCEEDED',
      attemptId: acquired.attemptId,
      providerRef: outcome.externalRef,
      sinkCalls,
      gate,
    };
  }
  if (outcome.status === 'REJECTED') {
    await settleAttempt(prisma, {
      organizationId: input.organizationId,
      attemptId: acquired.attemptId,
      status: 'FAILED',
      errorCode: outcome.code,
      ...(input.now ? { now: input.now } : {}),
    });
    return {
      status: 'FAILED',
      attemptId: acquired.attemptId,
      providerRef: null,
      sinkCalls,
      gate,
      code: outcome.code,
    };
  }

  const settledAt = (input.now ?? (() => new Date()))();
  await settleAttempt(prisma, {
    organizationId: input.organizationId,
    attemptId: acquired.attemptId,
    status: 'RETRYABLE',
    errorCode: outcome.code,
    nextRetryAt: new Date(settledAt.getTime() + 60_000),
    ...(input.now ? { now: input.now } : {}),
  });
  return {
    status: 'RETRYABLE',
    attemptId: acquired.attemptId,
    providerRef: null,
    sinkCalls,
    gate,
    code: outcome.code,
  };
}
