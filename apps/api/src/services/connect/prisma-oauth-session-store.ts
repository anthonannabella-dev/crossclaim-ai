// AGENT EXPERIENCE LAYER / P9 — durable OAuth 授权会话（B2 缺口最小补强）
// ---------------------------------------------------------------------------
// 复用既有 PC-11A 边界（`oauth-state.ts` 的 state 生成 / PKCE / 一次性语义 +
// `provider-callback.ts` 的回调编排），本模块只补**持久化承载**与**恢复原目标**的绑定：
//   * 原始 state 永不落库（只存 sha256 摘要）；
//   * 一次性：`take` 用行级 CAS 把 PENDING → CONSUMED，第二次调用恒返回 null（重放保护）；
//   * 进程重启后仍可完成回调（durable）；
//   * callback 成功后记录 connectionId / credentialRef，并保留 `resumeGoalId`
//     —— 供上层把「OAuth redirect → callback → verified connection → 恢复原 goal」串起来；
//   * 不建第二连接事实源：本表只描述**授权会话**，连接事实仍在 SourceConnection / PlatformAccount；
//   * 不执行任何外部写、不持有生产凭据（credentialRef 只是引用名）。

import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import {
  issueOAuthState,
  type OAuthStateRecord,
  type OAuthStateStore,
  type IssuedOAuthState,
} from './oauth-state';
import { resolveProviderContract } from './provider-integration-contract';

export const OAUTH_SESSION_STORE_VERSION = 'oauth-session-store/v1';

export const OAUTH_SESSION_STATUSES = ['PENDING', 'CONSUMED', 'SUCCEEDED', 'FAILED'] as const;
export type OAuthSessionStatus = (typeof OAUTH_SESSION_STATUSES)[number];

export type OAuthSessionStoreErrorCode =
  | 'OAUTH_SESSION_NOT_FOUND'
  | 'OAUTH_SESSION_INVALID_TRANSITION'
  | 'OAUTH_SESSION_UNKNOWN_PROVIDER'
  | 'OAUTH_SESSION_CALLBACK_PATH_NOT_ALLOWED';

export class OAuthSessionStoreError extends Error {
  readonly code: OAuthSessionStoreErrorCode;

  constructor(code: OAuthSessionStoreErrorCode, message: string) {
    super(message);
    this.name = 'OAuthSessionStoreError';
    this.code = code;
  }
}

export interface OAuthAuthorizationSessionView {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly provider: string;
  readonly callbackPath: string;
  readonly redirectTarget: string;
  readonly resumeGoalId: string | null;
  readonly status: OAuthSessionStatus;
  readonly failureReason: string | null;
  readonly connectionId: string | null;
  /** 只回引用名，绝不含凭据值 */
  readonly credentialRef: string | null;
  readonly initiatedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

function stateDigestOf(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

function toView(row: {
  id: string;
  organizationId: string;
  userId: string;
  provider: string;
  callbackPath: string;
  redirectTarget: string;
  resumeGoalId: string | null;
  status: string;
  failureReason: string | null;
  connectionId: string | null;
  credentialRef: string | null;
  initiatedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}): OAuthAuthorizationSessionView {
  if (!(OAUTH_SESSION_STATUSES as readonly string[]).includes(row.status)) {
    throw new OAuthSessionStoreError('OAUTH_SESSION_INVALID_TRANSITION', 'status 非法：' + row.status);
  }
  return {
    sessionId: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    provider: row.provider,
    callbackPath: row.callbackPath,
    redirectTarget: row.redirectTarget,
    resumeGoalId: row.resumeGoalId,
    status: row.status as OAuthSessionStatus,
    failureReason: row.failureReason,
    connectionId: row.connectionId,
    credentialRef: row.credentialRef,
    initiatedAt: row.initiatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    consumedAt: row.consumedAt === null ? null : row.consumedAt.toISOString(),
  };
}

export interface InitiateOAuthAuthorizationSessionInput {
  organizationId: string;
  userId: string;
  provider: string;
  callbackPath: string;
  redirectTarget: string;
  /** callback 成功后可恢复的原始 goal（可为空：纯连接授权） */
  resumeGoalId?: string | null;
  ttlSeconds?: number;
  now?: Date;
}

export interface InitiatedOAuthAuthorizationSession extends Omit<IssuedOAuthState, 'productionAuthorizationEnabled'> {
  readonly sessionId: string;
  readonly resumeGoalId: string | null;
  /** 恒为 false：本层不产生任何真实平台授权 */
  readonly productionAuthorizationEnabled: false;
  /** 恒为 false：不执行连接绑定（绑定由既有 onboarding 流程负责） */
  readonly bindExecuted: false;
}

/**
 * 发起授权会话：复用既有 state/PKCE/TTL/契约校验，落一条 durable 会话记录。
 * 原始 state 只出现在返回值里，数据库只存摘要。
 */
export async function initiateOAuthAuthorizationSession(
  prisma: PrismaClient,
  input: InitiateOAuthAuthorizationSessionInput,
  deps: { randomBytes?: (size: number) => Buffer } = {},
): Promise<InitiatedOAuthAuthorizationSession> {
  const contract = resolveProviderContract(input.provider);
  if (!contract) throw new OAuthSessionStoreError('OAUTH_SESSION_UNKNOWN_PROVIDER', '未知 provider：' + input.provider);
  if (contract.callbackPath !== input.callbackPath) {
    throw new OAuthSessionStoreError('OAUTH_SESSION_CALLBACK_PATH_NOT_ALLOWED', '回调路径不在 provider 契约内。');
  }
  const now = input.now ?? new Date();
  let captured: OAuthStateRecord | null = null;
  const issued = await issueOAuthState(
    {
      async save(record) {
        captured = record;
      },
      async take() {
        return null;
      },
    },
    {
      provider: input.provider,
      organizationId: input.organizationId,
      userId: input.userId,
      callbackPath: input.callbackPath,
      ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
    },
    { now: () => now, ...(deps.randomBytes === undefined ? {} : { randomBytes: deps.randomBytes }) },
  );
  const record = captured as OAuthStateRecord | null;
  if (record === null) throw new OAuthSessionStoreError('OAUTH_SESSION_INVALID_TRANSITION', 'state 生成失败。');

  const created = await prisma.oAuthAuthorizationSession.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      provider: record.provider,
      callbackPath: record.callbackPath,
      stateDigest: stateDigestOf(record.state),
      codeVerifier: record.codeVerifier,
      redirectTarget: input.redirectTarget,
      resumeGoalId: input.resumeGoalId ?? null,
      status: 'PENDING',
      initiatedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  });

  return {
    sessionId: created.id,
    state: issued.state,
    provider: issued.provider,
    callbackPath: issued.callbackPath,
    authorizationUrl: issued.authorizationUrl,
    expiresAt: issued.expiresAt,
    codeChallenge: issued.codeChallenge,
    codeChallengeMethod: issued.codeChallengeMethod,
    resumeGoalId: input.resumeGoalId ?? null,
    productionAuthorizationEnabled: false,
    bindExecuted: false,
  };
}

/**
 * durable `OAuthStateStore`：`take` 用行级 CAS 把 PENDING → CONSUMED。
 * 第二次调用（重放）恒返回 null；过期记录也返回 null（fail-closed）。
 */
export function createPrismaOAuthStateStore(prisma: PrismaClient, deps: { now?: () => Date } = {}): OAuthStateStore {
  return {
    async save() {
      // 会话创建走 `initiateOAuthAuthorizationSession`（避免两条写路径）
      throw new OAuthSessionStoreError(
        'OAUTH_SESSION_INVALID_TRANSITION',
        'durable store 不接受直接 save；请使用 initiateOAuthAuthorizationSession。',
      );
    },
    async take(state: string): Promise<OAuthStateRecord | null> {
      const digest = stateDigestOf(state);
      const now = deps.now?.() ?? new Date();
      const row = await prisma.oAuthAuthorizationSession.findFirst({ where: { stateDigest: digest } });
      if (row === null) return null;
      // 只有 PENDING 才能被消费（CONSUMED/SUCCEEDED/FAILED 一律视为重放，fail-closed）
      if (row.status !== 'PENDING') return null;
      if (row.expiresAt.getTime() <= now.getTime()) return null;
      try {
        // 行级 CAS：并发回调只有一个能把 PENDING 改为 CONSUMED
        const consumed = await prisma.oAuthAuthorizationSession.updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: { status: 'CONSUMED', consumedAt: now, updatedAt: now },
        });
        if (consumed.count !== 1) return null;
        return {
          state,
          provider: row.provider,
          organizationId: row.organizationId,
          userId: row.userId,
          callbackPath: row.callbackPath,
          codeVerifier: row.codeVerifier,
          issuedAt: row.initiatedAt,
          expiresAt: row.expiresAt,
        };
      } catch (error) {
        // CAS 冲突（并发回调）→ 视作重放，fail-closed
        if (error instanceof Prisma.PrismaClientKnownRequestError) return null;
        throw error;
      }
    },
  };
}

export async function loadOAuthAuthorizationSession(
  prisma: PrismaClient,
  input: { organizationId: string; sessionId: string },
): Promise<OAuthAuthorizationSessionView | null> {
  const row = await prisma.oAuthAuthorizationSession.findFirst({
    where: { organizationId: input.organizationId, id: input.sessionId },
  });
  return row === null ? null : toView(row);
}

export async function listOAuthAuthorizationSessions(
  prisma: PrismaClient,
  input: { organizationId: string; provider?: string | null },
): Promise<OAuthAuthorizationSessionView[]> {
  const rows = await prisma.oAuthAuthorizationSession.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.provider === undefined || input.provider === null ? {} : { provider: input.provider.toUpperCase() }),
    },
    orderBy: { initiatedAt: 'desc' },
    take: 50,
  });
  return rows.map(toView);
}

/** 回调成功：记录已验证连接与凭据引用，并保留 `resumeGoalId` 供上层恢复原目标 */
export async function succeedOAuthAuthorizationSession(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    sessionId: string;
    connectionId: string;
    credentialRef: string;
    now: Date;
  },
): Promise<OAuthAuthorizationSessionView> {
  const row = await prisma.oAuthAuthorizationSession.findFirst({
    where: { organizationId: input.organizationId, id: input.sessionId },
  });
  if (row === null) throw new OAuthSessionStoreError('OAUTH_SESSION_NOT_FOUND', '会话不存在（或不属于该租户）。');
  if (row.status === 'SUCCEEDED') return toView(row);
  if (row.status === 'FAILED') {
    throw new OAuthSessionStoreError('OAUTH_SESSION_INVALID_TRANSITION', '已失败的会话不得转为成功。');
  }
  const updated = await prisma.oAuthAuthorizationSession.update({
    where: { id: input.sessionId },
    data: {
      status: 'SUCCEEDED',
      connectionId: input.connectionId,
      credentialRef: input.credentialRef,
      consumedAt: row.consumedAt ?? input.now,
      updatedAt: input.now,
    },
  });
  return toView(updated);
}

export async function failOAuthAuthorizationSession(
  prisma: PrismaClient,
  input: { organizationId: string; sessionId: string; reason: string; now: Date },
): Promise<OAuthAuthorizationSessionView> {
  const row = await prisma.oAuthAuthorizationSession.findFirst({
    where: { organizationId: input.organizationId, id: input.sessionId },
  });
  if (row === null) throw new OAuthSessionStoreError('OAUTH_SESSION_NOT_FOUND', '会话不存在（或不属于该租户）。');
  if (row.status === 'SUCCEEDED') {
    throw new OAuthSessionStoreError('OAUTH_SESSION_INVALID_TRANSITION', '已成功的会话不得转为失败。');
  }
  const updated = await prisma.oAuthAuthorizationSession.update({
    where: { id: input.sessionId },
    data: {
      status: 'FAILED',
      failureReason: input.reason.slice(0, 200),
      consumedAt: row.consumedAt ?? input.now,
      updatedAt: input.now,
    },
  });
  return toView(updated);
}

export const OAUTH_SESSION_STORE_BOUNDARY = {
  version: OAUTH_SESSION_STORE_VERSION,
  durable: true,
  rawStatePersisted: false,
  stateDigestOnly: true,
  singleUse: true,
  replayProtected: true,
  restartSafe: true,
  bindsResumeGoal: true,
  createsConnectionFactSource: false,
  executesExternalWrite: false,
  holdsProductionCredentials: false,
  productionAuthorizationEnabled: false,
  forbidden: [
    'persisting the raw OAuth state',
    'returning the PKCE verifier to a client',
    'reusing a consumed state',
    'creating a second connection fact source',
    'performing a real provider authorization while transport is disabled',
  ],
} as const;
