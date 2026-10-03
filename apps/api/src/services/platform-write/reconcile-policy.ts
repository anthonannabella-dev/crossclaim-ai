/**
 * UNKNOWN_PROVIDER_RESPONSE 的对账策略（MSG-20261001-18 裁决④ / MSG-20261001-19 CHANGE C）
 * ---------------------------------------------------------------
 * 纪律：
 *   · UNKNOWN / RECONCILING 期间**绝不重新发送原始写请求**（本模块只做只读判定，不含任何 sink 调用）；
 *   · FAILED_CONFIRMED **只能**来自可信 provider 证据（明确终态失败 / 确认未产生目标副作用）；
 *     timeout、404/查询不到、次数耗尽、24h 到期一律 → MANUAL_REVIEW；
 *   · 退避 1 / 5 / 15 / 60 分钟，最长自动对账窗口 24 小时（系统默认值，可按 provider 覆盖）。
 */

import { PlatformWriteError, type PlatformWriteAttemptState } from './types';

/** 自动对账退避（分钟） */
export const RECONCILE_BACKOFF_MINUTES: readonly number[] = [1, 5, 15, 60];

/** 最长自动对账窗口（分钟） */
export const RECONCILE_WINDOW_MINUTES = 24 * 60;

export type ReconcileEvidence =
  /** 可信证据：provider 明确返回终态失败，或确认该写操作未产生目标外部副作用 */
  | { kind: 'CONFIRMED_NOT_APPLIED'; providerRef?: string | null; detail?: string }
  /** 可信证据：provider 确认已成功（含幂等命中） */
  | { kind: 'CONFIRMED_SUCCEEDED'; providerRef: string }
  /** 不确定：超时 / 404 / 查询失败 / 无稳定只读接口 */
  | { kind: 'INCONCLUSIVE'; detail?: string };

export interface ReconcileDecision {
  nextStatus: PlatformWriteAttemptState;
  reconciledStatus: 'CONFIRMED_SUCCEEDED' | 'CONFIRMED_FAILED' | 'INCONCLUSIVE' | null;
  /** 下一次自动对账时间（分钟）；null = 不再自动对账 */
  nextDelayMinutes: number | null;
  reason: string;
  /** 该判定是否允许自动推进（false = 交人工 MANUAL_REVIEW） */
  automated: boolean;
}

/** 第 n 次（1-based）自动对账的退避分钟数；超过退避表则用最后一档 */
export function reconcileBackoffMinutes(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new PlatformWriteError('RECONCILE_ATTEMPT_INVALID', 'attempt 必须是 >= 1 的整数');
  }
  const table = RECONCILE_BACKOFF_MINUTES;
  return attempt <= table.length ? table[attempt - 1]! : table[table.length - 1]!;
}

/**
 * 对账判定（纯函数）：
 *   · 只有 CONFIRMED_SUCCEEDED / CONFIRMED_NOT_APPLIED 才能自动收敛；
 *   · INCONCLUSIVE 在规定窗口内保持 RECONCILING（按退避重试只读查询），超窗或次数耗尽 → MANUAL_REVIEW。
 */
export function decideReconciliation(input: {
  evidence: ReconcileEvidence;
  /** 已经历的自动对账次数（本函数调用前） */
  reconcileAttempts: number;
  /** 自首次进入 UNKNOWN 起经过的分钟数 */
  elapsedMinutes: number;
}): ReconcileDecision {
  const { evidence } = input;
  const attempts = Number.isInteger(input.reconcileAttempts) && input.reconcileAttempts >= 0 ? input.reconcileAttempts : 0;
  const elapsed = Number.isFinite(input.elapsedMinutes) && input.elapsedMinutes >= 0 ? input.elapsedMinutes : 0;

  if (evidence.kind === 'CONFIRMED_SUCCEEDED') {
    return {
      nextStatus: 'SUCCEEDED',
      reconciledStatus: 'CONFIRMED_SUCCEEDED',
      nextDelayMinutes: null,
      reason: 'provider 确认已成功（含幂等命中）',
      automated: true,
    };
  }

  if (evidence.kind === 'CONFIRMED_NOT_APPLIED') {
    return {
      nextStatus: 'FAILED_CONFIRMED',
      reconciledStatus: 'CONFIRMED_FAILED',
      nextDelayMinutes: null,
      reason: evidence.detail ?? 'provider 可信证据确认未产生目标外部副作用',
      automated: true,
    };
  }

  // INCONCLUSIVE：绝不据此判定失败
  const overWindow = elapsed >= RECONCILE_WINDOW_MINUTES;
  const exhausted = attempts >= RECONCILE_BACKOFF_MINUTES.length;
  if (overWindow || exhausted) {
    return {
      nextStatus: 'MANUAL_REVIEW',
      reconciledStatus: 'INCONCLUSIVE',
      nextDelayMinutes: null,
      reason: overWindow ? '超过 24 小时自动对账窗口，交人工处置' : '对账次数耗尽，交人工处置',
      automated: false,
    };
  }

  return {
    nextStatus: 'RECONCILING',
    reconciledStatus: 'INCONCLUSIVE',
    nextDelayMinutes: reconcileBackoffMinutes(attempts + 1),
    reason: evidence.detail ?? '证据不确定：保持只读对账（绝不重发写请求）',
    automated: false,
  };
}

/** 状态守卫：UNKNOWN / RECONCILING 之外不得调用对账策略 */
export function assertReconcilable(status: PlatformWriteAttemptState): void {
  if (status !== 'UNKNOWN_PROVIDER_RESPONSE' && status !== 'RECONCILING') {
    throw new PlatformWriteError(
      'RECONCILE_STATE_INVALID',
      '只有 UNKNOWN_PROVIDER_RESPONSE / RECONCILING 状态可以进入对账，当前=' + status,
    );
  }
}
