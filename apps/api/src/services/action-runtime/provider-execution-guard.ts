/**
 * PHASE 3 U2/U3/U4 —— credential port（抽象）/ idempotency-exactly-once / retry-reconcile 策略
 * ---------------------------------------------------------------
 * 硬约束：
 *   - **不持有真实凭据**：credential port 只返回 **opaque ref**；无配置 → fail-closed；
 *   - exactly-once：同一 idempotencyKey 只允许一次真实执行；重放返回既有结果，绝不二次执行；
 *   - retry 有界：达到上限即停止；副作用未知（sideEffectConfirmedAbsent=false）→ MANUAL_REVIEW，绝不盲目重试；
 *   - 真实 provider 网络 / 外写 / 凭据 / 生产开闸全部继续 HOLD。
 */

export const PROVIDER_EXECUTION_BOUNDARY = {
  realCredentials: 'ABSENT（port 只返回 opaque ref）',
  externalWrite: 'HOLD',
  exactlyOnce: 'IDEMPOTENCY_KEY_REQUIRED（重放不二次执行）',
  retry: 'BOUNDED（maxAttempts 上限；无无限重试）',
  unknownSideEffect: 'MANUAL_REVIEW（fail-closed）',
  secondActionRuntime: 'FORBIDDEN',
} as const;

// ----------------------------- U2 credential port -----------------------------

export interface ProviderCredentialRef {
  /** opaque 引用（例如 vault key 名）——**绝不是**密钥本体 */
  credentialRef: string;
  providerName: string;
  organizationId: string;
}

export interface ProviderCredentialPort {
  resolveRef(input: { providerName: string; organizationId: string }): Promise<ProviderCredentialRef | null>;
}

export type CredentialResolution =
  | { ok: true; ref: ProviderCredentialRef }
  | { ok: false; reason: string };

/** 解析凭据引用（fail-closed）：未配置 / 空 ref / 非 opaque → 一律拒绝；绝不返回密钥本体 */
export async function resolveProviderCredential(
  port: ProviderCredentialPort | null | undefined,
  input: { providerName: string; organizationId: string },
): Promise<CredentialResolution> {
  if (port === null || port === undefined) return { ok: false, reason: 'PROVIDER_CREDENTIAL_PORT_NOT_CONFIGURED' };
  if (input.providerName.trim() === '' || input.organizationId.trim() === '') {
    return { ok: false, reason: 'PROVIDER_CREDENTIAL_IDENTITY_REQUIRED' };
  }
  const ref = await port.resolveRef({ providerName: input.providerName, organizationId: input.organizationId });
  if (ref === null || typeof ref.credentialRef !== 'string' || ref.credentialRef.trim() === '') {
    return { ok: false, reason: 'PROVIDER_CREDENTIAL_UNAVAILABLE' };
  }
  if (/^(sk|pk|Bearer)\s|^[A-Za-z0-9_-]{24,}$/.test(ref.credentialRef.trim())) {
    // 形似密钥本体 → 拒绝（必须是不透明引用）
    return { ok: false, reason: 'PROVIDER_CREDENTIAL_REF_NOT_OPAQUE' };
  }
  return { ok: true, ref };
}

// ------------------------- U3 idempotency / exactly-once -------------------------

export interface ProviderExecutionRecord {
  idempotencyKey: string;
  status: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  providerRef: string | null;
  attempts: number;
}

export type IdempotencyBegin =
  | { outcome: 'WON'; key: string }
  | { outcome: 'DUPLICATE'; key: string; record: ProviderExecutionRecord };

export interface ProviderIdempotencyStore {
  begin(input: { idempotencyKey: string }): IdempotencyBegin;
  complete(input: { idempotencyKey: string; status: ProviderExecutionRecord['status']; providerRef?: string | null }): ProviderExecutionRecord;
  get(idempotencyKey: string): ProviderExecutionRecord | null;
}

/** 进程内 exactly-once 账（dev/sandbox 用；durable 版本走既有 DB 约束，不新增第二账本） */
export function createInMemoryIdempotencyStore(): ProviderIdempotencyStore {
  const records = new Map<string, ProviderExecutionRecord>();
  return {
    begin({ idempotencyKey }) {
      const key = idempotencyKey.trim();
      if (key === '') throw new Error('PROVIDER_IDEMPOTENCY_KEY_REQUIRED');
      const existing = records.get(key);
      if (existing) return { outcome: 'DUPLICATE', key, record: existing };
      records.set(key, { idempotencyKey: key, status: 'UNKNOWN', providerRef: null, attempts: 1 });
      return { outcome: 'WON', key };
    },
    complete({ idempotencyKey, status, providerRef }) {
      const key = idempotencyKey.trim();
      const current = records.get(key);
      if (!current) throw new Error('PROVIDER_IDEMPOTENCY_UNKNOWN_KEY');
      const next: ProviderExecutionRecord = { ...current, status, providerRef: providerRef ?? null };
      records.set(key, next);
      return next;
    },
    get(idempotencyKey) {
      return records.get(idempotencyKey.trim()) ?? null;
    },
  };
}

// --------------------------- U4 retry / reconcile ---------------------------

export type RetryDecision = 'RETRY' | 'STOP' | 'MANUAL_REVIEW';

export interface RetryPolicy {
  maxAttempts: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 3 };

/**
 * retry 决策（有界 + fail-closed）：
 *   - 成功 → STOP；达到上限 → STOP；
 *   - 失败但确认无副作用 → RETRY（有界）；
 *   - 副作用未知 → MANUAL_REVIEW（绝不盲目重试）。
 */
export function decideProviderRetry(input: {
  attempts: number;
  lastStatus: ProviderExecutionRecord['status'];
  sideEffectConfirmedAbsent: boolean;
  policy?: RetryPolicy;
}): RetryDecision {
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  if (input.lastStatus === 'SUCCEEDED') return 'STOP';
  if (input.attempts >= policy.maxAttempts) return 'STOP';
  if (input.lastStatus === 'UNKNOWN' || input.sideEffectConfirmedAbsent !== true) return 'MANUAL_REVIEW';
  return 'RETRY';
}

/** reconcile 判定：UNKNOWN 结果 + 有 providerRef → 交由对账（人工/读工具），不自动重发 */
export function decideProviderReconcile(input: {
  status: ProviderExecutionRecord['status'];
  providerRef: string | null;
  sideEffectConfirmedAbsent: boolean;
}): { action: 'NO_ACTION' | 'RECONCILE_REQUIRED' | 'MANUAL_REVIEW'; reason: string } {
  if (input.status === 'SUCCEEDED' || input.sideEffectConfirmedAbsent === true) {
    return { action: 'NO_ACTION', reason: 'NO_RECONCILE_NEEDED' };
  }
  if (input.status === 'FAILED') return { action: 'NO_ACTION', reason: 'FAILED_CONFIRMED' };
  if (input.providerRef !== null) return { action: 'RECONCILE_REQUIRED', reason: 'PROVIDER_REF_PRESENT_UNKNOWN_STATUS' };
  return { action: 'MANUAL_REVIEW', reason: 'PROVIDER_OUTCOME_UNKNOWN_NO_REF' };
}
