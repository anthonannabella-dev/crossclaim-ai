// P6-PROD-U1 —— crash recovery / startup reconciliation 决策（纯函数；禁止 blind retry）
// 判据：只能依据「server-owned 只读观测 + durable 现状」判断，不得凭猜测重复执行。
//   · 观测不到 → NEEDS_RECONCILIATION（unknown outcome）
//   · 观测到目标值已生效且 version 前进 → RECOVERED_COMMITTED（有证据的恢复，不重放 CAS）
//   · 观测到仍是 pre 值且 version 未变 → SAFE_TO_RETRY（无副作用证据，可重新取得 lease）
//   · 观测到目标值但 version 未变 / 其它漂移 → NEEDS_RECONCILIATION（证据不足）

import {
  RECOVERY_BASIS_UNKNOWN_VERSION,
  isConfigExecutionTerminalState,
  type ConfigExecutionReservationState,
} from './state-machine';
import {
  isLeaseActive,
} from './lease';
import type { LeaseFence, LeaseView, ObservationView, ReservationView } from './types';

export interface ExecutionExpectation {
  baselineConfigFingerprint: string;
  preConfigVersion: string;
  fromValue: string;
  toValue: string;
}

/**
 * durable recovery basis 的**唯一**来源：直接由 reservation 行重建。
 * 进程 crash / 重启后不得依赖 caller 重新提供 pre version / from / to。
 */
export function expectedFromReservation(reservation: ReservationView): ExecutionExpectation {
  return {
    baselineConfigFingerprint: reservation.baselineConfigFingerprint,
    preConfigVersion: reservation.preConfigVersion,
    fromValue: reservation.fromValue,
    toValue: reservation.toValue,
  };
}

export function sameExecutionExpectation(a: ExecutionExpectation, b: ExecutionExpectation): boolean {
  return (
    a.baselineConfigFingerprint === b.baselineConfigFingerprint &&
    a.preConfigVersion === b.preConfigVersion &&
    a.fromValue === b.fromValue &&
    a.toValue === b.toValue
  );
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

/** 从快照构造 lease fence（recovery 动作必须携带它，落库前在行锁内复核）。 */
export function buildLeaseFence(reservation: ReservationView): LeaseFence {
  return {
    leaseId: reservation.leaseId,
    executionAttempt: reservation.executionAttempt,
    leaseRenewedAt: reservation.leaseRenewedAt ? reservation.leaseRenewedAt.toISOString() : null,
    leaseExpiresAt: reservation.leaseExpiresAt ? reservation.leaseExpiresAt.toISOString() : null,
  };
}

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

  // 保留 sentinel：历史行（migration 回填 'UNKNOWN'）的 recovery basis 不完整 → 一律 fail-closed。
  // 该值绝不参与 version 比较，因此不可能出现 SAFE_TO_RETRY / RECOVERED_COMMITTED。
  if (expected.preConfigVersion === RECOVERY_BASIS_UNKNOWN_VERSION) {
    return {
      kind: 'NEEDS_RECONCILIATION',
      reason: 'RECOVERY_BASIS_INCOMPLETE',
      post: null,
    };
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
  const fingerprintMatchesBaseline =
    observation.configFingerprint === expected.baselineConfigFingerprint;

  // 证据必须自洽：值已改成 to、version 前进，却仍声称指纹等于 baseline → 矛盾观测，不得自动成功。
  if (valueIsTarget && versionAdvanced) {
    if (fingerprintMatchesBaseline) {
      return {
        kind: 'NEEDS_RECONCILIATION',
        reason: 'SELF_CONTRADICTORY_OBSERVATION',
        post,
      };
    }
    return { kind: 'RECOVERED_COMMITTED', post };
  }
  // 值仍是 from、version 未变：必须同时证明整份配置指纹仍等于 baseline 才允许安全重试。
  if (valueIsPre && !versionAdvanced) {
    if (!fingerprintMatchesBaseline) {
      return {
        kind: 'NEEDS_RECONCILIATION',
        reason: 'OBSERVATION_FINGERPRINT_DRIFT',
        post,
      };
    }
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
  | { reservationId: string; kind: 'NOOP'; reason: string; fence: LeaseFence }
  | { reservationId: string; kind: 'CANCEL'; reason: 'RESERVATION_EXPIRED'; fence: LeaseFence }
  | {
      reservationId: string;
      kind: 'TERMINALIZE';
      status: 'SUCCEEDED' | 'NEEDS_RECONCILIATION' | 'MANUAL_REVIEW';
      resultCode: 'RECOVERED_COMMITTED' | 'NEEDS_RECONCILIATION' | 'MANUAL_REVIEW';
      post: { fingerprint: string; version: string } | null;
      reason: string;
      fence: LeaseFence;
    }
  | { reservationId: string; kind: 'RECLAIM'; reason: 'SAFE_TO_RETRY'; fence: LeaseFence }
  | {
      reservationId: string;
      kind: 'REVIEW';
      status: 'MANUAL_REVIEW';
      reason: string;
      fence: LeaseFence;
    };

/**
 * 启动对账计划：对所有非终态 reservation 产出确定性动作。
 * 同一输入 → 同一输出；动作落地后再次运行应只剩 NOOP（幂等由 DB 测试证明）。
 */
export function planStartupReconciliation(input: {
  reservations: ReservationView[];
  now: Date;
  observe: (reservation: ReservationView) => ObservationView | null;
  /**
   * 兼容层：只用于**断言** caller 的期望与 durable basis 一致，绝不作为 recovery truth。
   * 不一致 → FAIL_CLOSED（RECOVERY_BASIS_MISMATCH），不参与 SAFE_TO_RETRY / RECOVERED_COMMITTED 判定。
   */
  assertExpectedFor?: (reservation: ReservationView) => ExecutionExpectation;
}): ReconciliationAction[] {
  const actions: ReconciliationAction[] = [];
  const ordered = [...input.reservations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const reservation of ordered) {
    const fence = buildLeaseFence(reservation);
    const durableExpectation = expectedFromReservation(reservation);
    if (input.assertExpectedFor) {
      const claimed = input.assertExpectedFor(reservation);
      if (!sameExecutionExpectation(claimed, durableExpectation)) {
        actions.push({
          reservationId: reservation.id,
          kind: 'REVIEW',
          status: 'MANUAL_REVIEW',
          reason: 'RECOVERY_BASIS_MISMATCH',
          fence,
        });
        continue;
      }
    }
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
      expected: durableExpectation,
    });
    switch (classification.kind) {
      case 'NOOP':
        actions.push({
          reservationId: reservation.id,
          kind: 'NOOP',
          reason: classification.reason,
          fence,
        });
        break;
      case 'CANCEL_EXPIRED_RESERVATION':
        actions.push({
          reservationId: reservation.id,
          kind: 'CANCEL',
          reason: 'RESERVATION_EXPIRED',
          fence,
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
          fence,
        });
        break;
      case 'SAFE_TO_RETRY':
        actions.push({
          reservationId: reservation.id,
          kind: 'RECLAIM',
          reason: 'SAFE_TO_RETRY',
          fence,
        });
        break;
      case 'NEEDS_RECONCILIATION':
        actions.push({
          reservationId: reservation.id,
          kind: 'TERMINALIZE',
          status: 'NEEDS_RECONCILIATION',
          resultCode: 'NEEDS_RECONCILIATION',
          post: classification.post,
          reason: classification.reason,
          fence,
        });
        break;
      case 'MANUAL_REVIEW':
        actions.push({
          reservationId: reservation.id,
          kind: 'REVIEW',
          status: 'MANUAL_REVIEW',
          reason: classification.reason,
          fence,
        });
        break;
    }
  }
  return actions;
}
