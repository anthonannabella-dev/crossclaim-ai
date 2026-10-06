// P6-PROD-U1 —— lease / 执行所有权决策（ownerRef + leaseId + acquiredAt/renewedAt/expiresAt）
// 规则：
//   · 有效 lease 不得被抢（另一 owner 只能读取既有 reservation/result）
//   · 过期 lease 允许确定性 takeover，且必须在 append-only 事件里留痕
//   · 终态一律不再进入 EXECUTING（fail-closed）
//   · reservation 窗口已过期 → 不得再开始执行（交由对账取消，而不是盲跑）

import { sha256Hex } from './digests';
import {
  isConfigExecutionTerminalState,
  type ConfigExecutionReservationState,
} from './state-machine';
import { ConfigExecutionOperationError, type ReservationView } from './types';

export const CONFIG_EXECUTION_DEFAULT_LEASE_TTL_MS = 60 * 1000;

export function isLeaseActive(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() > now.getTime();
}

export function computeLeaseId(input: {
  reservationKey: string;
  ownerRef: string;
  executionAttempt: number;
  acquiredAt: Date;
}): string {
  return sha256Hex(
    [input.reservationKey, input.ownerRef, String(input.executionAttempt), input.acquiredAt.toISOString()].join(
      '|',
    ),
  );
}

export type LeaseDecision =
  | {
      kind: 'ACQUIRE';
      fromStatus: 'RESERVED';
      toStatus: 'EXECUTING';
      ownerRef: string;
      leaseId: string;
      acquiredAt: Date;
      renewedAt: Date;
      expiresAt: Date;
      executionAttempt: number;
    }
  | {
      kind: 'RENEW';
      ownerRef: string;
      leaseId: string;
      renewedAt: Date;
      expiresAt: Date;
      executionAttempt: number;
    }
  | {
      kind: 'TAKEOVER';
      fromStatus: 'EXECUTING';
      toStatus: 'EXECUTING';
      ownerRef: string;
      leaseId: string;
      previousOwnerRef: string | null;
      previousLeaseId: string | null;
      acquiredAt: Date;
      renewedAt: Date;
      expiresAt: Date;
      executionAttempt: number;
      reason: 'LEASE_EXPIRED' | 'LEASE_MISSING';
    }
  | { kind: 'TERMINAL_NOOP'; status: ConfigExecutionReservationState }
  | { kind: 'LEASE_HELD'; ownerRef: string | null; leaseId: string | null; expiresAt: Date }
  | { kind: 'RESERVATION_EXPIRED'; expiresAt: Date };

export function planLeaseClaim(input: {
  reservation: ReservationView;
  ownerRef: string;
  now: Date;
  leaseTtlMs?: number;
  leaseId?: string;
}): LeaseDecision {
  const ownerRef = (input.ownerRef ?? '').trim();
  if (ownerRef.length === 0) {
    throw new ConfigExecutionOperationError(
      'CONFIG_EXECUTION_LEASE_ID_REQUIRED',
      'lease 必须携带非空 ownerRef',
    );
  }
  const now = input.now;
  const ttl = input.leaseTtlMs ?? CONFIG_EXECUTION_DEFAULT_LEASE_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttl);
  const reservation = input.reservation;

  if (isConfigExecutionTerminalState(reservation.status)) {
    return { kind: 'TERMINAL_NOOP', status: reservation.status };
  }

  const reservationExpired = reservation.reservationExpiresAt.getTime() <= now.getTime();

  if (reservation.status === 'RESERVED') {
    if (reservationExpired) {
      return { kind: 'RESERVATION_EXPIRED', expiresAt: reservation.reservationExpiresAt };
    }
    const attempt = reservation.executionAttempt + 1;
    return {
      kind: 'ACQUIRE',
      fromStatus: 'RESERVED',
      toStatus: 'EXECUTING',
      ownerRef,
      leaseId:
        input.leaseId ??
        computeLeaseId({
          reservationKey: reservation.reservationKey,
          ownerRef,
          executionAttempt: attempt,
          acquiredAt: now,
        }),
      acquiredAt: now,
      renewedAt: now,
      expiresAt,
      executionAttempt: attempt,
    };
  }

  // status === 'EXECUTING'
  const activeLease = isLeaseActive(reservation.leaseExpiresAt, now);
  if (activeLease) {
    if (reservation.ownerRef === ownerRef && reservation.leaseId) {
      return {
        kind: 'RENEW',
        ownerRef,
        leaseId: reservation.leaseId,
        renewedAt: now,
        expiresAt,
        executionAttempt: reservation.executionAttempt,
      };
    }
    return {
      kind: 'LEASE_HELD',
      ownerRef: reservation.ownerRef,
      leaseId: reservation.leaseId,
      expiresAt: reservation.leaseExpiresAt as Date,
    };
  }

  if (reservationExpired) {
    // 授权窗口已结束：不得 takeover 继续执行，交由启动对账/人工收敛。
    return { kind: 'RESERVATION_EXPIRED', expiresAt: reservation.reservationExpiresAt };
  }

  const attempt = reservation.executionAttempt + 1;
  return {
    kind: 'TAKEOVER',
    fromStatus: 'EXECUTING',
    toStatus: 'EXECUTING',
    ownerRef,
    leaseId:
      input.leaseId ??
      computeLeaseId({
        reservationKey: reservation.reservationKey,
        ownerRef,
        executionAttempt: attempt,
        acquiredAt: now,
      }),
    previousOwnerRef: reservation.ownerRef,
    previousLeaseId: reservation.leaseId,
    acquiredAt: now,
    renewedAt: now,
    expiresAt,
    executionAttempt: attempt,
    reason: reservation.leaseId === null ? 'LEASE_MISSING' : 'LEASE_EXPIRED',
  };
}

export function assertLeaseIdFresh(decision: LeaseDecision, previousLeaseId: string | null): void {
  if (decision.kind === 'TAKEOVER' && decision.leaseId === previousLeaseId) {
    throw new ConfigExecutionOperationError(
      'CONFIG_EXECUTION_LEASE_ID_REUSE',
      'takeover 必须使用新的 leaseId（不得复用被判定为过期的 lease 身份）',
    );
  }
}
