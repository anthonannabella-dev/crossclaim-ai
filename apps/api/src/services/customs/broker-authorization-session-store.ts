/**
 * CA-4 REVISE D — BROKER AUTHORIZATION SESSION 持久化（受控状态机 + append-only 事件历史）
 * ---------------------------------------------------------------
 * 设计（MSG-20261004-06 §3 裁定）：
 *   · CustomsBrokerAuthorizationSession = 受控可迁移状态机（sessionId 有稳定身份）
 *   · CustomsBrokerAuthorizationSessionEvent = append-only 历史（每次迁移一行）
 * 不变量：
 *   · tenant scoped + organizationId 不可变（DB 触发器）
 *   · 身份字段（principalRef / brokerRef / providerRef / jurisdiction / requestedScope /
 *     authorizationType / route / sessionId）不可 UPDATE
 *   · 只允许状态机白名单迁移；终态不可迁出（DB 触发器 + service 双重）
 *   · 每次迁移 version = version + 1，并以 CAS（status + version）防止并发双迁移丢失更新
 *   · 零真实 Broker / provider / CBP / ACE / ABI 外写
 */

import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import type { AuditWriter } from '../audit';
import type { CustomsFilingRoute } from './customs-authorization-route';
import {
  transitionBrokerAuthorizationSession,
  type AuthorizationVerificationSource,
  type BrokerAuthorizationSession,
  type CustomsBrokerAuthorizationSessionStatus,
  type TransitionContext,
} from './broker-authorization-session';

export interface BrokerAuthorizationSessionRow {
  id: string;
  organizationId: string;
  sessionId: string;
  principalRef: string;
  brokerRef: string;
  providerRef: string;
  jurisdiction: string;
  requestedScope: readonly string[];
  authorizationType: 'CBP_FORM_5291' | 'EQUIVALENT_REGULATORY_POA';
  route: CustomsFilingRoute;
  status: CustomsBrokerAuthorizationSessionStatus;
  version: number;
  externalAuthorizationUrlRef: string | null;
  providerAuthorizationRef: string | null;
  evidenceArtifactRef: string | null;
  verificationSource: AuthorizationVerificationSource | null;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  completedAt: Date | null;
  contentDigest: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BrokerAuthorizationSessionEventRow {
  id: string;
  fromStatus: CustomsBrokerAuthorizationSessionStatus;
  toStatus: CustomsBrokerAuthorizationSessionStatus;
  verificationSource: AuthorizationVerificationSource | null;
  reason: string | null;
  contentDigest: string;
  observedAt: Date;
}

export interface ApplySessionTransitionInput {
  organizationId: string;
  rowId: string;
  expectedStatus: CustomsBrokerAuthorizationSessionStatus;
  expectedVersion: number;
  next: BrokerAuthorizationSession;
  actorUserId: string;
  fromStatus: CustomsBrokerAuthorizationSessionStatus;
  verificationSource: AuthorizationVerificationSource | null;
  reason?: string | null;
}

export type ApplySessionTransitionOutcome =
  | { applied: true; version: number }
  | { applied: false; reason: 'STALE' };

export interface BrokerAuthorizationSessionStores {
  insert(row: BrokerAuthorizationSession, actorUserId: string): Promise<{ id: string; version: number }>;
  find(organizationId: string, sessionId: string): Promise<BrokerAuthorizationSessionRow | null>;
  applyTransition(input: ApplySessionTransitionInput): Promise<ApplySessionTransitionOutcome>;
  listEvents(organizationId: string, sessionId: string): Promise<BrokerAuthorizationSessionEventRow[]>;
}

export interface BrokerAuthorizationSessionDeps {
  stores: BrokerAuthorizationSessionStores;
  audit?: AuditWriter;
  now?: () => Date;
}

export function toBrokerAuthorizationSessionContract(
  row: BrokerAuthorizationSessionRow,
): BrokerAuthorizationSession {
  return {
    sessionId: row.sessionId,
    organizationId: row.organizationId,
    principalRef: row.principalRef,
    brokerRef: row.brokerRef,
    providerRef: row.providerRef,
    jurisdiction: row.jurisdiction,
    requestedScope: [...row.requestedScope],
    authorizationType: row.authorizationType,
    route: row.route,
    status: row.status,
    externalAuthorizationUrlRef: row.externalAuthorizationUrlRef,
    providerAuthorizationRef: row.providerAuthorizationRef,
    evidenceArtifactRef: row.evidenceArtifactRef,
    verificationSource: row.verificationSource,
    verifiedAt: row.verifiedAt,
    expiresAt: row.expiresAt,
    completedAt: row.completedAt,
    contentDigest: row.contentDigest,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 创建并持久化会话（CREATED）。 */
export async function persistBrokerAuthorizationSession(
  session: BrokerAuthorizationSession,
  deps: BrokerAuthorizationSessionDeps,
  actorUserId: string,
): Promise<{ id: string; version: number }> {
  return deps.stores.insert(session, actorUserId);
}

export interface TransitionSessionPersistedInput {
  organizationId: string;
  sessionId: string;
  next: CustomsBrokerAuthorizationSessionStatus;
  context?: TransitionContext;
  actorUserId: string;
  /** 可选的乐观并发前置条件（客户端读到的 version）。 */
  expectedVersion?: number;
}

export type TransitionSessionPersistedOutcome =
  | { applied: true; session: BrokerAuthorizationSession; version: number }
  | { applied: false; reason: 'NOT_FOUND' | 'STALE' };

/**
 * 读写 + 迁移的唯一入口：读取 → 契约校验（状态机 / 证据门槛）→ CAS 落库 → 同事务写 append-only 事件。
 * 并发两个调用者持同一 version：只有一个 applied=true，另一个 STALE（不产生 lost update）。
 */
export async function transitionBrokerAuthorizationSessionPersisted(
  input: TransitionSessionPersistedInput,
  deps: BrokerAuthorizationSessionDeps,
): Promise<TransitionSessionPersistedOutcome> {
  const row = await deps.stores.find(input.organizationId, input.sessionId);
  if (!row) return { applied: false, reason: 'NOT_FOUND' };
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
    return { applied: false, reason: 'STALE' };
  }

  const current = toBrokerAuthorizationSessionContract(row);
  const next = transitionBrokerAuthorizationSession(current, input.next, input.context ?? {});

  const outcome = await deps.stores.applyTransition({
    organizationId: input.organizationId,
    rowId: row.id,
    expectedStatus: row.status,
    expectedVersion: row.version,
    next,
    actorUserId: input.actorUserId,
    fromStatus: row.status,
    verificationSource: next.verificationSource ?? null,
    reason: input.context?.reason ?? null,
  });
  if (!outcome.applied) return { applied: false, reason: 'STALE' };

  if (deps.audit) {
    await deps.audit
      .record({
        organizationId: input.organizationId,
        actorType: 'USER',
        actorUserId: input.actorUserId,
        action: 'customs.broker_authorization_session_transition',
        entityType: 'CustomsBrokerAuthorizationSession',
        entityId: row.id,
        changes: {
          sessionId: row.sessionId,
          fromStatus: row.status,
          toStatus: next.status,
          version: outcome.version,
          contentDigest: next.contentDigest,
        },
      })
      .catch(() => undefined);
  }

  return { applied: true, session: next, version: outcome.version };
}

/** Prisma 端口：受控 UPDATE + CAS + 同事务 append-only 事件。 */
export function createPrismaBrokerAuthorizationSessionStores(
  prisma: PrismaClient,
): BrokerAuthorizationSessionStores {
  return {
    async insert(row) {
      const created = await prisma.$transaction(async (tx) => {
        const session = await tx.customsBrokerAuthorizationSession.create({
          data: {
            id: randomUUID(),
            organizationId: row.organizationId,
            sessionId: row.sessionId,
            principalRef: row.principalRef,
            brokerRef: row.brokerRef,
            providerRef: row.providerRef,
            jurisdiction: row.jurisdiction,
            requestedScope: [...row.requestedScope] as never,
            authorizationType: row.authorizationType,
            route: row.route,
            status: 'CREATED',
            version: 1,
            externalAuthorizationUrlRef: row.externalAuthorizationUrlRef ?? null,
            providerAuthorizationRef: null,
            evidenceArtifactRef: null,
            verificationSource: null,
            verifiedAt: null,
            expiresAt: row.expiresAt ?? null,
            completedAt: null,
            contentDigest: row.contentDigest,
            createdAt: row.createdAt,
          },
          select: { id: true, version: true },
        });
        await tx.customsBrokerAuthorizationSessionEvent.create({
          data: {
            id: randomUUID(),
            organizationId: row.organizationId,
            sessionRowId: session.id,
            fromStatus: 'CREATED',
            toStatus: 'CREATED',
            verificationSource: null,
            reason: 'CREATED',
            contentDigest: row.contentDigest,
            observedAt: row.createdAt,
          },
        });
        return session;
      });
      return { id: created.id, version: created.version };
    },

    async find(organizationId, sessionId) {
      const row = await prisma.customsBrokerAuthorizationSession.findFirst({
        where: { organizationId, sessionId },
      });
      if (!row) return null;
      return {
        id: row.id,
        organizationId: row.organizationId,
        sessionId: row.sessionId,
        principalRef: row.principalRef,
        brokerRef: row.brokerRef,
        providerRef: row.providerRef,
        jurisdiction: row.jurisdiction,
        requestedScope: Array.isArray(row.requestedScope) ? (row.requestedScope as string[]) : [],
        authorizationType: row.authorizationType as BrokerAuthorizationSessionRow['authorizationType'],
        route: row.route as CustomsFilingRoute,
        status: row.status as CustomsBrokerAuthorizationSessionStatus,
        version: row.version,
        externalAuthorizationUrlRef: row.externalAuthorizationUrlRef,
        providerAuthorizationRef: row.providerAuthorizationRef,
        evidenceArtifactRef: row.evidenceArtifactRef,
        verificationSource: (row.verificationSource as AuthorizationVerificationSource | null) ?? null,
        verifiedAt: row.verifiedAt,
        expiresAt: row.expiresAt,
        completedAt: row.completedAt,
        contentDigest: row.contentDigest,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async applyTransition(input) {
      return prisma.$transaction(async (tx) => {
        const updated = await tx.customsBrokerAuthorizationSession.updateMany({
          where: {
            id: input.rowId,
            organizationId: input.organizationId,
            status: input.expectedStatus,
            version: input.expectedVersion,
          },
          data: {
            status: input.next.status,
            version: input.expectedVersion + 1,
            providerAuthorizationRef: input.next.providerAuthorizationRef ?? null,
            evidenceArtifactRef: input.next.evidenceArtifactRef ?? null,
            verificationSource: (input.verificationSource as never) ?? null,
            verifiedAt: input.next.verifiedAt ?? null,
            completedAt: input.next.completedAt ?? null,
            contentDigest: input.next.contentDigest,
            updatedAt: input.next.updatedAt,
          },
        });
        if (updated.count === 0) return { applied: false as const, reason: 'STALE' as const };
        await tx.customsBrokerAuthorizationSessionEvent.create({
          data: {
            id: randomUUID(),
            organizationId: input.organizationId,
            sessionRowId: input.rowId,
            fromStatus: input.fromStatus,
            toStatus: input.next.status,
            verificationSource: (input.verificationSource as never) ?? null,
            reason: input.reason ?? null,
            contentDigest: input.next.contentDigest,
            observedAt: input.next.updatedAt,
          },
        });
        return { applied: true as const, version: input.expectedVersion + 1 };
      });
    },

    async listEvents(organizationId, sessionId) {
      const rows = await prisma.customsBrokerAuthorizationSessionEvent.findMany({
        where: { organizationId, session: { sessionId } },
        orderBy: [{ createdAt: 'asc' }, { observedAt: 'asc' }],
      });
      return rows.map((row) => ({
        id: row.id,
        fromStatus: row.fromStatus as CustomsBrokerAuthorizationSessionStatus,
        toStatus: row.toStatus as CustomsBrokerAuthorizationSessionStatus,
        verificationSource: (row.verificationSource as AuthorizationVerificationSource | null) ?? null,
        reason: row.reason,
        contentDigest: row.contentDigest,
        observedAt: row.observedAt,
      }));
    },
  };
}
