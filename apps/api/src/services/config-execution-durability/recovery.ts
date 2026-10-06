// P6-PROD-U1 —— crash recovery / startup reconciliation 决策（纯函数；禁止 blind retry）
// 判据：只能依据「server-owned 只读观测 + durable 现状」判断，不得凭猜测重复执行。
//   · 观测不到 → NEEDS_RECONCILIATION（unknown outcome）
//   · 观测到目标值已生效且 version 前进 → RECOVERED_COMMITTED（有证据的恢复，不重放 CAS）
//   · 观测到仍是 pre 值且 version 未变 → SAFE_TO_RETRY（无副作用证据，可重新取得 lease）
//   · 观测到目标值但 version 未变 / 其它漂移 → NEEDS_RECONCILIATION（证据不足）

import { isConfigExecutionTerminalState, type ConfigExecutionReservationState } from './state-machine';
import {
  isLeaseActive,
} from './lease';
import type { LeaseView, ObservationView, ReservationView } from './types';

export interface ExecutionExpectation {
  baselineConfigFingerprint: string;
  preConfigVersion: string;
  fromValue: string;
  toValue: string;
}

export type StrandedClassification =
  | { kind: 'NOOP'; reason: string; status: ConfigExecutionReservationState }
  | { kind: 'CANCEL_EXPIRED_RESERVATION'; status: 'RESERVED' }
  | { kind: 'RECOVERED_COMMITTED'; post: { fingerprint: string; version: string } }
  | { kind: 'SAFE_TO_RETRY'; reason: string }
  | {
      kind: 'NEEDS_RECONCILIATION';
      reason: string;
      post: { fingerprint: string; version: string } | null;
    }
  | { kind: 'MANUAL_REVIEW'; reason: string };

export function classifyStrandedExecution(input: {
  status: ConfigExecutionReservationState;
  lease: LeaseView;
  reservationExpiresAt: Date;
  now: Date;
  observation: ObservationView | null;
  expected: ExecutionExpectation;
}): StrandedClassification {
  const { status, lease, now, observation, expected } = input;

  if (isConfigExecutionTerminalState(status)) {
    return { kind: 'NOOP', reason: 'ALREADY_TERMINAL', status };
  }

  if (status === 'RESERVED') {
    if (input.reservationExpiresAt.getTime() <= now.getTime()) {
      return { kind: 'CANCEL_EXPIRED_RESERVATION', status: 'RESERVED' };
    }
    return { kind: 'NOOP', reason: 'RESERVED_WAITING_FOR_WORKER', status };
  }

  if (isLeaseActive(lease.expiresAt, now)) {
    return { kind: 'NOOP', reason: 'LEASE_ACTIVE', status };
  }

  if (observation === null) {
    return {
      kind: 'NEEDS_RECONCILIATION',
      reason: 'OBSERVATION_UNAVAILABLE',
      post: null,
    };
  }

  const post = { fingerprint: observation.configFingerprint, version: observation.version };
  const valueIsTarget = observation.pathValue === expected.toValue;
  const valueIsPre = observation.pathValue === expected.fromValue;
  const versionAdvanced = observation.version !== expected.preConfigVersion;

  if (valueIsTarget && versionAdvanced) {
    return { kind: 'RECOVERED_COMMITTED', post };
  }
  if (valueIsPre && !versionAdvanced) {
    return { kind: 'SAFE_TO_RETRY', reason: 'BASELINE_UNCHANGED' };
  }
  if (valueIsTarget && !versionAdvanced) {
    return {
      kind: 'NEEDS_RECONCILIATION',
      reason: 'TARGET_VALUE_WITHOUT_VERSION_ADVANCE',
      post,
    };
  }
  return {
    kind: 'NEEDS_RECONCILIATION',
    reason: 'OBSERVED_DRIFT',
    post,
  };
}

export type ReconciliationAction =
  | { reservationId: string; kind: 'NOOP'; reason: string }
  | { reservationId: string; kind: 'CANCEL'; reason: 'RESERVATION_EXPIRED' }
  | {
      reservationId: string;
      kind: 'TERMINALIZE';
      status: 'SUCCEEDED' | 'NEEDS_RECONCILIATION' | 'MANUAL_REVIEW';
      resultCode: 'RECOVERED_COMMITTED' | 'NEEDS_RECONCILIATION' | 'MANUAL_REVIEW';
      post: { fingerprint: string; version: string } | null;
      reason: string;
    }
  | { reservationId: string; kind: 'RECLAIM'; reason: 'SAFE_TO_RETRY' }
  | { reservationId: string; kind: 'REVIEW'; status: 'MANUAL_REVIEW'; reason: string };

/**
 * 启动对账计划：对所有非终态 reservation 产出确定性动作。
 * 同一输入 → 同一输出；动作落地后再次运行应只剩 NOOP（幂等由 DB 测试证明）。
 */
export function planStartupReconciliation(input: {
  reservations: ReservationView[];
  now: Date;
  observe: (reservation: ReservationView) => ObservationView | null;
  expectedFor: (reservation: ReservationView) => ExecutionExpectation;
}): ReconciliationAction[] {
  const actions: ReconciliationAction[] = [];
  const ordered = [...input.reservations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const reservation of ordered) {
    const lease: LeaseView = {
      ownerRef: reservation.ownerRef,
      leaseId: reservation.leaseId,
      acquiredAt: reservation.leaseAcquiredAt,
      renewedAt: reservation.leaseRenewedAt,
      expiresAt: reservation.leaseExpiresAt,
    };
    const classification = classifyStrandedExecution({
      status: reservation.status,
      lease,
      reservationExpiresAt: reservation.reservationExpiresAt,
      now: input.now,
      observation: input.observe(reservation),
      expected: input.expectedFor(reservation),
    });
    switch (classification.kind) {
      case 'NOOP':
        actions.push({ reservationId: reservation.id, kind: 'NOOP', reason: classification.reason });
        break;
      case 'CANCEL_EXPIRED_RESERVATION':
        actions.push({
          reservationId: reservation.id,
          kind: 'CANCEL',
          reason: 'RESERVATION_EXPIRED',
        });
        break;
      case 'RECOVERED_COMMITTED':
        actions.push({
          reservationId: reservation.id,
          kind: 'TERMINALIZE',
          status: 'SUCCEEDED',
          resultCode: 'RECOVERED_COMMITTED',
          post: classification.post,
          reason: 'READBACK_PROVES_COMMITTED',
        });
        break;
      case 'SAFE_TO_RETRY':
        actions.push({ reservationId: reservation.id, kind: 'RECLAIM', reason: 'SAFE_TO_RETRY' });
        break;
      case 'NEEDS_RECONCILIATION':
        actions.push({
          reservationId: reservation.id,
          kind: 'TERMINALIZE',
          status: 'NEEDS_RECONCILIATION',
          resultCode: 'NEEDS_RECONCILIATION',
          post: classification.post,
          reason: classification.reason,
        });
        break;
      case 'MANUAL_REVIEW':
        actions.push({
          reservationId: reservation.id,
          kind: 'REVIEW',
          status: 'MANUAL_REVIEW',
          reason: classification.reason,
        });
        break;
    }
  }
  return actions;
}
