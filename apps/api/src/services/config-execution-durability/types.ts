// P6-PROD-U1 —— 耐久执行底座：记录形状与操作级错误
// 与 state-machine.ts 分工：那里是「状态级」值域与迁移守卫，这里是「操作级」决策与错误码。

import type {
  ConfigExecutionEvidenceSource,
  ConfigExecutionEventKind,
  ConfigExecutionReservationState,
  ConfigExecutionResultCode,
  ConfigExecutionTerminalState,
} from './state-machine';

export const CONFIG_EXECUTION_OPERATION_CODES = [
  'CONFIG_EXECUTION_IDEMPOTENCY_KEY_REQUIRED',
  'CONFIG_EXECUTION_IDEMPOTENCY_KEY_CONFLICT',
  'CONFIG_EXECUTION_MODE_FORBIDDEN',
  'CONFIG_EXECUTION_RESERVATION_PAYLOAD_CONFLICT',
  'CONFIG_EXECUTION_RESERVATION_EXPIRED',
  'CONFIG_EXECUTION_LEASE_HELD',
  'CONFIG_EXECUTION_LEASE_ID_REQUIRED',
  'CONFIG_EXECUTION_LEASE_ID_REUSE',
  'CONFIG_EXECUTION_OBSERVATION_REQUIRED',
  'CONFIG_EXECUTION_DELIVERY_CONFLICT',
  'CONFIG_EXECUTION_RESULT_CODE_UNKNOWN',
  'CONFIG_EXECUTION_RESULT_POST_IDENTITY_PARTIAL',
  'CONFIG_EXECUTION_RESULT_ZERO_WRITE_VIOLATION',
] as const;
export type ConfigExecutionOperationCode = (typeof CONFIG_EXECUTION_OPERATION_CODES)[number];

export class ConfigExecutionOperationError extends Error {
  readonly code: ConfigExecutionOperationCode;

  constructor(code: ConfigExecutionOperationCode, message: string) {
    super(message);
    this.name = 'ConfigExecutionOperationError';
    this.code = code;
  }
}

// 不可变执行依据：lease 之前冻结；DB 端由 cc_config_execution_transition_guard 强制不可原地改写。
export interface ConfigExecutionBasis {
  authorizationVerdictDigest: string;
  authorizationTicketDigest: string;
  planDigest: string;
  candidateDigest: string;
  proposalDigest: string;
  controlledAdoptionDigest: string;
  rollbackPlanDigest: string;
  baselineSnapshotDigest: string;
  baselineConfigFingerprint: string;
  environment: string;
  executionMode: string;
  target: string;
  configPath: string;
  fromValue: string;
  toValue: string;
}

export interface PlannedReservation extends ConfigExecutionBasis {
  reservationKey: string;
  immutableBasisDigest: string;
  idempotencyKey: string;
  idempotencyPayloadDigest: string;
  reservationExpiresAt: Date;
  status: 'RESERVED';
}

// 现有 reservation 的只读视图（对账 / 幂等判断用；不含任何进程内状态）。
export interface ReservationView {
  id: string;
  reservationKey: string;
  immutableBasisDigest: string;
  idempotencyKey: string;
  idempotencyPayloadDigest: string;
  authorizationVerdictDigest: string;
  authorizationTicketDigest: string;
  status: ConfigExecutionReservationState;
  executionAttempt: number;
  ownerRef: string | null;
  leaseId: string | null;
  leaseAcquiredAt: Date | null;
  leaseRenewedAt: Date | null;
  leaseExpiresAt: Date | null;
  reservationExpiresAt: Date;
}

export interface LeaseView {
  ownerRef: string | null;
  leaseId: string | null;
  acquiredAt: Date | null;
  renewedAt: Date | null;
  expiresAt: Date | null;
}

export interface ObservationView {
  configFingerprint: string;
  version: string;
  pathValue: string;
}

export interface TerminalResultRecord {
  reservationId: string;
  executionId: string;
  status: ConfigExecutionTerminalState;
  resultCode: ConfigExecutionResultCode;
  semantics: string;
  preConfigFingerprint: string;
  preConfigVersion: string;
  postConfigFingerprint: string | null;
  postConfigVersion: string | null;
  idempotencyKey: string;
  resultDigest: string;
  provenanceDigest: string;
  evidenceSource: ConfigExecutionEvidenceSource;
  reconciledBy: string | null;
  recordedAt: Date;
}

export interface TerminalOutboxEvent {
  topic: string;
  eventKey: string;
  payload: string;
  payloadDigest: string;
  createdAt: Date;
}

export interface DurabilityEvent {
  kind: ConfigExecutionEventKind;
  fromStatus: ConfigExecutionReservationState | null;
  toStatus: ConfigExecutionReservationState | null;
  ownerRef: string | null;
  leaseId: string | null;
  evidenceDigest: string | null;
  detail: string | null;
}
