/**
 * platform.write 编排（② 下一小批次 · MSG-20261001-16 NEXT）
 * ---------------------------------------------------------------
 * 顺序（fail-closed，任何一步不满足都不投递）：
 *   1) 幂等键自证（显式给定必须与服务端派生一致）
 *   2) Action Guard（纯函数；platform.write = EXTERNAL_WRITE，需 humanApproval +
 *      platformEnablement + productionGate + writeEnabled）
 *   3) 审批绑定核验（租户 / 动作 / 未消费 / 未过期 / basisReference === 服务端快照摘要）
 *   4) 幂等账本（同键同摘要重放直接返回既有结果；同键不同摘要 → 冲突拒绝）
 *   5) 传输闸门：Phase 1 恒关 → NEEDS_MANUAL，零投递、零状态推进、不消费审批
 *   6) 仅当显式允许且端口 simulated === true 时才跑状态机（模拟通道）
 *
 * 本模块不读 env、不读凭据、不发网络请求、不写数据库；真实外写不因本批次获得授权。
 */

import type { ActionGuardInput, ActionGuardResult } from '../action-guard/action-guard';

import { assertTransition, nextStateAfterOutcome } from './state-machine';
import { buildPlatformWriteSnapshot, deriveIdempotencyKey, snapshotDigest } from './snapshot';
import {
  PLATFORM_WRITE_ACTION,
  PLATFORM_WRITE_MAX_ATTEMPTS,
  PlatformWriteError,
  assertPlatformWriteAuditEvent,
  type PlatformWriteApprovalPort,
  type PlatformWriteAttemptState,
  type PlatformWriteAuditEventType,
  type PlatformWriteLedger,
  type PlatformWriteLedgerEntry,
  type PlatformWritePort,
  type PlatformWriteRequest,
  type PlatformWriteResult,
  type PlatformWriteStatus,
} from './types';

export interface PlatformWriteDeps {
  /** Action Guard 决策函数（纯函数；生产接线使用 evaluateActionGuard） */
  guard(input: ActionGuardInput): ActionGuardResult;
  approvals: PlatformWriteApprovalPort;
  ledger: PlatformWriteLedger;
  sink: PlatformWritePort;
  /** 能力闸门快照；缺失视为不可用 → DENY（fail closed） */
  capabilities?: ActionGuardInput['capabilities'];
  audit?(event: ReturnType<typeof assertPlatformWriteAuditEvent>): Promise<void>;
  now?(): Date;
  /**
   * 仅用于测试模拟通道：必须与 simulated === true 的端口同时出现；
   * 真实通道无法借此启用（省略即 Phase 1 行为：NEEDS_MANUAL）。
   */
  simulatedTransport?: boolean;
}

export async function executePlatformWrite(
  request: PlatformWriteRequest,
  deps: PlatformWriteDeps,
): Promise<PlatformWriteResult> {
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const nowIso = new Date(nowMs).toISOString();

  const snapshot = buildPlatformWriteSnapshot({
    organizationId: request.organizationId,
    caseId: request.caseId,
    targetKind: request.targetKind,
    targetId: request.targetId,
    platform: request.platform,
    payload: request.payload,
  });
  const digest = snapshotDigest(snapshot);
  const idempotencyKey = deriveIdempotencyKey(digest);
  const transportEnabled = deps.simulatedTransport === true;

  const base = {
    organizationId: snapshot.organizationId,
    caseId: snapshot.caseId,
    targetKind: snapshot.targetKind,
    targetId: snapshot.targetId,
    platform: snapshot.platform,
    snapshotVersion: snapshot.version,
    snapshotDigest: digest,
    idempotencyKey,
    transportEnabled,
  };

  const emit = async (
    type: PlatformWriteAuditEventType,
    state: PlatformWriteAttemptState,
    attempts: number,
    code: string,
    externalRef: string | null,
  ): Promise<void> => {
    if (!deps.audit) return;
    await deps.audit(
      assertPlatformWriteAuditEvent({
        type,
        action: PLATFORM_WRITE_ACTION,
        organizationId: base.organizationId,
        caseId: base.caseId,
        targetKind: base.targetKind,
        targetId: base.targetId,
        platform: base.platform,
        snapshotVersion: base.snapshotVersion,
        snapshotDigest: digest,
        idempotencyKey,
        state,
        attempts,
        code,
        externalRef,
        transportEnabled,
      }),
    );
  };

  const blocked = async (code: string, reasons: string[], attempts = 0): Promise<PlatformWriteResult> => {
    await emit('platform.write.blocked', 'BLOCKED', attempts, code, null);
    return {
      status: 'BLOCKED',
      code,
      reasons,
      state: 'BLOCKED',
      attempts,
      sinkCalls: 0,
      ...base,
    };
  };

  // 1) 幂等键自证
  if (request.idempotencyKey && request.idempotencyKey !== idempotencyKey) {
    return blocked('IDEMPOTENCY_KEY_MISMATCH', ['显式幂等键与服务端派生结果不一致（fail closed）']);
  }

  // 2) Action Guard
  const guardResult = deps.guard({
    action: PLATFORM_WRITE_ACTION,
    actorUserId: request.actorUserId,
    organizationId: snapshot.organizationId,
    capabilities: deps.capabilities,
    approvalId: request.approvalId,
  });
  if (guardResult.decision !== 'ALLOW') {
    return blocked(guardResult.code, guardResult.reasons);
  }

  // 3) 审批绑定
  const approval = request.approvalId ? await deps.approvals.get(request.approvalId) : null;
  if (!approval) return blocked('APPROVAL_NOT_FOUND', ['审批不存在或不可读']);
  if (approval.action !== PLATFORM_WRITE_ACTION) {
    return blocked('APPROVAL_ACTION_MISMATCH', ['审批动作不是 platform.write，不得通用']);
  }
  if (approval.organizationId !== snapshot.organizationId) {
    return blocked('APPROVAL_TENANT_MISMATCH', ['审批与请求不在同一租户']);
  }
  if (approval.consumedAt) {
    return blocked('APPROVAL_ALREADY_CONSUMED', ['审批已被消费，不能重复使用']);
  }
  if (approval.expiresAt && new Date(approval.expiresAt).getTime() <= nowMs) {
    return blocked('APPROVAL_EXPIRED', ['审批已过期']);
  }
  if (approval.basisReference !== digest) {
    return blocked('APPROVAL_BINDING_MISMATCH', [
      '审批绑定的服务端快照摘要与本次提交不一致（正文/关联对象/载荷已变化）',
    ]);
  }

  // 4) 幂等账本
  const existing = await deps.ledger.read(idempotencyKey);
  if (existing && existing.snapshotDigest !== digest) {
    return blocked('IDEMPOTENCY_CONFLICT', ['同一幂等键对应不同快照摘要，拒绝复用'], existing.attempts);
  }
  if (existing && existing.state === 'SUCCEEDED') {
    await emit(
      'platform.write.settled',
      'SUCCEEDED',
      existing.attempts,
      'PLATFORM_WRITE_REPLAYED',
      existing.externalRef ?? null,
    );
    return {
      status: 'REPLAYED',
      code: 'PLATFORM_WRITE_REPLAYED',
      reasons: ['同一幂等键已成功提交，直接返回既有结果，不重复投递'],
      state: 'SUCCEEDED',
      attempts: existing.attempts,
      sinkCalls: 0,
      externalRef: existing.externalRef,
      ...base,
    };
  }

  // 5) 传输闸门（Phase 1 恒关）
  const priorAttempts = existing?.attempts ?? 0;
  if (!transportEnabled) {
    await emit('platform.write.needs_manual', 'PENDING', priorAttempts, 'PLATFORM_WRITE_TRANSPORT_DISABLED', null);
    return {
      status: 'NEEDS_MANUAL',
      code: 'PLATFORM_WRITE_TRANSPORT_DISABLED',
      reasons: ['平台外写通道关闭：仅登记内部结果，不发起任何真实投递'],
      state: 'PENDING',
      attempts: priorAttempts,
      sinkCalls: 0,
      ...base,
    };
  }

  // 6) 只允许模拟通道
  if (deps.sink.simulated !== true) {
    throw new PlatformWriteError(
      'SIMULATED_SINK_REQUIRED',
      '只有 simulated === true 的模拟通道可以被启用；真实写入通道不得接线（需架构方新裁决）',
    );
  }

  let state: PlatformWriteAttemptState = 'PENDING';
  let attempts = priorAttempts;
  let code = 'PLATFORM_WRITE_ATTEMPTED';
  let externalRef: string | undefined;
  let sinkCalls = 0;

  assertTransition(state, 'IN_FLIGHT');
  state = 'IN_FLIGHT';
  await emit('platform.write.attempted', state, attempts, code, null);

  for (;;) {
    attempts += 1;
    sinkCalls += 1;
    const outcome = await deps.sink.submit({
      organizationId: base.organizationId,
      caseId: base.caseId,
      targetKind: base.targetKind,
      targetId: base.targetId,
      platform: base.platform,
      idempotencyKey,
      snapshotDigest: digest,
      payload: request.payload,
    });

    const outcomeState = nextStateAfterOutcome(outcome, attempts, PLATFORM_WRITE_MAX_ATTEMPTS);
    const immediateState: PlatformWriteAttemptState = outcomeState === 'DEAD_LETTER' ? 'RETRYABLE' : outcomeState;
    assertTransition(state, immediateState);
    state = immediateState;

    if (outcome.status === 'SUCCEEDED') {
      externalRef = outcome.externalRef;
      code = 'PLATFORM_WRITE_SIMULATED_SUCCEEDED';
      break;
    }
    if (outcome.status === 'REJECTED') {
      code = outcome.code || 'PLATFORM_WRITE_REJECTED';
      break;
    }
    code = outcome.code || 'PLATFORM_WRITE_RETRYABLE';
    if (outcomeState === 'DEAD_LETTER') {
      assertTransition(state, 'DEAD_LETTER');
      state = 'DEAD_LETTER';
      break;
    }
    assertTransition(state, 'IN_FLIGHT');
    state = 'IN_FLIGHT';
    await emit('platform.write.attempted', state, attempts, code, null);
  }

  const entry: PlatformWriteLedgerEntry = {
    key: idempotencyKey,
    snapshotDigest: digest,
    state,
    attempts,
    code,
    updatedAt: nowIso,
  };
  if (externalRef) entry.externalRef = externalRef;
  await deps.ledger.write(entry);

  const status: PlatformWriteStatus =
    state === 'SUCCEEDED' ? 'SUCCEEDED' : state === 'FAILED' ? 'FAILED' : 'DEAD_LETTER';
  const reasons =
    state === 'SUCCEEDED'
      ? ['模拟通道投递成功（未触达任何真实平台）']
      : state === 'FAILED'
        ? ['上游硬拒绝，不重试']
        : ['可重试失败达到上限 ' + String(PLATFORM_WRITE_MAX_ATTEMPTS) + '，转入 DEAD_LETTER 等待人工处置'];

  await emit('platform.write.settled', state, attempts, code, externalRef ?? null);
  return { status, code, reasons, state, attempts, sinkCalls, externalRef, ...base };
}

export * from './types';
export * from './snapshot';
export * from './state-machine';
export * from './ledger';
export * from './simulated-adapter';
export * from './reconcile-policy';
