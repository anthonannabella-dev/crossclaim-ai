// AGENT EXPERIENCE LAYER / P9 — ConnectionSyncState（既有 SourceConnection 的**检查点投影**）
// ---------------------------------------------------------------------------
// 定位：连接事实（存在性 / 身份 / 状态）仍完全属于既有 `SourceConnection` + `PlatformAccount`；
//   本模块只承载「同步到哪里了 / 上次成功 / 上次错误 / 重试状态」这一层检查点。
//   * **不**新增第二连接事实源、**不**建第二 scheduler（本模块不包含任何定时/循环）；
//   * 重试策略是**纯函数**（由既有执行器在读过状态后自行决定何时再试）；
//   * 跨租户读写恒不可见。

import type { PrismaClient } from '@prisma/client';

export const CONNECTION_SYNC_STATE_VERSION = 'connection-sync-state/v1';

export const CONNECTION_SYNC_RETRY_POLICY = {
  baseDelayMs: 60_000,
  maxDelayMs: 60 * 60 * 1000,
  /** 连续失败达到该阈值 → 需要重新授权（而不是继续盲目重试） */
  needsReauthAfterFailures: 5,
} as const;

export const CONNECTION_SYNC_RETRY_STATES = ['IDLE', 'BACKOFF', 'NEEDS_REAUTH'] as const;
export type ConnectionSyncRetryState = (typeof CONNECTION_SYNC_RETRY_STATES)[number];

/** 纯函数：连续失败 → 退避（指数 + 上限）或 NEEDS_REAUTH（fail-closed，不再盲目重试） */
export function computeSyncRetryState(input: {
  consecutiveFailures: number;
  now: Date;
}): { retryState: ConnectionSyncRetryState; nextRetryAt: Date | null } {
  const failures = Math.max(0, Math.trunc(input.consecutiveFailures));
  if (failures === 0) return { retryState: 'IDLE', nextRetryAt: null };
  if (failures >= CONNECTION_SYNC_RETRY_POLICY.needsReauthAfterFailures) {
    return { retryState: 'NEEDS_REAUTH', nextRetryAt: null };
  }
  const delay = Math.min(
    CONNECTION_SYNC_RETRY_POLICY.maxDelayMs,
    CONNECTION_SYNC_RETRY_POLICY.baseDelayMs * 2 ** (failures - 1),
  );
  return { retryState: 'BACKOFF', nextRetryAt: new Date(input.now.getTime() + delay) };
}

export interface ConnectionSyncStateView {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly cursor: string | null;
  readonly lastSuccessfulSyncAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly consecutiveFailures: number;
  readonly retryState: ConnectionSyncRetryState;
  readonly nextRetryAt: string | null;
}

function toView(row: {
  organizationId: string;
  connectionId: string;
  cursor: string | null;
  lastSuccessfulSyncAt: Date | null;
  lastAttemptAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  consecutiveFailures: number;
  retryState: string;
  nextRetryAt: Date | null;
}): ConnectionSyncStateView {
  return {
    organizationId: row.organizationId,
    connectionId: row.connectionId,
    cursor: row.cursor,
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt === null ? null : row.lastSuccessfulSyncAt.toISOString(),
    lastAttemptAt: row.lastAttemptAt === null ? null : row.lastAttemptAt.toISOString(),
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt === null ? null : row.lastErrorAt.toISOString(),
    consecutiveFailures: row.consecutiveFailures,
    retryState: row.retryState as ConnectionSyncRetryState,
    nextRetryAt: row.nextRetryAt === null ? null : row.nextRetryAt.toISOString(),
  };
}

export async function loadConnectionSyncState(
  prisma: PrismaClient,
  input: { organizationId: string; connectionId: string },
): Promise<ConnectionSyncStateView | null> {
  const row = await prisma.connectionSyncState.findFirst({
    where: { organizationId: input.organizationId, connectionId: input.connectionId },
  });
  return row === null ? null : toView(row);
}

export async function listConnectionSyncStates(
  prisma: PrismaClient,
  input: { organizationId: string },
): Promise<ConnectionSyncStateView[]> {
  const rows = await prisma.connectionSyncState.findMany({
    where: { organizationId: input.organizationId },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });
  return rows.map(toView);
}

/** 同步成功：推进检查点、清零失败计数、回到 IDLE */
export async function recordConnectionSyncSuccess(
  prisma: PrismaClient,
  input: { organizationId: string; connectionId: string; cursor?: string | null; now: Date },
): Promise<ConnectionSyncStateView> {
  const existing = await loadConnectionSyncState(prisma, {
    organizationId: input.organizationId,
    connectionId: input.connectionId,
  });
  const row = await prisma.connectionSyncState.upsert({
    where: { organizationId_connectionId: { organizationId: input.organizationId, connectionId: input.connectionId } },
    create: {
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      cursor: input.cursor ?? null,
      lastSuccessfulSyncAt: input.now,
      lastAttemptAt: input.now,
      consecutiveFailures: 0,
      retryState: 'IDLE',
      createdAt: input.now,
      updatedAt: input.now,
    },
    update: {
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      lastSuccessfulSyncAt: input.now,
      lastAttemptAt: input.now,
      lastError: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
      retryState: 'IDLE',
      nextRetryAt: null,
      updatedAt: input.now,
    },
  });
  if (existing === null && row === null) {
    throw new Error('CONNECTION_SYNC_STATE_UPSERT_FAILED');
  }
  return toView(row);
}

/** 同步失败：记录错误、累计失败、按纯函数策略给出退避或「需要重新授权」 */
export async function recordConnectionSyncFailure(
  prisma: PrismaClient,
  input: { organizationId: string; connectionId: string; error: string; now: Date; needsReauth?: boolean },
): Promise<ConnectionSyncStateView> {
  const existing = await loadConnectionSyncState(prisma, {
    organizationId: input.organizationId,
    connectionId: input.connectionId,
  });
  const failures = (existing?.consecutiveFailures ?? 0) + 1;
  const policy = input.needsReauth === true
    ? { retryState: 'NEEDS_REAUTH' as const, nextRetryAt: null }
    : computeSyncRetryState({ consecutiveFailures: failures, now: input.now });
  const row = await prisma.connectionSyncState.upsert({
    where: { organizationId_connectionId: { organizationId: input.organizationId, connectionId: input.connectionId } },
    create: {
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      lastAttemptAt: input.now,
      lastError: input.error.slice(0, 500),
      lastErrorAt: input.now,
      consecutiveFailures: failures,
      retryState: policy.retryState,
      nextRetryAt: policy.nextRetryAt,
      createdAt: input.now,
      updatedAt: input.now,
    },
    update: {
      lastAttemptAt: input.now,
      lastError: input.error.slice(0, 500),
      lastErrorAt: input.now,
      consecutiveFailures: failures,
      retryState: policy.retryState,
      nextRetryAt: policy.nextRetryAt,
      updatedAt: input.now,
    },
  });
  return toView(row);
}

export const CONNECTION_SYNC_STATE_BOUNDARY = {
  version: CONNECTION_SYNC_STATE_VERSION,
  isCheckpointProjection: true,
  isSecondConnectionFactSource: false,
  connectionFactOwner: 'SourceConnection / PlatformAccount',
  createsScheduler: false,
  containsRetryLoop: false,
  retryPolicyIsPure: true,
  maxConsecutiveFailuresBeforeReauth: CONNECTION_SYNC_RETRY_POLICY.needsReauthAfterFailures,
  tenantScoped: true,
  forbidden: [
    'holding connection identity (owned by SourceConnection / PlatformAccount)',
    'creating a second scheduler or retry loop',
    'blindly retrying after repeated failures instead of requiring re-authorization',
    'reading or writing another tenant\'s sync state',
  ],
} as const;
