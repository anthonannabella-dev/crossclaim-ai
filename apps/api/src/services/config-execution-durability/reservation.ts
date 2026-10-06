// P6-PROD-U1 —— reservation / 终态结果 / outbox 的纯决策（无 IO、无进程内状态）
// 生产路径必须把这里的决策落到 Prisma durable store（见 S3）；本文件只做可测的判定。

import { canonicalJson, digestOf, postIdentityToken, sha256Hex } from './digests';
import {
  CONFIG_EXECUTION_MODES,
  CONFIG_EXECUTION_OUTBOX_TOPICS,
  CONFIG_EXECUTION_RESULT_CODE_STATUS,
  CONFIG_EXECUTION_RESULT_SEMANTICS,
  assertConfigExecutionEnvironment,
  type ConfigExecutionEvidenceSource,
  type ConfigExecutionReservationState,
  type ConfigExecutionResultCode,
  type ConfigExecutionTerminalState,
} from './state-machine';
import {
  ConfigExecutionOperationError,
  type ConfigExecutionBasis,
  type PlannedReservation,
  type ReservationView,
  type TerminalOutboxEvent,
  type TerminalResultRecord,
} from './types';

export const CONFIG_EXECUTION_RESERVATION_DEFAULT_TTL_MS = 15 * 60 * 1000;

// 契约明确零写的结果码：不得携带任何 post identity（与 migration 的 zero_write CHECK 一致）。
export const CONFIG_EXECUTION_ZERO_WRITE_RESULT_CODES: readonly ConfigExecutionResultCode[] = [
  'CONFLICT',
  'STALE_BASELINE',
  'FAILED_ZERO_WRITE',
  'CANCELLED',
  'SUPERSEDED',
];

export function planReservation(input: {
  basis: ConfigExecutionBasis;
  idempotencyKey: string;
  now: Date;
  reservationTtlMs?: number;
}): PlannedReservation {
  const idempotencyKey = (input.idempotencyKey ?? '').trim();
  if (idempotencyKey.length === 0) {
    throw new ConfigExecutionOperationError(
      'CONFIG_EXECUTION_IDEMPOTENCY_KEY_REQUIRED',
      'reservation 必须携带非空 idempotencyKey',
    );
  }
  // NO PRODUCTION ENABLEMENT：环境与执行模式双重 fail-closed
  assertConfigExecutionEnvironment(input.basis.environment);
  if (!(CONFIG_EXECUTION_MODES as readonly string[]).includes(input.basis.executionMode)) {
    throw new ConfigExecutionOperationError(
      'CONFIG_EXECUTION_MODE_FORBIDDEN',
      `只接受 ${CONFIG_EXECUTION_MODES.join('/')}，收到 ${input.basis.executionMode}`,
    );
  }

  const immutableBasisDigest = digestOf({ ...input.basis });
  const reservationKey = sha256Hex(
    [immutableBasisDigest, input.basis.authorizationVerdictDigest, input.basis.executionMode].join('|'),
  );
  const idempotencyPayloadDigest = digestOf({ idempotencyKey, basis: input.basis });
  const ttl = input.reservationTtlMs ?? CONFIG_EXECUTION_RESERVATION_DEFAULT_TTL_MS;

  return {
    ...input.basis,
    reservationKey,
    immutableBasisDigest,
    idempotencyKey,
    idempotencyPayloadDigest,
    reservationExpiresAt: new Date(input.now.getTime() + ttl),
    status: 'RESERVED',
  };
}

export type ReservationDecision =
  | { kind: 'CREATE'; plan: PlannedReservation }
  | { kind: 'REUSE'; reservationId: string; status: ConfigExecutionReservationState }
  | {
      kind: 'FAIL_CLOSED';
      code:
        | 'CONFIG_EXECUTION_IDEMPOTENCY_KEY_CONFLICT'
        | 'CONFIG_EXECUTION_RESERVATION_PAYLOAD_CONFLICT';
      message: string;
    };

/**
 * 重复 reservation 判定：
 *  · 同一不可变依据 → 幂等复用既有 reservation（绝不产生第二条 execution）
 *  · 同一 idempotencyKey 但载荷摘要不同 → FAIL CLOSED（禁止 silent overwrite）
 *  · 同一 verdict/ticket 身份却换了依据 → FAIL CLOSED
 */
export function decideReservation(
  existing: ReservationView | null,
  plan: PlannedReservation,
): ReservationDecision {
  if (!existing) return { kind: 'CREATE', plan };
  if (existing.immutableBasisDigest === plan.immutableBasisDigest) {
    return { kind: 'REUSE', reservationId: existing.id, status: existing.status };
  }
  if (existing.idempotencyKey === plan.idempotencyKey) {
    return {
      kind: 'FAIL_CLOSED',
      code: 'CONFIG_EXECUTION_IDEMPOTENCY_KEY_CONFLICT',
      message: '同一 idempotencyKey 的不可变载荷摘要不一致',
    };
  }
  return {
    kind: 'FAIL_CLOSED',
    code: 'CONFIG_EXECUTION_RESERVATION_PAYLOAD_CONFLICT',
    message: '同一授权身份已存在不同执行依据的 reservation',
  };
}

export interface TerminalResultInput {
  reservationId: string;
  executionId: string;
  resultCode: ConfigExecutionResultCode;
  preConfigFingerprint: string;
  preConfigVersion: string;
  postConfigFingerprint: string | null;
  postConfigVersion: string | null;
  idempotencyKey: string;
  provenanceDigest: string;
  evidenceSource: ConfigExecutionEvidenceSource;
  reconciledBy?: string | null;
  recordedAt: Date;
}

/**
 * 构造 append-only 终态结果：
 *  · status / semantics 由 resultCode 单源派生（禁止失败结果携带 COMMITTED 语义）
 *  · post identity 只能「完整已知」或「完整 UNKNOWN（两列都 null）」
 *  · 明确零写的结果码不得携带 post identity
 */
export function buildTerminalResult(input: TerminalResultInput): TerminalResultRecord {
  const status = CONFIG_EXECUTION_RESULT_CODE_STATUS[input.resultCode] as
    | ConfigExecutionTerminalState
    | undefined;
  const semantics = CONFIG_EXECUTION_RESULT_SEMANTICS[input.resultCode] as string | undefined;
  if (!status || !semantics) {
    throw new ConfigExecutionOperationError(
      'CONFIG_EXECUTION_RESULT_CODE_UNKNOWN',
      `未知 resultCode：${String(input.resultCode)}`,
    );
  }
  const postFingerprint = input.postConfigFingerprint ?? null;
  const postVersion = input.postConfigVersion ?? null;
  if ((postFingerprint === null) !== (postVersion === null)) {
    throw new ConfigExecutionOperationError(
      'CONFIG_EXECUTION_RESULT_POST_IDENTITY_PARTIAL',
      'post identity 必须完整已知或完整 UNKNOWN（不得只写一半）',
    );
  }
  if (
    CONFIG_EXECUTION_ZERO_WRITE_RESULT_CODES.includes(input.resultCode) &&
    (postFingerprint !== null || postVersion !== null)
  ) {
    throw new ConfigExecutionOperationError(
      'CONFIG_EXECUTION_RESULT_ZERO_WRITE_VIOLATION',
      `${input.resultCode} 契约明确零写，不得携带 post identity`,
    );
  }

  const resultDigest = digestOf({
    version: 'controlled-config-execution-durability/v1',
    reservationId: input.reservationId,
    executionId: input.executionId,
    status,
    resultCode: input.resultCode,
    semantics,
    preConfigFingerprint: input.preConfigFingerprint,
    preConfigVersion: input.preConfigVersion,
    postIdentity: postIdentityToken(postFingerprint, postVersion),
    idempotencyKey: input.idempotencyKey,
    provenanceDigest: input.provenanceDigest,
    evidenceSource: input.evidenceSource,
  });

  return {
    reservationId: input.reservationId,
    executionId: input.executionId,
    status,
    resultCode: input.resultCode,
    semantics,
    preConfigFingerprint: input.preConfigFingerprint,
    preConfigVersion: input.preConfigVersion,
    postConfigFingerprint: postFingerprint,
    postConfigVersion: postVersion,
    idempotencyKey: input.idempotencyKey,
    resultDigest,
    provenanceDigest: input.provenanceDigest,
    evidenceSource: input.evidenceSource,
    reconciledBy: input.reconciledBy ?? null,
    recordedAt: input.recordedAt,
  };
}

/** 终态 + 结果 + outbox 必须在同一事务内落库；本函数只负责构造 outbox 事件。 */
export function buildTerminalOutboxEvent(input: {
  reservationId: string;
  result: TerminalResultRecord;
  topic?: string;
}): TerminalOutboxEvent {
  const topic = input.topic ?? CONFIG_EXECUTION_OUTBOX_TOPICS[0];
  const payload = canonicalJson({
    topic,
    reservationId: input.reservationId,
    executionId: input.result.executionId,
    status: input.result.status,
    resultCode: input.result.resultCode,
    semantics: input.result.semantics,
    resultDigest: input.result.resultDigest,
    recordedAt: input.result.recordedAt.toISOString(),
  });
  return {
    topic,
    eventKey: sha256Hex([input.reservationId, topic, input.result.resultDigest].join('|')),
    payload,
    payloadDigest: sha256Hex(payload),
    createdAt: input.result.recordedAt,
  };
}

export type DeliveryDecision =
  | { kind: 'CONSUME'; deliveryKey: string; payloadDigest: string; consumedAt: Date }
  | { kind: 'ALREADY_CONSUMED'; deliveryId: string }
  | { kind: 'NOT_FOUND' }
  | { kind: 'FAIL_CLOSED'; code: 'CONFIG_EXECUTION_DELIVERY_CONFLICT'; message: string };

/** 消费者幂等：同一 outbox 事件同一消费者至多一次；载荷摘要不一致 → FAIL CLOSED。 */
export function decideOutboxDelivery(
  existing: { id: string; payloadDigest: string } | null,
  input: { outboxId: string; consumerRef: string; payloadDigest: string; now: Date },
): DeliveryDecision {
  const deliveryKey = sha256Hex([input.outboxId, input.consumerRef].join('|'));
  if (!existing) {
    return {
      kind: 'CONSUME',
      deliveryKey,
      payloadDigest: input.payloadDigest,
      consumedAt: input.now,
    };
  }
  if (existing.payloadDigest !== input.payloadDigest) {
    return {
      kind: 'FAIL_CLOSED',
      code: 'CONFIG_EXECUTION_DELIVERY_CONFLICT',
      message: '同一 outbox 事件的载荷摘要与既有交付记录不一致',
    };
  }
  return { kind: 'ALREADY_CONSUMED', deliveryId: existing.id };
}
