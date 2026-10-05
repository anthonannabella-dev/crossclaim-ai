/**
 * PHASE 3 U1 —— Action Runtime / Provider Adapter 契约（合同层；零真实网络、零凭据）
 * ---------------------------------------------------------------
 * 授权：HOST 2026-10-06 PHASE 3 ACTION RUNTIME（provider adapter interface → credential port →
 * external-write gate → idempotency → exactly-once → retry/reconcile → HITL → result normalization →
 * sandbox/mock → failure/degraded → audit/evidence）。
 *
 * 硬约束：
 *   - 本模块只定义 **契约** 与 **fail-closed 判定**；不实现任何真实 provider 调用；
 *   - `REAL_MODEL_NETWORK` / `PAID_MODEL_CALLS` / `EXTERNAL_WRITE` / `PAYMENT` / `TRANSPORT` /
 *     `PRODUCTION_CREDENTIALS` / `PRODUCTION_ENABLEMENT` = HOLD：声明 `network` / `paid` / `write` /
 *     `moneyMovement` 能力的 adapter 一律 REJECT；
 *   - 契约里 **没有** 凭据字段；携带 apiKey/secret/token 等键的对象一律 fail-closed；
 *   - 结果归一化：非结构化 / 未知状态 → `UNKNOWN`（fail-closed，绝不当作成功）。
 */

export const PROVIDER_CAPABILITY_FLAGS = ['simulated', 'network', 'paid', 'write', 'moneyMovement'] as const;
export type ProviderCapabilityFlag = (typeof PROVIDER_CAPABILITY_FLAGS)[number];

export interface ProviderCapability {
  simulated?: boolean;
  network?: boolean;
  paid?: boolean;
  write?: boolean;
  moneyMovement?: boolean;
}

export interface ProviderInvokeRequest {
  /** 幂等键：同一逻辑动作重放必须复用同一 key（exactly-once 语义的基础） */
  idempotencyKey: string;
  action: string;
  organizationId: string;
  /** 只允许结构化、已脱敏的引用（不得携带凭据 / 原始客户 payload） */
  payloadRef: string;
  payloadDigest: string;
}

export type ProviderInvokeStatus = 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

export interface ProviderInvokeResult {
  status: ProviderInvokeStatus;
  providerRef: string | null;
  reasonCodes: readonly string[];
  /** provider 侧是否确认未产生副作用（用于 degraded / retry 决策；未知一律 false） */
  sideEffectConfirmedAbsent: boolean;
}

export interface ProviderAdapter {
  readonly providerName: string;
  readonly capability: ProviderCapability;
  invoke(request: ProviderInvokeRequest): Promise<ProviderInvokeResult>;
}

export const PROVIDER_ADAPTER_BOUNDARY = {
  realNetwork: 'HOLD',
  paidCalls: 'HOLD',
  externalWrite: 'HOLD',
  productionCredentials: 'ABSENT（契约无凭据字段）',
  secondActionRuntime: 'FORBIDDEN',
  idempotencyKey: 'REQUIRED（exactly-once 语义基础）',
  resultNormalization: 'FAIL_CLOSED（未知 → UNKNOWN，绝不当作成功）',
  credentialFields: 'FORBIDDEN（apiKey/secret/token 等键一律拒绝）',
} as const;

const CREDENTIAL_KEY_PATTERN = /(api[_-]?key|secret|token|password|credential|private[_-]?key|bearer)/i;

/** 凭据键扫描（fail-closed）：adapter / 请求 / 结果中一律不得出现凭据类字段 */
export function scanCredentialFields(candidate: unknown, depth = 0): readonly string[] {
  const found: string[] = [];
  if (depth > 4 || candidate === null || typeof candidate !== 'object') return found;
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) found.push(key);
    found.push(...scanCredentialFields(value, depth + 1));
  }
  return found;
}

export interface ProviderAdapterCheck {
  ok: boolean;
  reason: string;
  rejectedCapabilities: readonly ProviderCapabilityFlag[];
}

/**
 * adapter 契约校验（fail-closed）：
 *   - providerName 非空；
 *   - 能力元数据只能是已知 flag；
 *   - HOLD 期间 `network` / `paid` / `write` / `moneyMovement` 任一为 true → REJECT；
 *   - 出现凭据类字段 → REJECT。
 */
export function assertProviderAdapter(adapter: ProviderAdapter): ProviderAdapterCheck {
  const name = typeof adapter?.providerName === 'string' ? adapter.providerName.trim() : '';
  if (name === '') return { ok: false, reason: 'PROVIDER_ADAPTER_NAME_REQUIRED', rejectedCapabilities: [] };
  const capability = (adapter as { capability?: ProviderCapability }).capability ?? {};
  const unknown = Object.keys(capability).filter(
    (key) => !(PROVIDER_CAPABILITY_FLAGS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    return { ok: false, reason: 'PROVIDER_ADAPTER_CAPABILITY_UNKNOWN:' + unknown.join(','), rejectedCapabilities: [] };
  }
  const rejected = PROVIDER_CAPABILITY_FLAGS.filter(
    (flag) => flag !== 'simulated' && capability[flag] === true,
  );
  if (rejected.length > 0) {
    return {
      ok: false,
      reason: 'PROVIDER_ADAPTER_HOLD_FORBIDDEN:' + rejected.join(','),
      rejectedCapabilities: rejected,
    };
  }
  const credentialKeys = scanCredentialFields(adapter);
  if (credentialKeys.length > 0) {
    return {
      ok: false,
      reason: 'PROVIDER_ADAPTER_CREDENTIAL_FIELDS_FORBIDDEN:' + credentialKeys.join(','),
      rejectedCapabilities: [],
    };
  }
  return { ok: true, reason: 'PROVIDER_ADAPTER_ACCEPTED', rejectedCapabilities: [] };
}

/** external-write gate（fail-closed）：HOLD / transport 关闭 / guard 非 ALLOW / 缺幂等键 → DENY */
export function decideExternalWriteGate(input: {
  adapter: ProviderAdapter;
  request: ProviderInvokeRequest;
  transportEnabled?: boolean;
  guardDecision?: 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL';
}): { allowed: boolean; reason: string } {
  const check = assertProviderAdapter(input.adapter);
  if (!check.ok) return { allowed: false, reason: check.reason };
  const key = typeof input.request?.idempotencyKey === 'string' ? input.request.idempotencyKey.trim() : '';
  if (key === '') return { allowed: false, reason: 'EXTERNAL_WRITE_IDEMPOTENCY_KEY_REQUIRED' };
  if (input.transportEnabled !== true) return { allowed: false, reason: 'EXTERNAL_WRITE_TRANSPORT_DISABLED' };
  if (input.guardDecision !== 'ALLOW') {
    return { allowed: false, reason: 'EXTERNAL_WRITE_GUARD_NOT_ALLOW:' + String(input.guardDecision ?? 'UNSET') };
  }
  if (input.request.payloadRef.trim() === '' || input.request.payloadDigest.trim() === '') {
    return { allowed: false, reason: 'EXTERNAL_WRITE_PAYLOAD_REF_REQUIRED' };
  }
  return { allowed: false, reason: 'EXTERNAL_WRITE_HOLD（PHASE 3 仅契约与 mock；真实外写仍 HOLD）' };
}

/** provider 结果归一化（fail-closed）：畸形 / 未知 → UNKNOWN */
export function normalizeProviderResult(raw: unknown): ProviderInvokeResult {
  if (raw === null || typeof raw !== 'object') {
    return { status: 'UNKNOWN', providerRef: null, reasonCodes: ['PROVIDER_RESULT_MALFORMED'], sideEffectConfirmedAbsent: false };
  }
  const row = raw as Record<string, unknown>;
  if (scanCredentialFields(row).length > 0) {
    return { status: 'UNKNOWN', providerRef: null, reasonCodes: ['PROVIDER_RESULT_CREDENTIAL_FIELDS'], sideEffectConfirmedAbsent: false };
  }
  const status = row.status;
  const normalized: ProviderInvokeStatus =
    status === 'SUCCEEDED' ? 'SUCCEEDED' : status === 'FAILED' ? 'FAILED' : 'UNKNOWN';
  return {
    status: normalized,
    providerRef: typeof row.providerRef === 'string' && row.providerRef !== '' ? row.providerRef : null,
    reasonCodes: Array.isArray(row.reasonCodes) ? (row.reasonCodes as string[]).filter((x) => typeof x === 'string') : ['PROVIDER_RESULT_UNSTRUCTURED'],
    sideEffectConfirmedAbsent: row.sideEffectConfirmedAbsent === true,
  };
}

export type MockProviderBehavior = 'SUCCESS' | 'FAIL' | 'DEGRADED';

/** sandbox / mock provider（无网络、无凭据；仅用于契约与失败路径验证） */
export function createMockProviderAdapter(options: {
  providerName: string;
  behavior?: MockProviderBehavior;
  onInvoke?: () => void;
}): ProviderAdapter {
  const behavior = options.behavior ?? 'SUCCESS';
  return {
    providerName: options.providerName,
    capability: { simulated: true, network: false, paid: false, write: false, moneyMovement: false },
    async invoke(): Promise<ProviderInvokeResult> {
      options.onInvoke?.();
      if (behavior === 'FAIL') {
        return { status: 'FAILED', providerRef: null, reasonCodes: ['MOCK_PROVIDER_FAILED'], sideEffectConfirmedAbsent: true };
      }
      if (behavior === 'DEGRADED') {
        return { status: 'UNKNOWN', providerRef: null, reasonCodes: ['MOCK_PROVIDER_DEGRADED'], sideEffectConfirmedAbsent: false };
      }
      return { status: 'SUCCEEDED', providerRef: 'mock:' + options.providerName, reasonCodes: ['MOCK_PROVIDER_OK'], sideEffectConfirmedAbsent: false };
    },
  };
}
