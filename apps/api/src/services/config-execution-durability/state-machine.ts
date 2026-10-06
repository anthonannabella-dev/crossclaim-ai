// P6-PROD-U1 —— Controlled Config Execution Durability（生产级耐久执行底座 / NO PRODUCTION ENABLEMENT）
// ---------------------------------------------------------------------------
// 值域与状态机**单源**：本文件的常量必须与
//   prisma/migrations/20261006120000_config_execution_durability/migration.sql
// 的 CHECK 约束逐条一致（由 config-execution-durability-schema-contract.test.ts 强制比对）。
//
// 边界：本单元只建设耐久 / 并发 / 恢复 / 审计底座，不打开任何生产能力：
//   environment 只允许 SANDBOX；production mutation switch 保持 false；
//   AUTO_PROMOTION / AUTO_ROLLOUT / AUTO_PRODUCTION_ROLLBACK 不在此模块。

export const CONFIG_EXECUTION_DURABILITY_VERSION = 'controlled-config-execution-durability/v1';

// 环境：NO PRODUCTION ENABLEMENT —— 生产环境在本单元不被接受。
export const CONFIG_EXECUTION_ENVIRONMENTS = ['SANDBOX'] as const;
export type ConfigExecutionEnvironment = (typeof CONFIG_EXECUTION_ENVIRONMENTS)[number];

// 执行模式：只允许 sandbox 配置写入；production apply / rollout 不在本单元。
export const CONFIG_EXECUTION_MODES = ['SANDBOX_WRITE_ONLY'] as const;
export type ConfigExecutionMode = (typeof CONFIG_EXECUTION_MODES)[number];

// durable 状态机值域。
// 非终态：RESERVED（已占位，未取得执行权）/ EXECUTING（已持有 lease，正在执行）
// 终态：其余全部；终态不得再回到非终态（DB 触发器 + 本模块守卫双重 fail-closed）。
export const CONFIG_EXECUTION_RESERVATION_STATES = [
  'RESERVED',
  'EXECUTING',
  'SUCCEEDED',
  'CONFLICT',
  'STALE_BASELINE',
  'NEEDS_RECONCILIATION',
  'FAILED_CONFIRMED',
  'MANUAL_REVIEW',
  'SUPERSEDED',
  'CANCELLED',
] as const;
export type ConfigExecutionReservationState = (typeof CONFIG_EXECUTION_RESERVATION_STATES)[number];

export const CONFIG_EXECUTION_NON_TERMINAL_STATES = ['RESERVED', 'EXECUTING'] as const;
export type ConfigExecutionNonTerminalState = (typeof CONFIG_EXECUTION_NON_TERMINAL_STATES)[number];

export const CONFIG_EXECUTION_TERMINAL_STATES = [
  'SUCCEEDED',
  'CONFLICT',
  'STALE_BASELINE',
  'NEEDS_RECONCILIATION',
  'FAILED_CONFIRMED',
  'MANUAL_REVIEW',
  'SUPERSEDED',
  'CANCELLED',
] as const;
export type ConfigExecutionTerminalState = (typeof CONFIG_EXECUTION_TERMINAL_STATES)[number];

// append-only 事件类型（不得在 UPDATE 中改写历史；修正只能追加新事件）。
export const CONFIG_EXECUTION_EVENT_KINDS = [
  'RESERVED',
  'LEASE_ACQUIRED',
  'LEASE_RENEWED',
  'LEASE_TAKEOVER',
  'LEASE_EXPIRED',
  'NOOP_TERMINALIZED',
  'CAS_ATTEMPTED',
  'COMMITTED',
  'CONFLICT',
  'STALE_BASELINE',
  'NEEDS_RECONCILIATION',
  'FAILED_CONFIRMED',
  'MANUAL_REVIEW',
  'SUPERSEDED',
  'CANCELLED',
  'STARTUP_RECONCILED',
] as const;
export type ConfigExecutionEventKind = (typeof CONFIG_EXECUTION_EVENT_KINDS)[number];

// 终态结果码：与终态一一对应（resultCode → status）。
export const CONFIG_EXECUTION_RESULT_CODES = [
  'COMMITTED',
  'NOOP_ALREADY_APPLIED',
  'CONFLICT',
  'STALE_BASELINE',
  'NEEDS_RECONCILIATION',
  'FAILED_ZERO_WRITE',
  'RECOVERED_COMMITTED',
  'MANUAL_REVIEW',
  'SUPERSEDED',
  'CANCELLED',
] as const;
export type ConfigExecutionResultCode = (typeof CONFIG_EXECUTION_RESULT_CODES)[number];

// resultCode → 终态（禁止失败/未知结果错配到 SUCCEEDED）。
export const CONFIG_EXECUTION_RESULT_CODE_STATUS = {
  COMMITTED: 'SUCCEEDED',
  NOOP_ALREADY_APPLIED: 'SUCCEEDED',
  RECOVERED_COMMITTED: 'SUCCEEDED',
  CONFLICT: 'CONFLICT',
  STALE_BASELINE: 'STALE_BASELINE',
  NEEDS_RECONCILIATION: 'NEEDS_RECONCILIATION',
  FAILED_ZERO_WRITE: 'FAILED_CONFIRMED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  SUPERSEDED: 'SUPERSEDED',
  CANCELLED: 'CANCELLED',
} as const;

// resultCode → semantics（单源；与 migration 的 semantics CHECK 逐条一致）。
// 失败 / 未知结果绝不能携带 COMMITTED 语义。
export const CONFIG_EXECUTION_RESULT_SEMANTICS = {
  COMMITTED: 'SANDBOX_CONFIG_MUTATION_COMMITTED',
  NOOP_ALREADY_APPLIED: 'SANDBOX_CONFIG_ALREADY_APPLIED_NO_WRITE',
  CONFLICT: 'SANDBOX_CONFIG_MUTATION_CONFLICT_NO_WRITE',
  STALE_BASELINE: 'SANDBOX_CONFIG_STALE_BASELINE_NO_WRITE',
  NEEDS_RECONCILIATION: 'SANDBOX_CONFIG_MUTATION_NEEDS_RECONCILIATION',
  FAILED_ZERO_WRITE: 'SANDBOX_CONFIG_MUTATION_FAILED_ZERO_WRITE',
  RECOVERED_COMMITTED: 'SANDBOX_CONFIG_MUTATION_RECOVERED_COMMITTED',
  MANUAL_REVIEW: 'SANDBOX_CONFIG_MUTATION_MANUAL_REVIEW',
  SUPERSEDED: 'SANDBOX_CONFIG_MUTATION_SUPERSEDED',
  CANCELLED: 'SANDBOX_CONFIG_MUTATION_CANCELLED',
} as const;
export type ConfigExecutionResultSemantics =
  (typeof CONFIG_EXECUTION_RESULT_SEMANTICS)[ConfigExecutionResultCode];

// 终态证据来源（区分正常执行 / read-back 恢复 / 启动对账 / 人工）。
export const CONFIG_EXECUTION_EVIDENCE_SOURCES = [
  'EXECUTION',
  'READBACK_RECOVERY',
  'STARTUP_RECONCILIATION',
  'MANUAL_OPERATOR',
] as const;
export type ConfigExecutionEvidenceSource = (typeof CONFIG_EXECUTION_EVIDENCE_SOURCES)[number];

export const CONFIG_EXECUTION_OUTBOX_TOPICS = ['CONTROLLED_CONFIG_EXECUTION_TERMINAL'] as const;
export type ConfigExecutionOutboxTopic = (typeof CONFIG_EXECUTION_OUTBOX_TOPICS)[number];

// 允许的状态迁移（终态一律不可再迁移）。
export const CONFIG_EXECUTION_TRANSITIONS = {
  RESERVED: ['EXECUTING', 'CANCELLED', 'SUPERSEDED'],
  EXECUTING: [
    'SUCCEEDED',
    'CONFLICT',
    'STALE_BASELINE',
    'NEEDS_RECONCILIATION',
    'FAILED_CONFIRMED',
    'MANUAL_REVIEW',
    'SUPERSEDED',
    'CANCELLED',
  ],
  SUCCEEDED: [],
  CONFLICT: [],
  STALE_BASELINE: [],
  NEEDS_RECONCILIATION: [],
  FAILED_CONFIRMED: [],
  MANUAL_REVIEW: [],
  SUPERSEDED: [],
  CANCELLED: [],
} as const;

export const CONFIG_EXECUTION_DURABILITY_BOUNDARY = {
  scope: 'PRODUCTION_GRADE_DURABILITY_SUBSTRATE_ONLY',
  environment: CONFIG_EXECUTION_ENVIRONMENTS,
  productionMutation: 'NOT_AUTHORIZED',
  boundaries: {
    PRODUCTION_ENABLED: false,
    PRODUCTION_CONFIG_MUTATION: false,
    AUTO_PROMOTION: false,
    AUTO_ROLLOUT: false,
    AUTO_PRODUCTION_ROLLBACK: false,
  },
  forbidden: [
    'second runtime',
    'second policy engine',
    'second control plane',
    'second model gateway',
    'second cost ledger',
    'second meta evidence store',
    'L5 relaxation',
    'real provider mutation',
    'external write',
    'payment',
    'transport',
    'production credentials',
  ],
  durability: [
    'durable reservation identity / owner identity / execution identity / reservation timestamp / status / lease',
    'UNIQUE(authorizationVerdictDigest) + UNIQUE(authorizationTicketDigest) + UNIQUE(idempotencyKey)',
    'RESERVED → EXECUTING → terminal（非法跳转 fail-closed；terminal 不得回到 EXECUTING）',
    'append-only 事件历史（不得 UPDATE 覆盖为「最后一次状态」）',
    'append-only 终态结果（post identity 只能完整已知或完整 UNKNOWN）',
    'transactional outbox + 消费者幂等交付账本',
    'lease / stale-lease takeover（ownerRef / leaseId / acquiredAt / renewedAt / expiresAt）',
    'crash recovery + startup reconciliation（idempotent；禁止 blind retry）',
  ],
} as const;

export type ConfigExecutionDurabilityCode =
  | 'CONFIG_EXECUTION_ILLEGAL_TRANSITION'
  | 'CONFIG_EXECUTION_TERMINAL_IMMUTABLE'
  | 'CONFIG_EXECUTION_ENVIRONMENT_FORBIDDEN'
  | 'CONFIG_EXECUTION_UNKNOWN_STATE';

export class ConfigExecutionDurabilityError extends Error {
  readonly code: ConfigExecutionDurabilityCode;

  constructor(code: ConfigExecutionDurabilityCode, message: string) {
    super(message);
    this.name = 'ConfigExecutionDurabilityError';
    this.code = code;
  }
}

export function isConfigExecutionReservationState(
  value: string,
): value is ConfigExecutionReservationState {
  return (CONFIG_EXECUTION_RESERVATION_STATES as readonly string[]).includes(value);
}

export function isConfigExecutionTerminalState(
  value: string,
): value is ConfigExecutionTerminalState {
  return (CONFIG_EXECUTION_TERMINAL_STATES as readonly string[]).includes(value);
}

export function isConfigExecutionNonTerminalState(
  value: string,
): value is ConfigExecutionNonTerminalState {
  return (CONFIG_EXECUTION_NON_TERMINAL_STATES as readonly string[]).includes(value);
}

// 同状态不算迁移（lease 续期 / attempt 递增等原地更新走这里）。
export function canTransitionConfigExecution(
  from: ConfigExecutionReservationState,
  to: ConfigExecutionReservationState,
): boolean {
  if (from === to) return true;
  const allowed = CONFIG_EXECUTION_TRANSITIONS[from] as readonly string[];
  return allowed.includes(to);
}

export function assertConfigExecutionTransition(
  from: ConfigExecutionReservationState,
  to: ConfigExecutionReservationState,
): void {
  if (isConfigExecutionTerminalState(from)) {
    throw new ConfigExecutionDurabilityError(
      'CONFIG_EXECUTION_TERMINAL_IMMUTABLE',
      `terminal(${from}) 不得再迁移到 ${to}`,
    );
  }
  if (!canTransitionConfigExecution(from, to)) {
    throw new ConfigExecutionDurabilityError(
      'CONFIG_EXECUTION_ILLEGAL_TRANSITION',
      `非法状态迁移：${from} -> ${to}`,
    );
  }
}

// NO PRODUCTION ENABLEMENT：只有 sandbox 环境可以通过（生产环境一律 fail-closed）。
export function assertConfigExecutionEnvironment(environment: string): ConfigExecutionEnvironment {
  if (!(CONFIG_EXECUTION_ENVIRONMENTS as readonly string[]).includes(environment)) {
    throw new ConfigExecutionDurabilityError(
      'CONFIG_EXECUTION_ENVIRONMENT_FORBIDDEN',
      `NO PRODUCTION ENABLEMENT：只接受 ${CONFIG_EXECUTION_ENVIRONMENTS.join('/')}，收到 ${environment}`,
    );
  }
  return environment as ConfigExecutionEnvironment;
}
