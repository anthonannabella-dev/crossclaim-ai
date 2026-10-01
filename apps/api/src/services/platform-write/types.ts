/**
 * ② 下一小批次（MSG-20261001-16 NEXT）：platform.write —— 接口 / 状态机 / 权限 / 幂等 /
 * 审批绑定 / 模拟适配器 / fail-closed 测试。
 * ---------------------------------------------------------------
 * 边界（不得越过，越界即回架构方）：
 *   · 真实平台写入一律关闭：PLATFORM_WRITE_TRANSPORT_ENABLED 恒为 false。
 *   · 只有 simulated === true 的端口可以被接线；真实写入通道在**类型**与**运行时**双重拒绝。
 *   · 本模块不读 env、不读凭据、不发网络请求、不写数据库。
 *     （把尝试账本落库属于 Schema 变更，需架构方单独裁决；本批次用注入式端口 + 内存实现。）
 */

/**
 * 受保护动作名来自 action-guard 单一来源（approval-verifier.ts）：
 * 非守卫文件不得散落动作字面量（有限静态约定检查要求）。
 */
export { PLATFORM_WRITE_ACTION } from '../action-guard/approval-verifier';

/** 硬开关：Phase 1 恒为 false；翻转为 true 属于必须回架构方审计的动作。 */
export const PLATFORM_WRITE_TRANSPORT_ENABLED = false;

export const PLATFORM_WRITE_SNAPSHOT_VERSION = 'platform-write-request/v1';

/** 单次逻辑提交的最大投递尝试次数（含首次）；超过即 DEAD_LETTER。 */
export const PLATFORM_WRITE_MAX_ATTEMPTS = 3;

export const PLATFORM_WRITE_TARGET_KINDS = ['CLAIM', 'APPEAL'] as const;
export type PlatformWriteTargetKind = (typeof PLATFORM_WRITE_TARGET_KINDS)[number];

export const PLATFORM_WRITE_ATTEMPT_STATES = [
  'PENDING',
  'IN_FLIGHT',
  'SUCCEEDED',
  'RETRYABLE',
  'FAILED',
  'DEAD_LETTER',
  'BLOCKED',
] as const;
export type PlatformWriteAttemptState = (typeof PLATFORM_WRITE_ATTEMPT_STATES)[number];

export const PLATFORM_WRITE_TERMINAL_STATES: readonly PlatformWriteAttemptState[] = [
  'SUCCEEDED',
  'FAILED',
  'DEAD_LETTER',
  'BLOCKED',
];

export const PLATFORM_WRITE_STATUSES = [
  'BLOCKED',
  'NEEDS_MANUAL',
  'SUCCEEDED',
  'REPLAYED',
  'RETRYABLE',
  'FAILED',
  'DEAD_LETTER',
] as const;
export type PlatformWriteStatus = (typeof PLATFORM_WRITE_STATUSES)[number];

export interface PlatformWriteRequest {
  organizationId: string;
  caseId: string;
  targetKind: PlatformWriteTargetKind;
  targetId: string;
  platform: string;
  /** 服务端生成的提交载荷（业务层构造；本模块只做规范化摘要与投递编排） */
  payload: Record<string, unknown>;
  actorUserId: string;
  approvalId?: string;
  /** 调用方若显式给定幂等键，必须与服务端派生结果一致，否则 fail-closed */
  idempotencyKey?: string;
}

/** 服务端生成、版本化的提交快照；审批创建与执行核验共用同一摘要算法 */
export interface PlatformWriteSnapshot {
  version: string;
  organizationId: string;
  caseId: string;
  targetKind: PlatformWriteTargetKind;
  targetId: string;
  platform: string;
  payloadDigest: string;
  payloadLength: number;
}

/** 审批记录（由既有审批存储提供；本模块只读不消费） */
export interface PlatformWriteApprovalRecord {
  id: string;
  organizationId: string;
  action: string;
  /** 审批创建时绑定的服务端快照摘要 */
  basisReference: string;
  expiresAt?: string | Date | null;
  consumedAt?: string | Date | null;
}

export interface PlatformWriteApprovalPort {
  get(approvalId: string): Promise<PlatformWriteApprovalRecord | null>;
}

export type PlatformWritePortOutcome =
  | { status: 'SUCCEEDED'; externalRef: string }
  | { status: 'RETRYABLE'; code: string; retryAfterMs?: number }
  | { status: 'REJECTED'; code: string };

export interface PlatformWritePortRequest {
  organizationId: string;
  caseId: string;
  targetKind: PlatformWriteTargetKind;
  targetId: string;
  platform: string;
  idempotencyKey: string;
  snapshotDigest: string;
  payload: Record<string, unknown>;
}

/**
 * 投递端口：simulated 在类型上恒为 true —— 真实写入适配器无法满足该契约，
 * 因此 Phase 1 结构上就不存在可执行的真实写入面。
 */
export interface PlatformWritePort {
  readonly platform: string;
  readonly simulated: true;
  submit(request: PlatformWritePortRequest): Promise<PlatformWritePortOutcome>;
}

export interface PlatformWriteLedgerEntry {
  key: string;
  snapshotDigest: string;
  state: PlatformWriteAttemptState;
  attempts: number;
  code: string;
  externalRef?: string;
  updatedAt: string;
}

export interface PlatformWriteLedger {
  read(key: string): Promise<PlatformWriteLedgerEntry | null>;
  write(entry: PlatformWriteLedgerEntry): Promise<void>;
}

export type PlatformWriteAuditEventType =
  | 'platform.write.blocked'
  | 'platform.write.needs_manual'
  | 'platform.write.attempted'
  | 'platform.write.settled';

/** 审计事件（白名单字段；不含凭据、不含载荷正文） */
export interface PlatformWriteAuditEvent {
  type: PlatformWriteAuditEventType;
  action: string;
  organizationId: string;
  caseId: string;
  targetKind: PlatformWriteTargetKind;
  targetId: string;
  platform: string;
  snapshotVersion: string;
  snapshotDigest: string;
  idempotencyKey: string;
  state: PlatformWriteAttemptState;
  attempts: number;
  code: string;
  externalRef: string | null;
  transportEnabled: boolean;
}

export interface PlatformWriteResult {
  status: PlatformWriteStatus;
  code: string;
  reasons: string[];
  organizationId: string;
  caseId: string;
  targetKind: PlatformWriteTargetKind;
  targetId: string;
  platform: string;
  snapshotVersion: string;
  snapshotDigest: string;
  idempotencyKey: string;
  state: PlatformWriteAttemptState;
  attempts: number;
  transportEnabled: boolean;
  /** 投递通道实际被调用次数；fail-closed 路径必须为 0 */
  sinkCalls: number;
  externalRef?: string;
}

export class PlatformWriteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlatformWriteError';
    this.code = code;
  }
}

/** 审计字段白名单：构造期拒绝未知字段，避免敏感值外泄 */
export const PLATFORM_WRITE_AUDIT_FIELDS: readonly string[] = [
  'type',
  'action',
  'organizationId',
  'caseId',
  'targetKind',
  'targetId',
  'platform',
  'snapshotVersion',
  'snapshotDigest',
  'idempotencyKey',
  'state',
  'attempts',
  'code',
  'externalRef',
  'transportEnabled',
];

export function assertPlatformWriteAuditEvent(event: PlatformWriteAuditEvent): PlatformWriteAuditEvent {
  for (const key of Object.keys(event)) {
    if (!PLATFORM_WRITE_AUDIT_FIELDS.includes(key)) {
      throw new PlatformWriteError('AUDIT_FIELD_REJECTED', '审计字段不在白名单: ' + key);
    }
  }
  return event;
}
