/**
 * 投递尝试状态机（纯函数）
 * ---------------------------------------------------------------
 * PENDING → IN_FLIGHT → SUCCEEDED | RETRYABLE | FAILED
 * RETRYABLE → IN_FLIGHT（重试）| DEAD_LETTER（超过上限）
 * BLOCKED 只能从 PENDING 进入（fail-closed 拒绝路径，永不投递）
 * 未经允许的迁移一律抛 ILLEGAL_TRANSITION，不静默兜底。
 */

import {
  PLATFORM_WRITE_MAX_ATTEMPTS,
  PLATFORM_WRITE_TERMINAL_STATES,
  PlatformWriteError,
  type PlatformWriteAttemptState,
  type PlatformWritePortOutcome,
} from './types';

const TRANSITIONS: Record<PlatformWriteAttemptState, readonly PlatformWriteAttemptState[]> = {
  PENDING: ['IN_FLIGHT', 'BLOCKED'],
  IN_FLIGHT: ['SUCCEEDED', 'RETRYABLE', 'FAILED'],
  RETRYABLE: ['IN_FLIGHT', 'DEAD_LETTER'],
  SUCCEEDED: [],
  FAILED: [],
  DEAD_LETTER: [],
  BLOCKED: [],
};

export function isTerminalState(state: PlatformWriteAttemptState): boolean {
  return PLATFORM_WRITE_TERMINAL_STATES.includes(state);
}

export function allowedTransitions(state: PlatformWriteAttemptState): readonly PlatformWriteAttemptState[] {
  return TRANSITIONS[state] ?? [];
}

export function assertTransition(from: PlatformWriteAttemptState, to: PlatformWriteAttemptState): void {
  if (!allowedTransitions(from).includes(to)) {
    throw new PlatformWriteError('ILLEGAL_TRANSITION', '非法状态迁移: ' + from + ' -> ' + to);
  }
}

/** 端口结果 → 下一个状态；可重试失败在达到上限后收敛为 DEAD_LETTER */
export function nextStateAfterOutcome(
  outcome: PlatformWritePortOutcome,
  attempts: number,
  maxAttempts: number = PLATFORM_WRITE_MAX_ATTEMPTS,
): PlatformWriteAttemptState {
  if (outcome.status === 'SUCCEEDED') return 'SUCCEEDED';
  if (outcome.status === 'REJECTED') return 'FAILED';
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new PlatformWriteError('ATTEMPT_COUNT_INVALID', 'attempts 必须是 >= 1 的整数');
  }
  return attempts >= maxAttempts ? 'DEAD_LETTER' : 'RETRYABLE';
}

/** 纯函数退避（毫秒）；本模块不 sleep，等待由上层调度器负责 */
export function attemptBackoffMs(attempt: number, baseMs = 250, capMs = 4000): number {
  if (!Number.isInteger(attempt) || attempt < 1) return 0;
  const raw = baseMs * Math.pow(2, attempt - 1);
  return Math.min(raw, capMs);
}
