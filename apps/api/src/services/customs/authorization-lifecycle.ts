/**
 * CA-3 — AUTHORIZATION LIFECYCLE PERSISTENCE（MSG-20261004-02 §七 / MSG-20261004-03 授权）
 * ---------------------------------------------------------------
 * 生命周期变化**只能通过追加新事实**表达（append-only）：GRANT / RENEW / REVOKE 各产生一条新事实；
 * 绝不 UPDATE 历史授权事实。server-side 派生：observedAt / contentDigest / verificationStatus /
 * verificationSource 一律由服务端计算，client 自报这些字段即 fail-closed。
 *
 * 本模块只有内部持久化与读模型；不接真实 Broker / Filing / CBP / ACE，零外写。
 */

import { createHash, randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import type { AuditWriter } from '../audit';
import {
  evaluateCustomsAuthorizationForRoute,
  resolveAuthorizedSignerFacts,
  resolveBrokerPoaFacts,
  type AuthorizedSignerRow,
  type AuthorizationLifecycleStatus,
  type BrokerPoaRow,
  type CustomsAuthorizationFacts,
  type CustomsAuthorizationPolicy,
  type CustomsFilingRoute,
  type CustomsRouteAuthorizationReadiness,
  type CustomsAuthorizedSignerType,
  type ResolvedPoaFacts,
  type ResolvedSignerFacts,
} from './customs-authorization-route';

export type AuthorizationSubjectKind = 'BROKER_POA' | 'AUTHORIZED_SIGNER';
export type AuthorizationLifecycleAction = 'GRANT' | 'RENEW' | 'REVOKE';

/** 允许的 server-side 验证来源（client 不得自报）。 */
export type ServerVerificationSource =
  | 'BROKER_ATTESTATION'
  | 'ACE_LOOKUP'
  | 'CUSTOMER_DOCUMENT'
  | 'MANUAL_REVIEW'
  | 'NONE';

const CLIENT_FORBIDDEN_FIELDS = [
  'id',
  'organizationId',
  'observedAt',
  'createdAt',
  'contentDigest',
  'verificationStatus',
  'verificationSource',
  'verifiedAt',
  'revokedAt',
  'supersededAt',
] as const;

export class AuthorizationLifecycleError extends Error {
  readonly code:
    | 'CLIENT_SUPPLIED_AUTHORIZATION_FIELD'
    | 'INVALID_SCOPE'
    | 'INVALID_SUBJECT'
    | 'EVIDENCE_REQUIRED'
    | 'IDEMPOTENCY_KEY_CONFLICT'
    | 'UNKNOWN_SUBJECT_KIND';
  constructor(code: AuthorizationLifecycleError['code'], message: string) {
    super(message);
    this.name = 'AuthorizationLifecycleError';
    this.code = code;
  }
}

export interface PoaFactInsert {
  organizationId: string;
  principalRef: string;
  brokerRef: string;
  jurisdiction: string;
  authorizationType: 'CBP_FORM_5291' | 'EQUIVALENT_REGULATORY_POA';
  scopeRemedies: readonly string[];
  effectiveAt: Date;
  expiresAt: Date | null;
  evidenceArtifactRef: string | null;
  verificationStatus: 'VERIFIED' | 'PENDING' | 'REVOKED';
  verificationSource: ServerVerificationSource;
  verifiedAt: Date | null;
  revokedAt: Date | null;
  contentDigest: string;
  observedAt: Date;
  lifecycleKey: string;
}

export interface SignerFactInsert {
  organizationId: string;
  principalRef: string;
  signerRef: string;
  signerType: CustomsAuthorizedSignerType;
  authorityBasis: string;
  scopeRemedies: readonly string[];
  jurisdiction: string;
  effectiveAt: Date;
  expiresAt: Date | null;
  evidenceArtifactRef: string | null;
  verificationStatus: 'VERIFIED' | 'PENDING' | 'REVOKED';
  verificationSource: ServerVerificationSource;
  verifiedAt: Date | null;
  revokedAt: Date | null;
  contentDigest: string;
  observedAt: Date;
  lifecycleKey: string;
}

export interface AuthorizationLifecycleStores {
  appendPoa(row: PoaFactInsert): Promise<{ id: string }>;
  findByLifecycleKey(organizationId: string, lifecycleKey: string): Promise<{ factId: string; contentDigest: string } | null>;
  appendSigner(row: SignerFactInsert): Promise<{ id: string }>;
  listPoa(organizationId: string, principalRef: string, brokerRef?: string): Promise<BrokerPoaRow[]>;
  listSigner(organizationId: string, principalRef: string): Promise<AuthorizedSignerRow[]>;
}

export interface AuthorizationLifecycleDeps {
  stores: AuthorizationLifecycleStores;
  audit?: AuditWriter;
  now?: () => Date;
}

export interface AppendAuthorizationInput {
  organizationId: string;
  actorUserId: string;
  subject: AuthorizationSubjectKind;
  action: AuthorizationLifecycleAction;
  principalRef: string;
  brokerRef?: string;
  signerRef?: string;
  signerType?: CustomsAuthorizedSignerType;
  authorityBasis?: string;
  scope: readonly string[];
  jurisdiction: string;
  effectiveAt?: Date;
  expiresAt?: Date | null;
  evidenceArtifactRef?: string | null;
  /** server-side 决定的验证来源（不是 client body 的字段）。 */
  verificationSource: ServerVerificationSource;
  authorizationType?: 'CBP_FORM_5291' | 'EQUIVALENT_REGULATORY_POA';
  /** 稳定幂等键（同一业务事件重试必须相同；省略时以 payload digest 作为键）。 */
  idempotencyKey?: string;
  /** 原始 client 载荷（仅用于 deny-list 检查，不写库）。 */
  clientPayload?: Record<string, unknown>;
}

const SCOPE_TOKEN_RE = /^(\*|[A-Z][A-Z0-9_]{2,63})$/;

function assertNoClientSuppliedAuthorityFields(payload: Record<string, unknown> | undefined): void {
  if (!payload) return;
  for (const field of CLIENT_FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      throw new AuthorizationLifecycleError(
        'CLIENT_SUPPLIED_AUTHORIZATION_FIELD',
        'client 不得自报授权字段：' + field,
      );
    }
  }
}

function assertScope(scope: readonly string[]): void {
  if (!Array.isArray(scope) || scope.length === 0) {
    throw new AuthorizationLifecycleError('INVALID_SCOPE', 'scope 必须是非空 remedy 列表');
  }
  for (const token of scope) {
    if (typeof token !== 'string' || !SCOPE_TOKEN_RE.test(token)) {
      throw new AuthorizationLifecycleError('INVALID_SCOPE', 'scope 元素必须是合法 remedy token');
    }
  }
}

/** server-side 规范摘要（排序后哈希），保证同一语义输入得到同一 digest。 */
export function authorizationContentDigest(input: Record<string, unknown>): string {
  const canonical = JSON.stringify(input, Object.keys(input).sort());
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface AppendAuthorizationResult {
  factId: string;
  subject: AuthorizationSubjectKind;
  action: AuthorizationLifecycleAction;
  lifecycleStatus: AuthorizationLifecycleStatus;
  observedAt: string;
  contentDigest: string;
  verificationSource: ServerVerificationSource;
  serverDerivedFields: true;
}

/**
 * 追加一条生命周期事实。
 * - GRANT / RENEW：需要 evidence + 非 NONE 的 verificationSource → VERIFIED；否则 PENDING（不可用）。
 * - REVOKE：始终追加 REVOKED 事实（带 revokedAt），不改动任何历史行。
 */
export async function appendAuthorizationLifecycle(
  input: AppendAuthorizationInput,
  deps: AuthorizationLifecycleDeps,
): Promise<AppendAuthorizationResult> {
  assertNoClientSuppliedAuthorityFields(input.clientPayload);
  assertScope(input.scope);

  const now = deps.now ?? (() => new Date());
  const observedAt = now();
  const effectiveAt = input.effectiveAt ?? observedAt;
  const expiresAt = input.expiresAt ?? null;
  const evidenceArtifactRef = input.evidenceArtifactRef ?? null;

  if (input.action !== 'REVOKE' && (!evidenceArtifactRef || input.verificationSource === 'NONE')) {
    // 允许落 PENDING（不可用），但不得伪造成 VERIFIED
    if (input.verificationSource === 'NONE' && !evidenceArtifactRef) {
      throw new AuthorizationLifecycleError('EVIDENCE_REQUIRED', 'GRANT/RENEW 需要可审计证据引用');
    }
  }

  const verificationStatus: 'VERIFIED' | 'PENDING' | 'REVOKED' =
    input.action === 'REVOKE'
      ? 'REVOKED'
      : evidenceArtifactRef && input.verificationSource !== 'NONE'
        ? 'VERIFIED'
        : 'PENDING';
  const verifiedAt = verificationStatus === 'VERIFIED' ? observedAt : null;
  const revokedAt = input.action === 'REVOKE' ? observedAt : null;

  const digest = authorizationContentDigest({
    subject: input.subject,
    action: input.action,
    principalRef: input.principalRef,
    brokerRef: input.brokerRef ?? null,
    signerRef: input.signerRef ?? null,
    signerType: input.signerType ?? null,
    authorityBasis: input.authorityBasis ?? null,
    scope: [...input.scope].sort(),
    jurisdiction: input.jurisdiction,
    effectiveAt: effectiveAt.toISOString(),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    evidenceArtifactRef,
    verificationStatus,
    verificationSource: input.verificationSource,
  });

  const idempotencyKey = input.idempotencyKey ?? 'payload:' + digest;
  const lifecycleKey = authorizationContentDigest({
    idempotencyKey,
    subject: input.subject,
    action: input.action,
    principalRef: input.principalRef,
    brokerRef: input.brokerRef ?? null,
    signerRef: input.signerRef ?? null,
    organizationId: input.organizationId,
  });
  const existing = await deps.stores.findByLifecycleKey(input.organizationId, lifecycleKey);
  if (existing) {
    if (existing.contentDigest !== digest) {
      throw new AuthorizationLifecycleError('IDEMPOTENCY_KEY_CONFLICT', '同一幂等键对应不同 immutable payload');
    }
    return {
      factId: existing.factId,
      subject: input.subject,
      action: input.action,
      lifecycleStatus: input.action === 'REVOKE' ? 'REVOKED' : verificationStatus,
      observedAt: observedAt.toISOString(),
      contentDigest: digest,
      verificationSource: input.verificationSource,
      serverDerivedFields: true,
    };
  }

  let factId: string;
  if (input.subject === 'BROKER_POA') {
    if (!input.brokerRef) {
      throw new AuthorizationLifecycleError('INVALID_SUBJECT', 'BROKER_POA 需要 brokerRef');
    }
    const created = await deps.stores.appendPoa({
      organizationId: input.organizationId,
      principalRef: input.principalRef,
      brokerRef: input.brokerRef,
      jurisdiction: input.jurisdiction,
      authorizationType: input.authorizationType ?? 'CBP_FORM_5291',
      scopeRemedies: [...input.scope],
      effectiveAt,
      expiresAt,
      evidenceArtifactRef,
      verificationStatus,
      verificationSource: input.verificationSource,
      verifiedAt,
      revokedAt,
      contentDigest: digest,
      observedAt,
      lifecycleKey,
    });
    factId = created.id;
  } else if (input.subject === 'AUTHORIZED_SIGNER') {
    if (!input.signerRef || !input.signerType || !input.authorityBasis) {
      throw new AuthorizationLifecycleError(
        'INVALID_SUBJECT',
        'AUTHORIZED_SIGNER 需要 signerRef / signerType / authorityBasis',
      );
    }
    const created = await deps.stores.appendSigner({
      organizationId: input.organizationId,
      principalRef: input.principalRef,
      signerRef: input.signerRef,
      signerType: input.signerType,
      authorityBasis: input.authorityBasis,
      scopeRemedies: [...input.scope],
      jurisdiction: input.jurisdiction,
      effectiveAt,
      expiresAt,
      evidenceArtifactRef,
      verificationStatus,
      verificationSource: input.verificationSource,
      verifiedAt,
      revokedAt,
      contentDigest: digest,
      observedAt,
      lifecycleKey,
    });
    factId = created.id;
  } else {
    throw new AuthorizationLifecycleError('UNKNOWN_SUBJECT_KIND', '未知授权主体类型');
  }

  if (deps.audit) {
    await deps.audit
      .record({
        organizationId: input.organizationId,
        actorType: 'USER',
        actorUserId: input.actorUserId,
        action:
          input.action === 'REVOKE'
            ? 'customs.authorization_revoked'
            : input.action === 'RENEW'
              ? 'customs.authorization_renewed'
              : 'customs.authorization_granted',
        entityType: input.subject === 'BROKER_POA' ? 'CustomsBrokerPoaFact' : 'CustomsAuthorizedSignerFact',
        entityId: factId,
        changes: {
          subject: input.subject,
          principalRef: input.principalRef,
          scope: [...input.scope],
          jurisdiction: input.jurisdiction,
          verificationStatus,
          verificationSource: input.verificationSource,
          contentDigest: digest,
        },
      })
      .catch(() => undefined);
  }

  return {
    factId,
    subject: input.subject,
    action: input.action,
    lifecycleStatus: verificationStatus,
    observedAt: observedAt.toISOString(),
    contentDigest: digest,
    verificationSource: input.verificationSource,
    serverDerivedFields: true,
  };
}

export interface AuthorizationStateInput {
  organizationId: string;
  principalRef: string;
  remedy: string;
  route: CustomsFilingRoute;
  at?: Date;
  policy?: CustomsAuthorizationPolicy;
  /** 非授权类事实（身份 / 追回权 / 提交能力 / 退款账户）由调用方提供。 */
  context: Pick<
    CustomsAuthorizationFacts,
    | 'customsAgreementSigned'
    | 'iorConfirmed'
    | 'claimantConfirmed'
    | 'recoveryRightForRemedy'
    | 'filingPermissionValid'
    | 'providerCapabilityReady'
    | 'payeeIdentityConfirmed'
    | 'refundDestinationVerified'
    | 'aceEnrollmentReady'
  > & { brokerConnected: boolean; brokerRef?: string };
}

export interface AuthorizationState {
  brokerPoa: ResolvedPoaFacts;
  signer: ResolvedSignerFacts;
  readiness: CustomsRouteAuthorizationReadiness;
  serverDerived: true;
}

/** CA-3 读模型：把生命周期事实解析成 CA-1 三阶段 readiness（只读，零外写）。 */
export async function readAuthorizationState(
  input: AuthorizationStateInput,
  deps: AuthorizationLifecycleDeps,
): Promise<AuthorizationState> {
  const at = input.at ?? (deps.now ?? (() => new Date()))();
  const requestedBrokerRef = input.context.brokerRef;
  const signerRowsForFallback = await deps.stores.listSigner(input.organizationId, input.principalRef);
  const signerFallback = resolveAuthorizedSignerFacts(signerRowsForFallback, {
    at,
    remedy: input.remedy,
    principalRef: input.principalRef,
  });
  // CHANGE A: BROKER_FILED without an explicit broker is fail-closed (MISSING).
  if (input.route === 'BROKER_FILED' && !requestedBrokerRef) {
    const missingPoa: ResolvedPoaFacts = { status: 'MISSING', scopeCoversRemedy: false, jurisdiction: null, source: 'MISSING', rowId: null, expiresAt: null, supersedesId: null };
    return {
      brokerPoa: missingPoa,
      signer: signerFallback,
      readiness: evaluateCustomsAuthorizationForRoute({
        route: input.route,
        remedy: input.remedy,
        ...(input.policy ? { policy: input.policy } : {}),
        facts: {
          ...input.context,
          brokerPoaStatus: 'MISSING',
          brokerPoaScopeCoversRemedy: false,
          brokerPoaJurisdiction: null,
          brokerPoaSource: 'MISSING',
          signerStatus: signerFallback.status,
          signerScopeCoversRemedy: signerFallback.scopeCoversRemedy,
          signerSource: signerFallback.source,
          signerJurisdiction: signerFallback.jurisdiction,
        },
      }),
      serverDerived: true,
    };
  }
  const poaRows = await deps.stores.listPoa(input.organizationId, input.principalRef, requestedBrokerRef);
  const signerRows = await deps.stores.listSigner(input.organizationId, input.principalRef);
  const brokerPoa = resolveBrokerPoaFacts(poaRows, {
    at,
    remedy: input.remedy,
    principalRef: input.principalRef,
    ...(requestedBrokerRef ? { brokerRef: requestedBrokerRef } : {}),
  });
  const signer = resolveAuthorizedSignerFacts(signerRows, { at, remedy: input.remedy, principalRef: input.principalRef });

  const readiness = evaluateCustomsAuthorizationForRoute({
    route: input.route,
    remedy: input.remedy,
    ...(input.policy ? { policy: input.policy } : {}),
    facts: {
      ...input.context,
      brokerPoaStatus: brokerPoa.status,
      brokerPoaScopeCoversRemedy: brokerPoa.scopeCoversRemedy,
      brokerPoaJurisdiction: brokerPoa.jurisdiction,
      brokerPoaSource: brokerPoa.source,
      signerStatus: signer.status,
      signerScopeCoversRemedy: signer.scopeCoversRemedy,
      signerSource: signer.source,
      signerJurisdiction: signer.jurisdiction,
    },
  });

  return { brokerPoa, signer, readiness, serverDerived: true };
}

/** Prisma 端口（append-only 写入 + tenant/principal scoped 读取）。 */
export function createPrismaAuthorizationLifecycleStores(prisma: PrismaClient): AuthorizationLifecycleStores {
  return {
    async appendPoa(row) {
      const created = await prisma.customsBrokerPoaFact.create({
        data: {
          id: randomUUID(),
          organizationId: row.organizationId,
          principalRef: row.principalRef,
          brokerRef: row.brokerRef,
          jurisdiction: row.jurisdiction,
          authorizationType: row.authorizationType,
          scope: row.scopeRemedies as never,
          effectiveAt: row.effectiveAt,
          expiresAt: row.expiresAt,
          evidenceArtifactRef: row.evidenceArtifactRef,
          verifiedAt: row.verifiedAt,
          revokedAt: row.revokedAt,
          verificationStatus: row.verificationStatus,
          verificationSource: row.verificationSource as never,
          contentDigest: row.contentDigest,
          observedAt: row.observedAt,
          lifecycleKey: row.lifecycleKey,
        },
        select: { id: true },
      });
      return { id: created.id };
    },

    async findByLifecycleKey(organizationId, lifecycleKey) {
      const poa = await prisma.customsBrokerPoaFact.findFirst({
        where: { organizationId, lifecycleKey },
        select: { id: true, contentDigest: true },
      });
      if (poa) return { factId: poa.id, contentDigest: poa.contentDigest };
      const signer = await prisma.customsAuthorizedSignerFact.findFirst({
        where: { organizationId, lifecycleKey },
        select: { id: true, contentDigest: true },
      });
      return signer ? { factId: signer.id, contentDigest: signer.contentDigest } : null;
    },

    async appendSigner(row) {
      const created = await prisma.customsAuthorizedSignerFact.create({
        data: {
          id: randomUUID(),
          organizationId: row.organizationId,
          principalRef: row.principalRef,
          signerRef: row.signerRef,
          signerType: row.signerType,
          authorityBasis: row.authorityBasis,
          scope: row.scopeRemedies as never,
          jurisdiction: row.jurisdiction,
          effectiveAt: row.effectiveAt,
          expiresAt: row.expiresAt,
          verificationStatus: row.verificationStatus,
          verificationSource: row.verificationSource as never,
          verifiedAt: row.verifiedAt,
          evidenceArtifactRef: row.evidenceArtifactRef,
          revokedAt: row.revokedAt,
          contentDigest: row.contentDigest,
          observedAt: row.observedAt,
          lifecycleKey: row.lifecycleKey,
        },
        select: { id: true },
      });
      return { id: created.id };
    },

    async listPoa(organizationId, principalRef, brokerRef) {
      const rows = await prisma.customsBrokerPoaFact.findMany({
        where: { organizationId, principalRef, ...(brokerRef ? { brokerRef } : {}) },
        orderBy: [{ observedAt: 'desc' }],
      });
      return rows.map((row) => ({
        id: row.id,
        principalRef: row.principalRef,
        brokerRef: row.brokerRef,
        jurisdiction: row.jurisdiction,
        authorizationType: row.authorizationType,
        scopeRemedies: Array.isArray(row.scope) ? (row.scope as string[]) : [],
        effectiveAt: row.effectiveAt,
        expiresAt: row.expiresAt,
        verificationStatus: row.verificationStatus,
        observedAt: row.observedAt,
        contentDigest: row.contentDigest,
      }));
    },

    async listSigner(organizationId, principalRef) {
      const rows = await prisma.customsAuthorizedSignerFact.findMany({
        where: { organizationId, principalRef },
        orderBy: [{ observedAt: 'desc' }],
      });
      return rows.map((row) => ({
        id: row.id,
        principalRef: row.principalRef,
        signerRef: row.signerRef,
        signerType: row.signerType,
        authorityBasis: row.authorityBasis,
        scopeRemedies: Array.isArray(row.scope) ? (row.scope as string[]) : [],
        jurisdiction: row.jurisdiction,
        effectiveAt: row.effectiveAt,
        expiresAt: row.expiresAt,
        verificationStatus: row.verificationStatus,
        observedAt: row.observedAt,
        revokedAt: row.revokedAt,
        supersededAt: row.supersededAt,
        contentDigest: row.contentDigest,
      }));
    },
  };
}
