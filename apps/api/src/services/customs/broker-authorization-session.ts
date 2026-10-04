/**
 * CA-4 — BROKER AUTHORIZATION SESSION（provider-neutral 内部契约，MSG-20261004-02 §九）
 * ---------------------------------------------------------------
 * 本模块只定义契约与状态机，不做任何真实 Broker / provider 调用、webhook 或凭据存储。
 * 硬约束：no real Broker/provider connection · no CBP/ACE/ABI write · no production credentials ·
 *         no external submission · no real filing。
 *
 * 状态机：CREATED → CUSTOMER_ACTION_REQUIRED → SIGNED → PROVIDER_VERIFYING → VERIFIED / REJECTED
 *         （任意非终态可 → EXPIRED / REVOKED）
 * VERIFIED 只能由 server / provider evidence 触发，并据此生成 append-only Broker POA 事实（CA-3 写入口）。
 */

import { createHash } from 'node:crypto';

import type { CustomsFilingRoute } from './customs-authorization-route';

export const CUSTOMS_BROKER_AUTHORIZATION_SESSION_STATUSES = [
  'CREATED',
  'CUSTOMER_ACTION_REQUIRED',
  'SIGNED',
  'PROVIDER_VERIFYING',
  'VERIFIED',
  'REJECTED',
  'EXPIRED',
  'REVOKED',
] as const;

export type CustomsBrokerAuthorizationSessionStatus =
  (typeof CUSTOMS_BROKER_AUTHORIZATION_SESSION_STATUSES)[number];

export type AuthorizationVerificationSource = 'PROVIDER_EVIDENCE' | 'MANUAL_REVIEW';

const OPAQUE_REF_RE = /^[A-Za-z0-9._:@#/-]{1,96}$/;
const SCOPE_TOKEN_RE = /^(\*|[A-Z][A-Z0-9_]{2,63})$/;
const JURISDICTION_RE = /^[A-Z]{2}$/;

export class BrokerAuthorizationSessionError extends Error {
  readonly code:
    | 'INVALID_TRANSITION'
    | 'INVALID_SCOPE'
    | 'INVALID_REF'
    | 'INVALID_JURISDICTION'
    | 'RAW_URL_NOT_ALLOWED'
    | 'VERIFICATION_EVIDENCE_REQUIRED';
  constructor(code: BrokerAuthorizationSessionError['code'], message: string) {
    super(message);
    this.name = 'BrokerAuthorizationSessionError';
    this.code = code;
  }
}

export interface BrokerAuthorizationSession {
  sessionId: string;
  organizationId: string;
  principalRef: string;
  brokerRef: string;
  providerRef: string;
  jurisdiction: string;
  requestedScope: readonly string[];
  authorizationType: 'CBP_FORM_5291' | 'EQUIVALENT_REGULATORY_POA';
  /** 目标 filing route（BROKER_FILED / SELF_FILED / SERVICE_PROVIDER_TRANSMIT）。 */
  route: CustomsFilingRoute;
  status: CustomsBrokerAuthorizationSessionStatus;
  /** 只存不透明引用，禁止裸 URL / token。 */
  externalAuthorizationUrlRef?: string | null;
  providerAuthorizationRef?: string | null;
  evidenceArtifactRef?: string | null;
  expiresAt?: Date | null;
  completedAt?: Date | null;
  contentDigest: string;
  createdAt: Date;
  updatedAt: Date;
}

/** 允许的状态迁移（终态不再迁出）。 */
export const BROKER_AUTHORIZATION_SESSION_TRANSITIONS: Record<
  CustomsBrokerAuthorizationSessionStatus,
  readonly CustomsBrokerAuthorizationSessionStatus[]
> = {
  CREATED: ['CUSTOMER_ACTION_REQUIRED', 'SIGNED', 'REVOKED', 'EXPIRED'],
  CUSTOMER_ACTION_REQUIRED: ['SIGNED', 'EXPIRED', 'REVOKED'],
  SIGNED: ['PROVIDER_VERIFYING', 'VERIFIED', 'REJECTED', 'EXPIRED', 'REVOKED'],
  PROVIDER_VERIFYING: ['VERIFIED', 'REJECTED', 'EXPIRED', 'REVOKED'],
  VERIFIED: [],
  REJECTED: [],
  EXPIRED: [],
  REVOKED: [],
};

function assertOpaqueRef(value: string | null | undefined, field: string): void {
  if (value === null || value === undefined) return;
  if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('javascript:')) {
    throw new BrokerAuthorizationSessionError('RAW_URL_NOT_ALLOWED', field + ' 只能存不透明引用，不得存裸 URL');
  }
  if (/^[0-9]{2}-[0-9]{7}$/.test(value) || /^[0-9]{6,12}$/.test(value)) {
    throw new BrokerAuthorizationSessionError('INVALID_REF', field + ' 不得为 EIN-like 或纯数字原始标识');
  }
  if (!OPAQUE_REF_RE.test(value)) {
    throw new BrokerAuthorizationSessionError('INVALID_REF', field + ' 不是合法的不透明引用');
  }
}

function assertScope(scope: readonly string[]): void {
  if (!Array.isArray(scope) || scope.length === 0) {
    throw new BrokerAuthorizationSessionError('INVALID_SCOPE', 'requestedScope 必须是非空 remedy 列表');
  }
  for (const token of scope) {
    if (typeof token !== 'string' || !SCOPE_TOKEN_RE.test(token)) {
      throw new BrokerAuthorizationSessionError('INVALID_SCOPE', 'requestedScope 元素必须是合法 remedy token');
    }
  }
}

function sessionDigest(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input, Object.keys(input).sort()), 'utf8').digest('hex');
}

export interface CreateBrokerAuthorizationSessionInput {
  sessionId: string;
  organizationId: string;
  principalRef: string;
  brokerRef: string;
  providerRef: string;
  jurisdiction: string;
  requestedScope: readonly string[];
  authorizationType?: 'CBP_FORM_5291' | 'EQUIVALENT_REGULATORY_POA';
  route?: CustomsFilingRoute;
  externalAuthorizationUrlRef?: string | null;
  expiresAt?: Date | null;
  now?: Date;
}

/** 创建会话（CREATED）。不接触任何真实 provider。 */
export function createBrokerAuthorizationSession(
  input: CreateBrokerAuthorizationSessionInput,
): BrokerAuthorizationSession {
  assertScope(input.requestedScope);
  if (!JURISDICTION_RE.test(input.jurisdiction)) {
    throw new BrokerAuthorizationSessionError('INVALID_JURISDICTION', 'jurisdiction 必须是两字母辖区码');
  }
  assertOpaqueRef(input.principalRef, 'principalRef');
  assertOpaqueRef(input.brokerRef, 'brokerRef');
  assertOpaqueRef(input.providerRef, 'providerRef');
  assertOpaqueRef(input.externalAuthorizationUrlRef, 'externalAuthorizationUrlRef');

  const at = input.now ?? new Date();
  const session: Omit<BrokerAuthorizationSession, 'contentDigest' | 'updatedAt'> = {
    sessionId: input.sessionId,
    organizationId: input.organizationId,
    principalRef: input.principalRef,
    brokerRef: input.brokerRef,
    providerRef: input.providerRef,
    jurisdiction: input.jurisdiction,
    requestedScope: [...input.requestedScope],
    authorizationType: input.authorizationType ?? 'CBP_FORM_5291',
    route: input.route ?? 'BROKER_FILED',
    status: 'CREATED',
    externalAuthorizationUrlRef: input.externalAuthorizationUrlRef ?? null,
    providerAuthorizationRef: null,
    evidenceArtifactRef: null,
    expiresAt: input.expiresAt ?? null,
    completedAt: null,
    createdAt: at,
  };
  return {
    ...session,
    contentDigest: sessionDigest({ ...session, status: undefined, contentDigest: undefined }),
    updatedAt: at,
  };
}

export interface TransitionContext {
  at?: Date;
  /** 仅 server / provider 侧证据可触发 VERIFIED（client 不得自报）。 */
  verificationSource?: AuthorizationVerificationSource;
  providerAuthorizationRef?: string | null;
  evidenceArtifactRef?: string | null;
  reason?: string;
}

/**
 * 状态迁移（唯一合法入口）。
 * - VERIFIED 必须带 server/provider 证据（verificationSource + providerAuthorizationRef 或 evidenceArtifactRef）。
 * - 进入终态时写入 completedAt。
 */
export function transitionBrokerAuthorizationSession(
  session: BrokerAuthorizationSession,
  next: CustomsBrokerAuthorizationSessionStatus,
  context: TransitionContext = {},
): BrokerAuthorizationSession {
  const allowed = BROKER_AUTHORIZATION_SESSION_TRANSITIONS[session.status];
  if (!allowed.includes(next)) {
    throw new BrokerAuthorizationSessionError(
      'INVALID_TRANSITION',
      '不允许的会话迁移：' + session.status + ' → ' + next,
    );
  }

  const providerAuthorizationRef = context.providerAuthorizationRef ?? session.providerAuthorizationRef ?? null;
  const evidenceArtifactRef = context.evidenceArtifactRef ?? session.evidenceArtifactRef ?? null;
  assertOpaqueRef(providerAuthorizationRef, 'providerAuthorizationRef');
  assertOpaqueRef(evidenceArtifactRef, 'evidenceArtifactRef');

  if (next === 'VERIFIED') {
    if (!context.verificationSource || (!providerAuthorizationRef && !evidenceArtifactRef)) {
      throw new BrokerAuthorizationSessionError(
        'VERIFICATION_EVIDENCE_REQUIRED',
        'VERIFIED 只能由 server/provider evidence 触发（需要 verificationSource + 引用）',
      );
    }
  }

  const at = context.at ?? new Date();
  const terminal = next === 'VERIFIED' || next === 'REJECTED' || next === 'EXPIRED' || next === 'REVOKED';
  const updated: BrokerAuthorizationSession = {
    ...session,
    status: next,
    providerAuthorizationRef,
    evidenceArtifactRef,
    completedAt: terminal ? at : session.completedAt ?? null,
    updatedAt: at,
  };
  return {
    ...updated,
    contentDigest: sessionDigest({ ...updated, contentDigest: undefined, updatedAt: undefined }),
  };
}

export interface PoaAppendCandidate {
  subject: 'BROKER_POA';
  action: 'GRANT';
  principalRef: string;
  brokerRef: string;
  scope: readonly string[];
  jurisdiction: string;
  authorizationType: 'CBP_FORM_5291' | 'EQUIVALENT_REGULATORY_POA';
  evidenceArtifactRef: string | null;
  verificationSource: 'BROKER_ATTESTATION';
  idempotencyKey: string;
}

/**
 * VERIFIED 会话 → CA-3 append-only Broker POA 事实输入（不在这里写库；由调用方走 appendAuthorizationLifecycle）。
 * 幂等键使用 sessionId，保证同一会话重复收敛不会产生第二条 POA。
 */
export function brokerAuthorizationSessionToPoaAppend(
  session: BrokerAuthorizationSession,
): PoaAppendCandidate {
  if (session.status !== 'VERIFIED') {
    throw new BrokerAuthorizationSessionError('INVALID_TRANSITION', '只有 VERIFIED 会话才能生成 POA 事实');
  }
  if (!session.evidenceArtifactRef) {
    throw new BrokerAuthorizationSessionError('VERIFICATION_EVIDENCE_REQUIRED', 'VERIFIED 会话必须有 evidence 引用');
  }
  return {
    subject: 'BROKER_POA',
    action: 'GRANT',
    principalRef: session.principalRef,
    brokerRef: session.brokerRef,
    scope: session.requestedScope,
    jurisdiction: session.jurisdiction,
    authorizationType: session.authorizationType,
    evidenceArtifactRef: session.evidenceArtifactRef,
    verificationSource: 'BROKER_ATTESTATION',
    idempotencyKey: 'broker-authorization-session:' + session.sessionId,
  };
}
