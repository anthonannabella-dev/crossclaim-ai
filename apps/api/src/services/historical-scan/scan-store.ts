// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 2 —— durable scan store（server-owned scope）
// ---------------------------------------------------------------------------
// 约束：
//   * 唯一 owner 是服务端：调用方只能传 goal/domain/account/区间，身份由确定性 digest 决定；
//   * 同一范围重复创建 → **不产生第二个 scan**（UNIQUE(organizationId, dedupeKey) + create-or-get）；
//   * tenant/account 隔离：跨租户读取返回 null / 抛错，绝不放行；
//   * 进度与检查点只增量更新，身份字段不可改写（DB 触发器兜底）。

import { Prisma, type PrismaClient, type RecoveryScanRun } from '@prisma/client';

import {
  buildRecoveryScanIdentity,
  toScanDay,
  verifyRecoveryScanDigest,
  SCAN_TERMINAL_STATUSES,
  type ScanCoverageStatus,
  type ScanStatus,
  type ShardGrain,
} from './scan-identity';

export class RecoveryScanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RecoveryScanError';
    this.code = code;
  }
}

export interface CreateRecoveryScanInput {
  readonly organizationId: string;
  readonly goalId: string;
  readonly goalDigest: string;
  readonly domain: string;
  readonly provider?: string | null;
  readonly platformAccountId?: string | null;
  readonly requestedFrom: Date | string;
  readonly requestedTo: Date | string;
  readonly effectiveFrom: Date | string;
  readonly effectiveTo: Date | string;
  readonly requestedMonths: number;
  readonly shardGrain?: ShardGrain;
  readonly shardsTotal?: number;
  readonly reasonCodes?: readonly string[];
  readonly now?: Date;
}

function dayToDate(day: string): Date {
  return new Date(day + 'T00:00:00.000Z');
}

/**
 * 创建或读取既有 scan（幂等）。**同一范围永远不会产生第二个 scan**。
 * 先校验 goal 属于该租户（tenant/account 隔离），再落库。
 */
export async function createOrGetRecoveryScan(
  prisma: PrismaClient,
  input: CreateRecoveryScanInput,
): Promise<{ row: RecoveryScanRun; created: boolean }> {
  const identity = buildRecoveryScanIdentity({
    goalDigest: input.goalDigest,
    domain: input.domain,
    provider: input.provider ?? null,
    platformAccountId: input.platformAccountId ?? null,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    requestedMonths: input.requestedMonths,
  });

  const goal = await prisma.agentGoal.findFirst({
    where: { organizationId: input.organizationId, id: input.goalId },
    select: { id: true },
  });
  if (!goal) throw new RecoveryScanError('RECOVERY_SCAN_GOAL_NOT_FOUND', '目标不属于该组织，拒绝创建扫描。');

  const now = input.now ?? new Date();
  try {
    const row = await prisma.recoveryScanRun.create({
      data: {
        organizationId: input.organizationId,
        goalId: input.goalId,
        goalDigest: identity.scope.goalDigest,
        domain: identity.scope.domain,
        provider: identity.scope.provider,
        platformAccountId: identity.scope.platformAccountId,
        requestedFrom: dayToDate(toScanDay(input.requestedFrom)),
        requestedTo: dayToDate(toScanDay(input.requestedTo)),
        effectiveFrom: dayToDate(identity.scope.effectiveFrom),
        effectiveTo: dayToDate(identity.scope.effectiveTo),
        requestedMonths: identity.scope.requestedMonths,
        scanPolicyVersion: identity.scanPolicyVersion,
        shardGrain: input.shardGrain ?? 'MONTHLY',
        status: 'CREATED',
        shardsTotal: input.shardsTotal ?? 0,
        reasonCodes: input.reasonCodes ? [...input.reasonCodes] : undefined,
        scanDigest: identity.scanDigest,
        dedupeKey: identity.dedupeKey,
        createdAt: now,
        updatedAt: now,
      },
    });
    return { row, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.recoveryScanRun.findUnique({
        where: { organizationId_dedupeKey: { organizationId: input.organizationId, dedupeKey: identity.dedupeKey } },
      });
      if (!existing) throw error;
      return { row: existing, created: false };
    }
    throw error;
  }
}

/** 按 dedupeKey 读取 scan scope（Runtime claim 后唯一允许的范围来源）。 */
export async function loadRecoveryScanScope(
  prisma: PrismaClient,
  input: { organizationId: string; dedupeKey: string },
): Promise<RecoveryScanRun | null> {
  const row = await prisma.recoveryScanRun.findUnique({
    where: { organizationId_dedupeKey: { organizationId: input.organizationId, dedupeKey: input.dedupeKey } },
  });
  if (!row) return null;
  if (!verifyRecoveryScanDigest(row)) {
    throw new RecoveryScanError('RECOVERY_SCAN_DIGEST_MISMATCH', '扫描身份摘要不一致，拒绝使用该范围。');
  }
  return row;
}

export async function loadRecoveryScanById(
  prisma: PrismaClient,
  input: { organizationId: string; scanId: string },
): Promise<RecoveryScanRun | null> {
  const row = await prisma.recoveryScanRun.findFirst({
    where: { organizationId: input.organizationId, id: input.scanId },
  });
  if (!row) return null;
  if (!verifyRecoveryScanDigest(row)) {
    throw new RecoveryScanError('RECOVERY_SCAN_DIGEST_MISMATCH', '扫描身份摘要不一致，拒绝使用该范围。');
  }
  return row;
}

/** 并发安全：只有处于 CREATED 的 scan 能被一个 worker 抢到（否则返回 null）。 */
export async function claimRecoveryScanRun(
  prisma: PrismaClient,
  input: { organizationId: string; scanId: string; leaseOwner: string; leaseExpiresAt: Date; now?: Date },
): Promise<RecoveryScanRun | null> {
  const result = await prisma.recoveryScanRun.updateMany({
    where: { organizationId: input.organizationId, id: input.scanId, status: 'CREATED' },
    data: {
      status: 'RUNNING',
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.now ?? new Date(),
    },
  });
  if (result.count !== 1) return null;
  return prisma.recoveryScanRun.findFirst({ where: { organizationId: input.organizationId, id: input.scanId } });
}

/** 推进 shard / page 检查点（幂等；cursor=null 表示该 shard 完成）。 */
export async function advanceRecoveryScanShard(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    scanId: string;
    shardIndex: number;
    shardKey: string;
    cursor: string | null;
    pageCount?: number;
    recordsScanned?: number;
    recordsAccepted?: number;
    recordsRejected?: number;
    opportunitiesFound?: number;
    eligibleFound?: number;
    expiredFound?: number;
    needsEvidenceFound?: number;
    now?: Date;
  },
): Promise<RecoveryScanRun> {
  const increment = (value: number | undefined) => (value === undefined ? undefined : { increment: value });
  const shardFinished = input.cursor === null;
  const row = await prisma.recoveryScanRun.update({
    where: { organizationId_id: { organizationId: input.organizationId, id: input.scanId } },
    data: {
      shardCursor: input.cursor,
      ...(shardFinished
        ? { shardsCompleted: { increment: 1 }, nextShardIndex: input.shardIndex + 1 }
        : {}),
      recordsScanned: increment(input.recordsScanned),
      recordsAccepted: increment(input.recordsAccepted),
      recordsRejected: increment(input.recordsRejected),
      opportunitiesFound: increment(input.opportunitiesFound),
      eligibleFound: increment(input.eligibleFound),
      expiredFound: increment(input.expiredFound),
      needsEvidenceFound: increment(input.needsEvidenceFound),
      updatedAt: input.now ?? new Date(),
    },
  });
  return row;
}

export async function setRecoveryScanCoverage(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    scanId: string;
    coverageStart: Date | string | null;
    coverageEnd: Date | string | null;
    sourceCoverageStatus: ScanCoverageStatus;
    now?: Date;
  },
): Promise<RecoveryScanRun> {
  return prisma.recoveryScanRun.update({
    where: { organizationId_id: { organizationId: input.organizationId, id: input.scanId } },
    data: {
      coverageStart: input.coverageStart ? dayToDate(toScanDay(input.coverageStart)) : null,
      coverageEnd: input.coverageEnd ? dayToDate(toScanDay(input.coverageEnd)) : null,
      sourceCoverageStatus: input.sourceCoverageStatus,
      updatedAt: input.now ?? new Date(),
    },
  });
}

export async function finishRecoveryScan(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    scanId: string;
    status: ScanStatus;
    reasonCodes?: readonly string[];
    now?: Date;
  },
): Promise<RecoveryScanRun> {
  if (!SCAN_TERMINAL_STATUSES.includes(input.status)) {
    throw new RecoveryScanError('RECOVERY_SCAN_INVALID_STATUS', '只有终态可以 finish：' + input.status);
  }
  const now = input.now ?? new Date();
  return prisma.recoveryScanRun.update({
    where: { organizationId_id: { organizationId: input.organizationId, id: input.scanId } },
    data: {
      status: input.status,
      completedAt: now,
      updatedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      ...(input.reasonCodes ? { reasonCodes: [...input.reasonCodes] } : {}),
    },
  });
}
