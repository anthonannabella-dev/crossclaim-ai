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
/**
 * HISTORICAL_RECOVERY_SCAN_V1 / AUDIT-3 CHANGE 2 —— durable ownership fencing。
 * 当调用方携带 `expectedLeaseOwner` 时，所有 checkpoint / coverage / finish 写入都必须是**条件更新**
 * （where leaseOwner = 期望的持有者）。若 0 行受影响，说明租约已被他人 reclaim 或已释放
 * → 抛 `RECOVERY_SCAN_LEASE_FENCED`，陈旧 worker 绝不允许覆盖已接管的检查点。
 */
async function updateScanFenced(
  prisma: PrismaClient,
  input: { organizationId: string; scanId: string; expectedLeaseOwner?: string; now?: Date },
  data: Prisma.RecoveryScanRunUpdateManyMutationInput,
): Promise<RecoveryScanRun> {
  if (input.expectedLeaseOwner === undefined) {
    return prisma.recoveryScanRun.update({
      where: { organizationId_id: { organizationId: input.organizationId, id: input.scanId } },
      data,
    });
  }
  // AUDIT-3R2 CHANGE 2：fencing 不仅要 owner 相符，还必须**租约仍在有效期内**（status=RUNNING 且 leaseExpiresAt > now）。
  // 否则长扫描跨过租约边界后、即使无人 reclaim，也会被立即阻断（配合 executor 的每页续租）。
  const now = input.now ?? new Date();
  const result = await prisma.recoveryScanRun.updateMany({
    where: {
      organizationId: input.organizationId,
      id: input.scanId,
      leaseOwner: input.expectedLeaseOwner,
      status: 'RUNNING',
      leaseExpiresAt: { gt: now },
    },
    data,
  });
  if (result.count !== 1) {
    throw new RecoveryScanError(
      'RECOVERY_SCAN_LEASE_FENCED',
      '租约已被接管或释放，拒绝陈旧 worker 写入扫描检查点。',
    );
  }
  const row = await prisma.recoveryScanRun.findFirst({
    where: { organizationId: input.organizationId, id: input.scanId },
  });
  if (row === null) throw new RecoveryScanError('RECOVERY_SCAN_NOT_FOUND', '扫描不存在。');
  return row;
}

/**
 * AUDIT-3R2 CHANGE 2：**续租**（CAS：仅当自己仍是 owner 且当前租约尚未过期）。
 * 返回 false 表示续租失败（租约已被他人 reclaim / 已过期）→ 调用方必须立即停止，绝不再推进分片。
 */
export async function renewRecoveryScanLease(
  prisma: PrismaClient,
  input: { organizationId: string; scanId: string; leaseOwner: string; leaseExpiresAt: Date; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = await prisma.recoveryScanRun.updateMany({
    where: {
      organizationId: input.organizationId,
      id: input.scanId,
      status: 'RUNNING',
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: { gt: now },
    },
    data: { leaseExpiresAt: input.leaseExpiresAt, updatedAt: now },
  });
  return result.count === 1;
}

/**
 * 接管**已过期**的 RUNNING 租约（CAS：仅当 `status=RUNNING` 且 `leaseExpiresAt < now`）。
 * 返回 null 表示当前没有可接管的过期租约（他人仍持有 / 未认领 / 已终态）。
 */
export async function reclaimRecoveryScanLease(
  prisma: PrismaClient,
  input: { organizationId: string; scanId: string; leaseOwner: string; leaseExpiresAt: Date; now?: Date },
): Promise<RecoveryScanRun | null> {
  const now = input.now ?? new Date();
  const result = await prisma.recoveryScanRun.updateMany({
    where: {
      organizationId: input.organizationId,
      id: input.scanId,
      status: 'RUNNING',
      leaseExpiresAt: { lt: now },
    },
    data: { leaseOwner: input.leaseOwner, leaseExpiresAt: input.leaseExpiresAt, updatedAt: now },
  });
  if (result.count !== 1) return null;
  return prisma.recoveryScanRun.findFirst({ where: { organizationId: input.organizationId, id: input.scanId } });
}

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
    /** AUDIT-3 CHANGE 2：fencing —— 携带期望的租约持有者时，写入是条件更新（0 行 → FENCED） */
    expectedLeaseOwner?: string;
    now?: Date;
  },
): Promise<RecoveryScanRun> {
  const increment = (value: number | undefined) => (value === undefined ? undefined : { increment: value });
  const shardFinished = input.cursor === null;
  const row = await updateScanFenced(
    prisma,
    {
      organizationId: input.organizationId,
      scanId: input.scanId,
      now: input.now ?? new Date(),
      ...(input.expectedLeaseOwner === undefined ? {} : { expectedLeaseOwner: input.expectedLeaseOwner }),
    },
    {
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
  );
  return row;
}

/** AUDIT-3R2 CHANGE 1：`shardsTotal` 初始化走同一 fenced 路径（带 expectedLeaseOwner 时条件更新）。 */
export async function setRecoveryScanShardsTotal(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    scanId: string;
    shardsTotal: number;
    expectedLeaseOwner?: string;
    now?: Date;
  },
): Promise<RecoveryScanRun> {
  return updateScanFenced(
    prisma,
    {
      organizationId: input.organizationId,
      scanId: input.scanId,
      now: input.now ?? new Date(),
      ...(input.expectedLeaseOwner === undefined ? {} : { expectedLeaseOwner: input.expectedLeaseOwner }),
    },
    { shardsTotal: input.shardsTotal, updatedAt: input.now ?? new Date() },
  );
}

export async function setRecoveryScanCoverage(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    scanId: string;
    coverageStart: Date | string | null;
    coverageEnd: Date | string | null;
    sourceCoverageStatus: ScanCoverageStatus;
    expectedLeaseOwner?: string;
    now?: Date;
  },
): Promise<RecoveryScanRun> {
  return updateScanFenced(
    prisma,
    {
      organizationId: input.organizationId,
      scanId: input.scanId,
      now: input.now ?? new Date(),
      ...(input.expectedLeaseOwner === undefined ? {} : { expectedLeaseOwner: input.expectedLeaseOwner }),
    },
    {
      coverageStart: input.coverageStart ? dayToDate(toScanDay(input.coverageStart)) : null,
      coverageEnd: input.coverageEnd ? dayToDate(toScanDay(input.coverageEnd)) : null,
      sourceCoverageStatus: input.sourceCoverageStatus,
      updatedAt: input.now ?? new Date(),
    },
  );
}

export async function finishRecoveryScan(
  prisma: PrismaClient,
  input: {
    organizationId: string;
    scanId: string;
    status: ScanStatus;
    reasonCodes?: readonly string[];
    expectedLeaseOwner?: string;
    now?: Date;
  },
): Promise<RecoveryScanRun> {
  if (!SCAN_TERMINAL_STATUSES.includes(input.status)) {
    throw new RecoveryScanError('RECOVERY_SCAN_INVALID_STATUS', '只有终态可以 finish：' + input.status);
  }
  const now = input.now ?? new Date();
  return updateScanFenced(
    prisma,
    {
      organizationId: input.organizationId,
      scanId: input.scanId,
      now,
      ...(input.expectedLeaseOwner === undefined ? {} : { expectedLeaseOwner: input.expectedLeaseOwner }),
    },
    {
      status: input.status,
      completedAt: now,
      updatedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      ...(input.reasonCodes ? { reasonCodes: [...input.reasonCodes] } : {}),
    },
  );
}
