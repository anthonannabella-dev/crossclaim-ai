/**
 * C18-5 — PROVIDER IDEMPOTENCY / RETRY / RECONCILIATION（零外写，纯策略）
 * ---------------------------------------------------------------
 * 把「同 idempotencyKey + 同 payloadDigest = 同一次请求」这条 C17/C18 不变量落到 provider 调用策略上：
 *   · SUCCESS / CONFLICT / PERMANENT_FAILURE / RETRYABLE / AMBIGUOUS 五类结果显式区分；
 *   · AMBIGUOUS（超时、连接中断、5xx 后无响应）**绝不盲目重发**——必须先用 idempotencyKey 对账；
 *   · CONFLICT（同 key 不同 payload）是不可重试的协议错误；
 *   · 重试采用指数退避 + 抖动 + 上限（避免惊群）；
 *   · 对账只能产出 PROVIDER_VERIFIED 事实草案，不得直接产生已追回现金 / 计费依据。
 *
 * 本模块不改 C17 ledger、不新增 Schema、不做任何网络调用。
 */

export const CUSTOMS_PROVIDER_OPERATIONS = [
  'CREATE_SUBMISSION',
  'UPLOAD_EVIDENCE',
  'RESPOND_RFI',
  'GET_SUBMISSION_STATUS',
  'GET_REFUND_STATUS',
] as const;
export type CustomsProviderOperation = (typeof CUSTOMS_PROVIDER_OPERATIONS)[number];

export type CustomsProviderOutcome =
  | 'SUCCESS'
  | 'RETRYABLE'
  | 'CONFLICT'
  | 'PERMANENT_FAILURE'
  | 'AMBIGUOUS';

export interface ProviderRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

/** 只读操作可以更激进重试；写操作必须保守（歧义 → 对账，不重发）。 */
export const PROVIDER_RETRY_POLICIES: Record<CustomsProviderOperation, ProviderRetryPolicy> = {
  CREATE_SUBMISSION: { maxAttempts: 2, baseDelayMs: 2000, maxDelayMs: 30000, jitterRatio: 0.25 },
  UPLOAD_EVIDENCE: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000, jitterRatio: 0.25 },
  RESPOND_RFI: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000, jitterRatio: 0.25 },
  GET_SUBMISSION_STATUS: { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 60000, jitterRatio: 0.3 },
  GET_REFUND_STATUS: { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 60000, jitterRatio: 0.3 },
};

export interface ProviderCallResult {
  /** HTTP 状态（无响应时为 null）。 */
  httpStatus: number | null;
  /** 传输层是否成功完成（超时/连接中断 = false）。 */
  transportCompleted: boolean;
  /** provider 返回的错误码（如 IDEMPOTENCY_KEY_CONFLICT）。 */
  errorCode?: string | null;
}

/** provider 是否已书面/沙盒证明「同 key + 同 payload 可安全 replay」。未核验 = fail-closed。 */
export type ProviderIdempotencySemantics = 'REPLAY_SAFE' | 'UNVERIFIED';

/** 只读操作（可安全重复）与写操作（可能已生效）的分界。 */
export const PROVIDER_READ_ONLY_OPERATIONS: readonly CustomsProviderOperation[] = [
  'GET_SUBMISSION_STATUS',
  'GET_REFUND_STATUS',
];

/**
 * 结果分类（fail-closed）：
 *   · 无响应 / 超时 → AMBIGUOUS（可能已生效，绝不盲重试）
 *   · 409 / IDEMPOTENCY_KEY_CONFLICT → CONFLICT（不可重试）
 *   · 4xx（除 409/429）→ PERMANENT_FAILURE
 *   · 429 / 5xx：
 *       - 只读操作 → RETRYABLE
 *       - 写操作 → 只有当 provider 的该操作被证明 replay-safe 才 RETRYABLE；否则 AMBIGUOUS
 *         （provider 可能已经执行动作再返回 500，盲目重发会制造重复提交）
 *   · 2xx → SUCCESS
 */
export function classifyProviderOutcome(
  result: ProviderCallResult,
  options: {
    operation?: CustomsProviderOperation;
    idempotencySemantics?: ProviderIdempotencySemantics;
  } = {},
): CustomsProviderOutcome {
  if (!result.transportCompleted || result.httpStatus === null) return 'AMBIGUOUS';
  const code = (result.errorCode ?? '').toUpperCase();
  if (code === 'IDEMPOTENCY_KEY_CONFLICT') return 'CONFLICT';
  if (result.httpStatus === 409) return 'CONFLICT';
  if (result.httpStatus === 429 || result.httpStatus >= 500) {
    const readOnly =
      options.operation !== undefined && PROVIDER_READ_ONLY_OPERATIONS.includes(options.operation);
    if (readOnly) return 'RETRYABLE';
    return options.idempotencySemantics === 'REPLAY_SAFE' ? 'RETRYABLE' : 'AMBIGUOUS';
  }
  if (result.httpStatus >= 400) return 'PERMANENT_FAILURE';
  if (result.httpStatus >= 200 && result.httpStatus < 300) return 'SUCCESS';
  return 'AMBIGUOUS';
}

/** 只有 RETRYABLE 才允许自动重试；AMBIGUOUS 一律先对账。 */
export function isAutoRetryable(outcome: CustomsProviderOutcome): boolean {
  return outcome === 'RETRYABLE';
}

/** 指数退避 + 抖动 + 上限（random 可注入以便测试确定性）。 */
export class ProviderRetryExhaustedError extends Error {
  constructor(operation: CustomsProviderOperation, maxAttempts: number) {
    super('provider operation ' + operation + ' exhausted maxAttempts=' + maxAttempts);
    this.name = 'ProviderRetryExhaustedError';
  }
}

/** 重试次数守卫：超过 maxAttempts 一律拒绝（真实执行上限，不只是 backoff 封顶）。 */
export function canAutoRetry(input: {
  operation: CustomsProviderOperation;
  attempt: number;
  outcome: CustomsProviderOutcome;
}): boolean {
  if (!isAutoRetryable(input.outcome)) return false;
  return input.attempt <= PROVIDER_RETRY_POLICIES[input.operation].maxAttempts;
}

export function nextRetryDelayMs(input: {
  operation: CustomsProviderOperation;
  attempt: number;
  random?: () => number;
}): number {
  const policy = PROVIDER_RETRY_POLICIES[input.operation];
  if (!Number.isFinite(input.attempt) || input.attempt < 1) return policy.baseDelayMs;
  if (input.attempt > policy.maxAttempts) {
    throw new ProviderRetryExhaustedError(input.operation, policy.maxAttempts);
  }
  const attempt = input.attempt;
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const random = input.random ?? Math.random;
  const jitter = capped * policy.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

export type ProviderReconciliationAction =
  | 'LOOKUP_BY_IDEMPOTENCY_KEY'
  | 'COMPARE_PAYLOAD_DIGEST'
  | 'ADOPT_EXISTING_ON_MATCH'
  | 'MARK_CONFLICT_ON_MISMATCH'
  | 'NEVER_RESUBMIT_BLIND';

/**
 * 歧义结果的对账计划（确定性顺序）：
 *   1) 用 idempotencyKey 反查 provider 侧是否已有这次请求；
 *   2) 比对 immutable payloadDigest；
 *   3) 相同 → 采用既有结果（replay）；不同 → 记为冲突；
 *   4) 任何情况下都不得直接重发。
 */
export function buildProviderReconciliationPlan(input: {
  operation: CustomsProviderOperation;
  outcome: CustomsProviderOutcome;
}): { required: boolean; actions: readonly ProviderReconciliationAction[]; resubmitAllowed: false } {
  if (input.outcome !== 'AMBIGUOUS') {
    return { required: false, actions: [], resubmitAllowed: false };
  }
  return {
    required: true,
    actions: [
      'LOOKUP_BY_IDEMPOTENCY_KEY',
      'COMPARE_PAYLOAD_DIGEST',
      'ADOPT_EXISTING_ON_MATCH',
      'MARK_CONFLICT_ON_MISMATCH',
      'NEVER_RESUBMIT_BLIND',
    ],
    resubmitAllowed: false,
  };
}

export class ProviderBlindRetryError extends Error {
  constructor(operation: CustomsProviderOperation) {
    super('AMBIGUOUS provider outcome for ' + operation + ' must be reconciled, never blindly resubmitted');
    this.name = 'ProviderBlindRetryError';
  }
}

/** 执行前的守卫：歧义结果下禁止重发（调用方必须先跑对账计划）。 */
export function assertResubmitAllowed(input: {
  operation: CustomsProviderOperation;
  outcome: CustomsProviderOutcome;
}): void {
  if (input.outcome === 'AMBIGUOUS') throw new ProviderBlindRetryError(input.operation);
  if (input.outcome === 'CONFLICT' || input.outcome === 'PERMANENT_FAILURE') {
    throw new Error('PROVIDER_OUTCOME_NOT_RETRYABLE: ' + input.outcome);
  }
}
