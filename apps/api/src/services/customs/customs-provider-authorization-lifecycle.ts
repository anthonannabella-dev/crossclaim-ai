/**
 * C18-7 — PROVIDER AUTHORIZATION LIFECYCLE（Layer 3 / P0 真实 Customs Provider 接入，离线层）
 * ---------------------------------------------------------------
 * 把内部 CA-3 授权生命周期（POA / Authorized Signer，append-only GRANT/RENEW/REVOKE）
 * 与 **provider 侧**授权生命周期（provider 自己的授权引用被撤销 / 过期 / 要求重授权 / 暂停）对齐。
 *
 * 硬规则（fail-closed，零外写、零凭据、零网络）：
 *   · provider 侧状态是 server-derived：要么来自验签过的 webhook，要么来自轮询查询，绝不接受调用方自报；
 *   · 内部授权与 provider 授权**必须同时有效**才允许提交，任一为 REVOKED/EXPIRED/REAUTH_REQUIRED/
 *     SUSPENDED/UNKNOWN/CONFLICT 一律拒绝（不猜、不盲提交）；
 *   · provider 撤销 / 过期 → 只能以**追加事实**方式传播到内部生命周期（返回计划，不在本模块写库）；
 *   · 需要重授权时只给出客户/系统动作（RENEW_POA / RE_SIGN_POA / CONTACT_PROVIDER），
 *     绝不自动提交、绝不自动扣费。
 */

export const PROVIDER_AUTHORIZATION_EVENT_KINDS = [
  'GRANTED',
  'RENEWED',
  'RESTORED',
  'REVOKED',
  'EXPIRED',
  'REAUTH_REQUIRED',
  'SUSPENDED',
] as const;
export type ProviderAuthorizationEventKind = (typeof PROVIDER_AUTHORIZATION_EVENT_KINDS)[number];

export const PROVIDER_AUTHORIZATION_STATUSES = [
  'ACTIVE',
  'REVOKED',
  'EXPIRED',
  'REAUTH_REQUIRED',
  'SUSPENDED',
  'UNKNOWN',
] as const;
export type ProviderAuthorizationStatus = (typeof PROVIDER_AUTHORIZATION_STATUSES)[number];

export type ProviderAuthorizationValidationError =
  | 'INVALID_EVENT_KIND'
  | 'INVALID_PROVIDER_REF'
  | 'INVALID_OBSERVED_AT'
  | 'INVALID_EFFECTIVE_AT'
  | 'INVALID_EXPIRY_WINDOW'
  | 'MISSING_SOURCE_REF';

export interface ProviderAuthorizationEvent {
  providerId: string;
  providerAuthorizationRef: string;
  organizationId: string;
  principalRef: string;
  kind: ProviderAuthorizationEventKind;
  /** provider 侧事件生效时间（ISO）。 */
  effectiveAt: string;
  /** server 观察到的时间（ISO；来自验签 webhook / 轮询，不由调用方自报）。 */
  observedAt: string;
  expiresAt?: string | null;
  reasonCode?: string | null;
  /** opaque 证据引用（webhook delivery id / 轮询批次 id）。 */
  sourceRef: string;
}

const OPAQUE_REF_RE = /^[A-Za-z0-9._:@#/-]{1,96}$/;
const RAW_URL_SCHEME_RE = /^(https?:\/\/|javascript:|data:|file:)/i;

export function isOpaqueAuthorizationRef(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (RAW_URL_SCHEME_RE.test(value)) return false;
  return OPAQUE_REF_RE.test(value);
}

export function validateProviderAuthorizationEvent(
  event: ProviderAuthorizationEvent,
): { ok: true } | { ok: false; errors: readonly ProviderAuthorizationValidationError[] } {
  const errors: ProviderAuthorizationValidationError[] = [];
  if (!(PROVIDER_AUTHORIZATION_EVENT_KINDS as readonly string[]).includes(event?.kind)) {
    errors.push('INVALID_EVENT_KIND');
  }
  for (const ref of [event?.providerId, event?.providerAuthorizationRef, event?.organizationId, event?.principalRef]) {
    if (!isOpaqueAuthorizationRef(ref)) errors.push('INVALID_PROVIDER_REF');
  }
  if (!isOpaqueAuthorizationRef(event?.sourceRef)) errors.push('MISSING_SOURCE_REF');
  const observed = Date.parse(event?.observedAt ?? '');
  if (Number.isNaN(observed)) errors.push('INVALID_OBSERVED_AT');
  const effective = Date.parse(event?.effectiveAt ?? '');
  if (Number.isNaN(effective)) errors.push('INVALID_EFFECTIVE_AT');
  if (event?.expiresAt != null) {
    const expires = Date.parse(event.expiresAt);
    if (Number.isNaN(expires)) errors.push('INVALID_EXPIRY_WINDOW');
    else if (!Number.isNaN(effective) && expires <= effective) errors.push('INVALID_EXPIRY_WINDOW');
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export interface DerivedProviderAuthorizationState {
  status: ProviderAuthorizationStatus;
  expiresAt: string | null;
  lastEffectiveAt: string | null;
  lastObservedAt: string | null;
  /** 同一时间点出现互相矛盾的事件（无法判定）→ 必须 fail-closed。 */
  conflict: boolean;
  appliedEventCount: number;
}

const sortKey = (event: ProviderAuthorizationEvent): string =>
  `${event.effectiveAt}|${event.observedAt}|${event.sourceRef}`;

/**
 * 确定性折叠：按 effectiveAt → observedAt → sourceRef 排序后逐条应用。
 * REVOKED / EXPIRED 只能被**严格更晚**的 GRANTED / RENEWED / RESTORED 解除。
 * 同一时间点（effectiveAt + observedAt 相同）出现不同事件类型 → conflict（UNKNOWN）。
 */
export function deriveProviderAuthorizationState(
  events: readonly ProviderAuthorizationEvent[],
  now: Date,
): DerivedProviderAuthorizationState {
  const valid = (events ?? []).filter((event) => validateProviderAuthorizationEvent(event).ok);
  if (valid.length === 0) {
    return {
      status: 'UNKNOWN',
      expiresAt: null,
      lastEffectiveAt: null,
      lastObservedAt: null,
      conflict: false,
      appliedEventCount: 0,
    };
  }

  const buckets = new Map<string, Set<ProviderAuthorizationEventKind>>();
  for (const event of valid) {
    const key = `${event.effectiveAt}|${event.observedAt}`;
    buckets.set(key, (buckets.get(key) ?? new Set<ProviderAuthorizationEventKind>()).add(event.kind));
  }
  const conflict = [...buckets.values()].some((kinds) => kinds.size > 1);

  const sorted = [...valid].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  let status: ProviderAuthorizationStatus = 'UNKNOWN';
  let expiresAt: string | null = null;
  let lastEffectiveAt: string | null = null;
  let lastObservedAt: string | null = null;
  let revoked = false;
  let expired = false;

  for (const event of sorted) {
    lastEffectiveAt = event.effectiveAt;
    lastObservedAt = event.observedAt;
    switch (event.kind) {
      case 'GRANTED':
      case 'RENEWED':
      case 'RESTORED':
        // 严格更晚的授权事件解除 REVOKED / EXPIRED；同一或更早时间不解除。
        revoked = false;
        expired = false;
        status = 'ACTIVE';
        expiresAt = event.expiresAt ?? null;
        break;
      case 'REVOKED':
        revoked = true;
        status = 'REVOKED';
        break;
      case 'EXPIRED':
        expired = true;
        status = 'EXPIRED';
        break;
      case 'REAUTH_REQUIRED':
        status = revoked ? 'REVOKED' : expired ? 'EXPIRED' : 'REAUTH_REQUIRED';
        break;
      case 'SUSPENDED':
        status = revoked ? 'REVOKED' : expired ? 'EXPIRED' : 'SUSPENDED';
        break;
    }
  }

  if (conflict) status = 'UNKNOWN';
  if (status === 'ACTIVE' && expiresAt !== null && now.getTime() >= Date.parse(expiresAt)) {
    status = 'EXPIRED';
  }

  return {
    status,
    expiresAt,
    lastEffectiveAt,
    lastObservedAt,
    conflict,
    appliedEventCount: sorted.length,
  };
}

export type InternalAuthorizationStatus = 'VERIFIED' | 'PENDING' | 'REVOKED' | 'EXPIRED' | 'MISSING';

export type ProviderSubmissionPreconditionReasonCode =
  | 'SUBMISSION_AUTHORIZED'
  | 'INTERNAL_AUTHORIZATION_NOT_VERIFIED'
  | 'INTERNAL_AUTHORIZATION_REVOKED'
  | 'PROVIDER_AUTHORIZATION_UNKNOWN'
  | 'PROVIDER_AUTHORIZATION_REVOKED'
  | 'PROVIDER_AUTHORIZATION_EXPIRED'
  | 'PROVIDER_AUTHORIZATION_REAUTH_REQUIRED'
  | 'PROVIDER_AUTHORIZATION_SUSPENDED'
  | 'PROVIDER_AUTHORIZATION_CONFLICT';

export type ReauthorizationAction =
  | 'NONE'
  | 'WAIT_FOR_CUSTOMER'
  | 'RENEW_POA'
  | 'RE_SIGN_POA'
  | 'REQUEST_PROVIDER_ATTESTATION'
  | 'CONTACT_PROVIDER';

export interface ProviderSubmissionPreconditionInput {
  internal: { status: InternalAuthorizationStatus };
  provider: DerivedProviderAuthorizationState;
  now: Date;
}

export interface ProviderSubmissionPrecondition {
  allowed: boolean;
  reasonCode: ProviderSubmissionPreconditionReasonCode;
  requiredAction: ReauthorizationAction;
  /** 只有 allowed=true 才给出 provider 侧状态的可执行判定。 */
  providerStatus: ProviderAuthorizationStatus;
  externalWritePerformed: false;
  filingSubmitted: false;
  transportEnabled: false;
  productionCredentials: 'ABSENT';
}

const DENY = (
  reasonCode: ProviderSubmissionPreconditionReasonCode,
  requiredAction: ReauthorizationAction,
  providerStatus: ProviderAuthorizationStatus,
): ProviderSubmissionPrecondition => ({
  allowed: false,
  reasonCode,
  requiredAction,
  providerStatus,
  externalWritePerformed: false,
  filingSubmitted: false,
  transportEnabled: false,
  productionCredentials: 'ABSENT',
});

/** 内部授权与 provider 授权必须**同时有效**才允许提交；任何不确定都 fail-closed。 */
export function evaluateProviderSubmissionPrecondition(
  input: ProviderSubmissionPreconditionInput,
): ProviderSubmissionPrecondition {
  const providerStatus = input.provider?.status ?? 'UNKNOWN';

  if (input.provider?.conflict === true) {
    return DENY('PROVIDER_AUTHORIZATION_CONFLICT', 'CONTACT_PROVIDER', 'UNKNOWN');
  }
  if (input.internal?.status === 'MISSING') {
    return DENY('INTERNAL_AUTHORIZATION_NOT_VERIFIED', 'WAIT_FOR_CUSTOMER', providerStatus);
  }
  if (input.internal?.status === 'REVOKED') {
    return DENY('INTERNAL_AUTHORIZATION_REVOKED', 'RE_SIGN_POA', providerStatus);
  }
  if (input.internal?.status === 'EXPIRED') {
    return DENY('INTERNAL_AUTHORIZATION_NOT_VERIFIED', 'RENEW_POA', providerStatus);
  }
  if (input.internal?.status === 'PENDING') {
    return DENY('INTERNAL_AUTHORIZATION_NOT_VERIFIED', 'WAIT_FOR_CUSTOMER', providerStatus);
  }

  switch (providerStatus) {
    case 'ACTIVE':
      return {
        allowed: true,
        reasonCode: 'SUBMISSION_AUTHORIZED',
        requiredAction: 'NONE',
        providerStatus,
        externalWritePerformed: false,
        filingSubmitted: false,
        transportEnabled: false,
        productionCredentials: 'ABSENT',
      };
    case 'REVOKED':
      return DENY('PROVIDER_AUTHORIZATION_REVOKED', 'RE_SIGN_POA', providerStatus);
    case 'EXPIRED':
      return DENY('PROVIDER_AUTHORIZATION_EXPIRED', 'RENEW_POA', providerStatus);
    case 'REAUTH_REQUIRED':
      return DENY('PROVIDER_AUTHORIZATION_REAUTH_REQUIRED', 'REQUEST_PROVIDER_ATTESTATION', providerStatus);
    case 'SUSPENDED':
      return DENY('PROVIDER_AUTHORIZATION_SUSPENDED', 'CONTACT_PROVIDER', providerStatus);
    default:
      return DENY('PROVIDER_AUTHORIZATION_UNKNOWN', 'REQUEST_PROVIDER_ATTESTATION', 'UNKNOWN');
  }
}

export interface ProviderRevocationPropagationPlan {
  kind: 'APPEND_AUTHORIZATION_FACT';
  subject: 'PROVIDER_AUTHORIZATION';
  action: 'REVOKE';
  lifecycleKey: string;
  reasonCode: string;
  sourceRef: string;
  /** 只追加，永不就地改写历史授权事实。 */
  appendOnly: true;
  historyMutatedInPlace: false;
  externalWritePerformed: false;
  transportEnabled: false;
  productionCredentials: 'ABSENT';
}

/**
 * provider 侧撤销 / 过期 → 内部生命周期的**追加事实**计划（本模块不写库，由调用方在事务内执行）。
 * 非法事件或不支持的事件类型一律拒绝，避免把未知 provider 状态"翻译"成撤销事实。
 */
export function planProviderRevocationPropagation(input: {
  event: ProviderAuthorizationEvent;
  lifecycleKey: string;
}): ProviderRevocationPropagationPlan | null {
  const validation = validateProviderAuthorizationEvent(input.event);
  if (!validation.ok) return null;
  if (!isOpaqueAuthorizationRef(input.lifecycleKey)) return null;
  if (input.event.kind !== 'REVOKED' && input.event.kind !== 'EXPIRED') return null;
  return {
    kind: 'APPEND_AUTHORIZATION_FACT',
    subject: 'PROVIDER_AUTHORIZATION',
    action: 'REVOKE',
    lifecycleKey: input.lifecycleKey,
    reasonCode: input.event.reasonCode ?? (input.event.kind === 'REVOKED' ? 'PROVIDER_REVOKED' : 'PROVIDER_EXPIRED'),
    sourceRef: input.event.sourceRef,
    appendOnly: true,
    historyMutatedInPlace: false,
    externalWritePerformed: false,
    transportEnabled: false,
    productionCredentials: 'ABSENT',
  };
}

/** 边界自证：C18-7 离线层不产生任何外部写 / 凭据使用 / 资金动作。 */
export const CUSTOMS_PROVIDER_AUTHORIZATION_LIFECYCLE_BOUNDARY = {
  externalWritePerformed: false,
  filingSubmitted: false,
  transportEnabled: false,
  providerAuthorizationMutationPerformed: false,
  credentialReadPerformed: false,
  productionCredentials: 'ABSENT',
} as const;
