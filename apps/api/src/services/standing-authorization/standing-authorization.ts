// STANDING AUTHORIZATION / RISK-TIERED EXECUTION — slice SA-1 — 授权核心（可审计、版本化、可撤销）
// ---------------------------------------------------------------------------
// 审计结论：既有 Action Guard（`services/action-guard/*`）已有动作目录（risk + requires gates）与
//   一次性 humanApproval 语义；**不存在**任何 standing / delegated authorization。
//   本模块只新增「长期授权的记录与判定」，**不新建第二套 approval / guard**：
//   最终执行权仍由既有 Action Guard 决定（见 action-guard-wiring.ts）。
//
// 硬边界：
//   ① 授权必须 server-derived（客户端自报 scope 一律拒绝）；
//   ② 版本化：授权被修改后旧版本不得静默继续生效（版本不匹配 → DENY）；
//   ③ 可撤销：撤销 / 过期 / 未生效 → 立即 fail-closed（DENY）；
//   ④ tenant / account / provider 不匹配 → DENY；
//   ⑤ 超出金额上限或不在 allowedActionTypes 内 → **REQUIRE_APPROVAL**（超范围走 HITL，而不是放行）；
//   ⑥ 授权**不能**满足 Production Gate / Platform Enablement / Kill Switch / Provider capability /
//      Credential gate / Customs·Broker·POA gate / Regulatory restriction / tenant·account isolation。

import { digestOf } from '../config-execution-durability/digests';

export const STANDING_AUTHORIZATION_VERSION = 'standing-authorization/v1';

export const STANDING_AUTHORIZATION_STATES = ['ACTIVE', 'REVOKED', 'SUSPENDED'] as const;
export type StandingAuthorizationState = (typeof STANDING_AUTHORIZATION_STATES)[number];

export const STANDING_AUTHORIZATION_DECISIONS = ['SATISFIED', 'REQUIRE_APPROVAL', 'DENY'] as const;
export type StandingAuthorizationDecision = (typeof STANDING_AUTHORIZATION_DECISIONS)[number];

/** 授权可满足的 gate（**只有这一个**）：per-action 的一次性人工审批 */
export const STANDING_AUTHORIZATION_SATISFIABLE_GATES = ['humanApproval'] as const;
export type StandingAuthorizationSatisfiableGate = (typeof STANDING_AUTHORIZATION_SATISFIABLE_GATES)[number];

/** 授权**永远不能**满足的 gate（越权尝试一律 DENY） */
export const STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES = [
  'productionGate',
  'platformEnablement',
  'killSwitch',
  'providerCapability',
  'credentialGate',
  'customsPoaGate',
  'regulatoryRestriction',
  'tenantAccountIsolation',
] as const;
export type StandingAuthorizationNonBypassableGate = (typeof STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES)[number];

export interface StandingAuthorizationRecord {
  authorizationId: string;
  kind: 'STANDING_AUTHORIZATION';
  organizationId: string;
  platformAccountId: string;
  provider: string;
  allowedActionTypes: readonly string[];
  /** 该授权允许自动执行的金额上限（USD 口径；超过 → REQUIRE_APPROVAL） */
  monetaryLimitUsd: number;
  currency: string;
  domain: string;
  jurisdiction: string;
  effectiveAt: string;
  expiresAt: string;
  /** 授权版本：修改后必须递增；旧版本不得继续使用 */
  authorizationVersion: number;
  /** 条款 / 政策版本（与客户同意的版本绑定） */
  termsPolicyVersion: string;
  /** 客户同意证据引用（server-derived 存储） */
  consentEvidenceRef: string;
  revocation: {
    state: StandingAuthorizationState;
    revokedAt: string | null;
    revokedBy: string | null;
    reason: string | null;
  };
  /** scope digest：对上述 scope 字段的规范化摘要（防篡改 / 便于审计） */
  scopeDigest: string;
  /** 必须为 true；客户端自报授权一律拒绝 */
  readonly serverDerived: true;
  createdAt: string;
}

export interface StandingAuthorizationRequest {
  organizationId: string;
  platformAccountId: string;
  provider: string;
  action: string;
  amountUsd: number | null;
  currency: string;
  domain: string;
  jurisdiction: string;
  /** 调用方持有的授权版本（旧版本继续使用 → DENY） */
  expectedAuthorizationVersion?: number | null;
  /** 调用方声明的条款版本（不一致 → DENY） */
  expectedTermsPolicyVersion?: string | null;
}

export type StandingAuthorizationReasonCode =
  | 'STANDING_AUTH_MISSING'
  | 'STANDING_AUTH_NOT_SERVER_DERIVED'
  | 'STANDING_AUTH_SCOPE_DIGEST_MISMATCH'
  | 'STANDING_AUTH_REVOKED'
  | 'STANDING_AUTH_SUSPENDED'
  | 'STANDING_AUTH_EXPIRED'
  | 'STANDING_AUTH_NOT_YET_EFFECTIVE'
  | 'STANDING_AUTH_ORG_MISMATCH'
  | 'STANDING_AUTH_ACCOUNT_MISMATCH'
  | 'STANDING_AUTH_PROVIDER_MISMATCH'
  | 'STANDING_AUTH_DOMAIN_MISMATCH'
  | 'STANDING_AUTH_JURISDICTION_MISMATCH'
  | 'STANDING_AUTH_CURRENCY_MISMATCH'
  | 'STANDING_AUTH_ACTION_NOT_ALLOWED'
  | 'STANDING_AUTH_AMOUNT_EXCEEDS_LIMIT'
  | 'STANDING_AUTH_AMOUNT_UNKNOWN'
  | 'STANDING_AUTH_VERSION_STALE'
  | 'STANDING_AUTH_TERMS_POLICY_MISMATCH'
  | 'STANDING_AUTH_CONSENT_EVIDENCE_MISSING';

export interface StandingAuthorizationEvaluation {
  kind: 'STANDING_AUTHORIZATION_EVALUATION';
  version: string;
  decision: StandingAuthorizationDecision;
  satisfiedGate: StandingAuthorizationSatisfiableGate | null;
  authorizationId: string | null;
  authorizationVersion: number | null;
  scopeDigest: string | null;
  reasonCodes: StandingAuthorizationReasonCode[];
  requiresOneTimeApproval: boolean;
  evaluatedAt: string;
  evaluationDigest: string;
}

export type StandingAuthorizationErrorCode =
  | 'STANDING_AUTH_CLIENT_FORGED'
  | 'STANDING_AUTH_INVALID_RECORD'
  | 'STANDING_AUTH_CANNOT_BYPASS_GATE';

export class StandingAuthorizationError extends Error {
  readonly code: StandingAuthorizationErrorCode;

  constructor(code: StandingAuthorizationErrorCode, message: string) {
    super(message);
    this.name = 'StandingAuthorizationError';
    this.code = code;
  }
}

/** scope digest：只覆盖 scope 相关字段（不含 revocation / createdAt，便于撤销时保持同一 scope 身份） */
export function computeStandingAuthorizationScopeDigest(input: {
  organizationId: string;
  platformAccountId: string;
  provider: string;
  allowedActionTypes: readonly string[];
  monetaryLimitUsd: number;
  currency: string;
  domain: string;
  jurisdiction: string;
  effectiveAt: string;
  expiresAt: string;
  authorizationVersion: number;
  termsPolicyVersion: string;
}): string {
  return digestOf({
    organizationId: input.organizationId,
    platformAccountId: input.platformAccountId,
    provider: input.provider,
    allowedActionTypes: [...input.allowedActionTypes].sort(),
    monetaryLimitUsd: input.monetaryLimitUsd,
    currency: input.currency,
    domain: input.domain,
    jurisdiction: input.jurisdiction,
    effectiveAt: input.effectiveAt,
    expiresAt: input.expiresAt,
    authorizationVersion: input.authorizationVersion,
    termsPolicyVersion: input.termsPolicyVersion,
  });
}

/** 创建（server-derived）授权；客户端自报 scope 一律抛错 */
export function createStandingAuthorization(input: {
  serverDerived: boolean;
  authorizationId: string;
  organizationId: string;
  platformAccountId: string;
  provider: string;
  allowedActionTypes: readonly string[];
  monetaryLimitUsd: number;
  currency: string;
  domain: string;
  jurisdiction: string;
  effectiveAt: string;
  expiresAt: string;
  authorizationVersion: number;
  termsPolicyVersion: string;
  consentEvidenceRef: string;
  createdAt: string;
}): StandingAuthorizationRecord {
  if (input.serverDerived !== true) {
    throw new StandingAuthorizationError(
      'STANDING_AUTH_CLIENT_FORGED',
      'Standing Authorization 必须 server-derived；客户端自报 scope 一律拒绝。',
    );
  }
  if (
    input.allowedActionTypes.length === 0 ||
    input.consentEvidenceRef.trim().length === 0 ||
    input.termsPolicyVersion.trim().length === 0 ||
    !Number.isFinite(input.monetaryLimitUsd) ||
    input.monetaryLimitUsd < 0
  ) {
    throw new StandingAuthorizationError(
      'STANDING_AUTH_INVALID_RECORD',
      '授权记录不完整（allowedActionTypes / consentEvidenceRef / termsPolicyVersion / monetaryLimitUsd）。',
    );
  }
  if (Date.parse(input.expiresAt) <= Date.parse(input.effectiveAt)) {
    throw new StandingAuthorizationError('STANDING_AUTH_INVALID_RECORD', 'expiresAt 必须晚于 effectiveAt。');
  }
  const scopeDigest = computeStandingAuthorizationScopeDigest(input);
  return {
    kind: 'STANDING_AUTHORIZATION',
    authorizationId: input.authorizationId,
    organizationId: input.organizationId,
    platformAccountId: input.platformAccountId,
    provider: input.provider,
    allowedActionTypes: [...input.allowedActionTypes].sort(),
    monetaryLimitUsd: input.monetaryLimitUsd,
    currency: input.currency,
    domain: input.domain,
    jurisdiction: input.jurisdiction,
    effectiveAt: input.effectiveAt,
    expiresAt: input.expiresAt,
    authorizationVersion: input.authorizationVersion,
    termsPolicyVersion: input.termsPolicyVersion,
    consentEvidenceRef: input.consentEvidenceRef,
    revocation: { state: 'ACTIVE', revokedAt: null, revokedBy: null, reason: null },
    scopeDigest,
    serverDerived: true,
    createdAt: input.createdAt,
  };
}

/** 撤销（版本不变，状态转 REVOKED；旧执行权立即失效） */
export function revokeStandingAuthorization(
  record: StandingAuthorizationRecord,
  input: { revokedBy: string; reason: string; at: string },
): StandingAuthorizationRecord {
  return {
    ...record,
    revocation: { state: 'REVOKED', revokedAt: input.at, revokedBy: input.revokedBy, reason: input.reason },
  };
}

/** 版本升级（旧的 expectedAuthorizationVersion 将不再匹配 → 旧执行权失效） */
export function bumpStandingAuthorizationVersion(
  record: StandingAuthorizationRecord,
  input: { authorizationVersion: number; termsPolicyVersion?: string },
): StandingAuthorizationRecord {
  const next = {
    ...record,
    authorizationVersion: input.authorizationVersion,
    termsPolicyVersion: input.termsPolicyVersion ?? record.termsPolicyVersion,
  };
  return { ...next, scopeDigest: computeStandingAuthorizationScopeDigest(next) };
}

/**
 * 评估 standing authorization 是否满足该请求（fail-closed）。
 * 注意：SATISFIED 仅代表「可满足 humanApproval 这一道 gate」，不代表可以执行 ——
 * 最终执行权仍需既有 Action Guard + 非可绕过 gate 全部通过。
 */
export function evaluateStandingAuthorization(input: {
  authorization: StandingAuthorizationRecord | null;
  request: StandingAuthorizationRequest;
  now: Date;
}): StandingAuthorizationEvaluation {
  const reasonCodes: StandingAuthorizationReasonCode[] = [];
  const request = input.request;
  const nowIso = input.now.toISOString();
  const auth = input.authorization;

  const build = (
    decision: StandingAuthorizationDecision,
    satisfiedGate: StandingAuthorizationSatisfiableGate | null,
  ): StandingAuthorizationEvaluation => {
    const body = {
      version: STANDING_AUTHORIZATION_VERSION,
      decision,
      satisfiedGate,
      authorizationId: auth?.authorizationId ?? null,
      authorizationVersion: auth?.authorizationVersion ?? null,
      scopeDigest: auth?.scopeDigest ?? null,
      reasonCodes: [...new Set(reasonCodes)].sort(),
      requiresOneTimeApproval: decision !== 'SATISFIED',
      evaluatedAt: nowIso,
    };
    return { kind: 'STANDING_AUTHORIZATION_EVALUATION', ...body, evaluationDigest: digestOf(body) };
  };

  if (auth === null) {
    reasonCodes.push('STANDING_AUTH_MISSING');
    return build('REQUIRE_APPROVAL', null);
  }
  if (auth.serverDerived !== true) {
    reasonCodes.push('STANDING_AUTH_NOT_SERVER_DERIVED');
    return build('DENY', null);
  }

  const recomputed = computeStandingAuthorizationScopeDigest(auth);
  if (recomputed !== auth.scopeDigest) {
    reasonCodes.push('STANDING_AUTH_SCOPE_DIGEST_MISMATCH');
    return build('DENY', null);
  }

  if (auth.revocation.state === 'REVOKED') {
    reasonCodes.push('STANDING_AUTH_REVOKED');
    return build('DENY', null);
  }
  if (auth.revocation.state === 'SUSPENDED') {
    reasonCodes.push('STANDING_AUTH_SUSPENDED');
    return build('DENY', null);
  }
  if (Date.parse(nowIso) >= Date.parse(auth.expiresAt)) {
    reasonCodes.push('STANDING_AUTH_EXPIRED');
    return build('DENY', null);
  }
  if (Date.parse(nowIso) < Date.parse(auth.effectiveAt)) {
    reasonCodes.push('STANDING_AUTH_NOT_YET_EFFECTIVE');
    return build('DENY', null);
  }

  if (auth.organizationId !== request.organizationId) {
    reasonCodes.push('STANDING_AUTH_ORG_MISMATCH');
    return build('DENY', null);
  }
  if (auth.platformAccountId !== request.platformAccountId) {
    reasonCodes.push('STANDING_AUTH_ACCOUNT_MISMATCH');
    return build('DENY', null);
  }
  if (auth.provider.toUpperCase() !== request.provider.toUpperCase()) {
    reasonCodes.push('STANDING_AUTH_PROVIDER_MISMATCH');
    return build('DENY', null);
  }
  if (auth.domain.toUpperCase() !== request.domain.toUpperCase()) {
    reasonCodes.push('STANDING_AUTH_DOMAIN_MISMATCH');
    return build('DENY', null);
  }
  if (auth.jurisdiction.toUpperCase() !== request.jurisdiction.toUpperCase()) {
    reasonCodes.push('STANDING_AUTH_JURISDICTION_MISMATCH');
    return build('DENY', null);
  }
  if (auth.currency.toUpperCase() !== request.currency.toUpperCase()) {
    reasonCodes.push('STANDING_AUTH_CURRENCY_MISMATCH');
    return build('DENY', null);
  }

  if (
    request.expectedAuthorizationVersion !== undefined &&
    request.expectedAuthorizationVersion !== null &&
    request.expectedAuthorizationVersion !== auth.authorizationVersion
  ) {
    reasonCodes.push('STANDING_AUTH_VERSION_STALE');
    return build('DENY', null);
  }
  if (
    request.expectedTermsPolicyVersion !== undefined &&
    request.expectedTermsPolicyVersion !== null &&
    request.expectedTermsPolicyVersion !== auth.termsPolicyVersion
  ) {
    reasonCodes.push('STANDING_AUTH_TERMS_POLICY_MISMATCH');
    return build('DENY', null);
  }
  if (auth.consentEvidenceRef.trim().length === 0) {
    reasonCodes.push('STANDING_AUTH_CONSENT_EVIDENCE_MISSING');
    return build('DENY', null);
  }

  if (!auth.allowedActionTypes.includes(request.action)) {
    reasonCodes.push('STANDING_AUTH_ACTION_NOT_ALLOWED');
    return build('REQUIRE_APPROVAL', null);
  }
  if (request.amountUsd === null) {
    reasonCodes.push('STANDING_AUTH_AMOUNT_UNKNOWN');
    return build('REQUIRE_APPROVAL', null);
  }
  if (request.amountUsd > auth.monetaryLimitUsd) {
    reasonCodes.push('STANDING_AUTH_AMOUNT_EXCEEDS_LIMIT');
    return build('REQUIRE_APPROVAL', null);
  }

  return build('SATISFIED', 'humanApproval');
}

/** 越权断言：授权不得被用来满足任何非可绕过 gate */
export function assertGateSatisfiableByStandingAuthorization(gate: string): void {
  if ((STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES as readonly string[]).includes(gate)) {
    throw new StandingAuthorizationError(
      'STANDING_AUTH_CANNOT_BYPASS_GATE',
      'Standing Authorization 不能绕过该 gate：' + gate,
    );
  }
}

export const STANDING_AUTHORIZATION_BOUNDARY = {
  serverDerivedOnly: true,
  versioned: true,
  revocable: true,
  auditable: true,
  tenantScoped: true,
  accountScoped: true,
  clientForgedScopeRejected: true,
  staleVersionRejected: true,
  revocationIsFailClosed: true,
  satisfiableGates: STANDING_AUTHORIZATION_SATISFIABLE_GATES,
  nonBypassableGates: STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES,
  satisfiesBrokerPoa: false,
  grantsExternalWrite: false,
  forbidden: [
    'accepting a client-supplied authorization scope',
    'continuing to use a previous authorization version after a change',
    'using a revoked or expired authorization',
    'satisfying production / platform / kill-switch / credential / regulatory / isolation gates',
    'treating a standing authorization as a broker POA',
  ],
} as const;
