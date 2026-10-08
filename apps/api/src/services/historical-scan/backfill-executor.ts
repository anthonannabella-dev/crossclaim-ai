// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 6 —— Historical Backfill Executor
// ---------------------------------------------------------------------------
// 约束：
//   * **不新建第二 Runtime**：本执行器是既有 ONE SI Runtime 认领之后被调用的**领域步骤**，
//     不做调度、不做 lease 竞争之外的并发控制、不直接调用 runner；
//   * 分片执行：MONTHLY/QUARTERLY，逐 shard → 逐 page；每个 page 处理完才推进 durable checkpoint；
//   * crash resume：下次调用从 `nextShardIndex` + `shardCursor` 继续；
//   * 幂等：同一 page 重放不得产生重复业务结果 —— 由 ingest 端口保证（既有 fingerprint 去重链）。

import type { PrismaClient, RecoveryScanRun } from '@prisma/client';

import {
  advanceRecoveryScanShard,
  finishRecoveryScan,
  loadRecoveryScanById,
  renewRecoveryScanLease,
  setRecoveryScanCoverage,
  setRecoveryScanShardsTotal,
} from './scan-store';
import { planScanShards, type ScanShard } from './shard-plan';
import type { ScanCoverageStatus, ShardGrain } from './scan-identity';

export interface BackfillPage {
  readonly records: readonly unknown[];
  readonly nextCursor: string | null;
  /** provider 实际覆盖（用于 coverage tracking；不得靠请求范围推断） */
  readonly coverageFrom?: string | null;
  readonly coverageTo?: string | null;
  readonly coverageStatus?: ScanCoverageStatus;
}

export interface BackfillPagePort {
  fetchPage(input: {
    readonly organizationId: string;
    readonly scanId: string;
    readonly shard: ScanShard;
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<BackfillPage>;
}

export interface BackfillIngestPort {
  ingest(input: {
    readonly organizationId: string;
    readonly scanId: string;
    readonly shard: ScanShard;
    readonly records: readonly unknown[];
  }): Promise<{
    readonly accepted: number;
    readonly rejected: number;
    readonly opportunitiesFound?: number;
    readonly eligibleFound?: number;
    readonly expiredFound?: number;
    readonly needsEvidenceFound?: number;
  }>;
}

export interface BackfillRunResult {
  readonly status: RecoveryScanRun['status'];
  readonly shardsCompleted: number;
  readonly shardsTotal: number;
  readonly recordsScanned: number;
  readonly blocked: boolean;
  readonly reasonCodes: readonly string[];
}

/**
 * 执行（或续跑）一次历史扫描。可在任意时刻中断；再次调用即从 durable checkpoint 继续。
 * `maxPages` 只用于测试/预算控制，到达上限时**不标记完成**，而是把当前 checkpoint 留在库里。
 */
export async function runHistoricalBackfill(
  prisma: PrismaClient,
  input: {
    readonly organizationId: string;
    readonly scanId: string;
    readonly pagePort: BackfillPagePort;
    readonly ingestPort: BackfillIngestPort;
    readonly grain?: ShardGrain;
    readonly pageLimit?: number;
    readonly maxPages?: number;
    /**
     * AUDIT-3 CHANGE 2：durable ownership fencing —— 调用方声明自己是该 scan 的租约持有者；
     * 所有权不符 / 租约过期 → BLOCKED；写入期间被他人 reclaim → BLOCKED（RECOVERY_SCAN_LEASE_FENCED）。
     */
    readonly expectedLeaseOwner?: string;
    /** 续租时长（毫秒，默认 60s）；仅在 expectedLeaseOwner 存在时使用 */
    readonly leaseMs?: number;
    readonly now?: () => Date;
  },
): Promise<BackfillRunResult> {
  const now = input.now ?? (() => new Date());
  const lease = (): { expectedLeaseOwner?: string } =>
    input.expectedLeaseOwner === undefined ? {} : { expectedLeaseOwner: input.expectedLeaseOwner };
  let scan = await loadRecoveryScanById(prisma, {
    organizationId: input.organizationId,
    scanId: input.scanId,
  });
  if (!scan) {
    return {
      status: 'BLOCKED',
      shardsCompleted: 0,
      shardsTotal: 0,
      recordsScanned: 0,
      blocked: true,
      reasonCodes: ['RECOVERY_SCAN_NOT_FOUND_OR_TENANT_MISMATCH'],
    };
  }
  if (scan.status === 'COMPLETED' || scan.status === 'BLOCKED' || scan.status === 'FAILED') {
    return {
      status: scan.status,
      shardsCompleted: scan.shardsCompleted,
      shardsTotal: scan.shardsTotal,
      recordsScanned: scan.recordsScanned,
      blocked: scan.status !== 'COMPLETED',
      reasonCodes: (scan.reasonCodes as string[] | null) ?? [],
    };
  }
  // AUDIT-3 CHANGE 2：执行资格必须先由 durable 租约证明（不再是「拿到 org + scanId 就能推进」）
  if (input.expectedLeaseOwner !== undefined) {
    if (scan.leaseOwner !== input.expectedLeaseOwner) {
      return {
        status: 'BLOCKED',
        shardsCompleted: scan.shardsCompleted,
        shardsTotal: scan.shardsTotal,
        recordsScanned: scan.recordsScanned,
        blocked: true,
        reasonCodes: ['RECOVERY_SCAN_LEASE_NOT_HELD'],
      };
    }
    if (scan.leaseExpiresAt !== null && scan.leaseExpiresAt.getTime() <= now().getTime()) {
      return {
        status: 'BLOCKED',
        shardsCompleted: scan.shardsCompleted,
        shardsTotal: scan.shardsTotal,
        recordsScanned: scan.recordsScanned,
        blocked: true,
        reasonCodes: ['RECOVERY_SCAN_LEASE_EXPIRED'],
      };
    }
  }

  const shards = planScanShards({ from: scan.effectiveFrom, to: scan.effectiveTo, grain: input.grain });
  if (scan.shardsTotal !== shards.length) {
    // AUDIT-3R2 CHANGE 1：shardsTotal 初始化同属 durable execution state，必须走同一 fenced 路径，
    // 否则「A 校验通过 → B reclaim → A 的裸 update 仍能写」的竞态依然存在。
    scan = await setRecoveryScanShardsTotal(prisma, {
      organizationId: input.organizationId,
      scanId: input.scanId,
      shardsTotal: shards.length,
      now: now(),
      ...lease(),
    });
  }

  const pageLimit = input.pageLimit ?? 100;
  let pagesProcessed = 0;
  let blockedReason: string | null = null;

  for (const shard of shards) {
    if (shard.index < scan.nextShardIndex) continue;
    let cursor: string | null = shard.index === scan.nextShardIndex ? scan.shardCursor : null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (input.maxPages !== undefined && pagesProcessed >= input.maxPages) {
        return {
          status: 'PARTIAL',
          shardsCompleted: scan.shardsCompleted,
          shardsTotal: scan.shardsTotal,
          recordsScanned: scan.recordsScanned,
          blocked: false,
          reasonCodes: ['PAGE_BUDGET_REACHED'],
        };
      }
      // AUDIT-3R2 CHANGE 2：每页取数前续租（CAS：自己仍是 owner 且当前租约未过期）。
      // 续租失败 ⇒ 立即停止，绝不 ingest 下一页（避免 fencing 失败前已产生副作用）。
      if (input.expectedLeaseOwner !== undefined) {
        const at = now();
        const renewed = await renewRecoveryScanLease(prisma, {
          organizationId: input.organizationId,
          scanId: input.scanId,
          leaseOwner: input.expectedLeaseOwner,
          leaseExpiresAt: new Date(at.getTime() + (input.leaseMs ?? 60_000)),
          now: at,
        });
        if (!renewed) {
          return {
            status: 'BLOCKED',
            shardsCompleted: scan.shardsCompleted,
            shardsTotal: scan.shardsTotal,
            recordsScanned: scan.recordsScanned,
            blocked: true,
            reasonCodes: ['RECOVERY_SCAN_LEASE_RENEW_FAILED'],
          };
        }
      }

      const page = await input.pagePort.fetchPage({
        organizationId: input.organizationId,
        scanId: input.scanId,
        shard,
        cursor,
        limit: pageLimit,
      });
      pagesProcessed += 1;

      // provider 实际覆盖 → coverage tracking（不得按请求范围推断 FULL）
      if (page.coverageFrom !== undefined || page.coverageTo !== undefined || page.coverageStatus !== undefined) {
        scan = await setRecoveryScanCoverage(prisma, {
          organizationId: input.organizationId,
          scanId: input.scanId,
          coverageStart: page.coverageFrom ?? scan.coverageStart,
          coverageEnd: page.coverageTo ?? scan.coverageEnd,
          sourceCoverageStatus: page.coverageStatus ?? scan.sourceCoverageStatus as ScanCoverageStatus,
          ...lease(),
          now: now(),
        });
      }

      const ingested = await input.ingestPort.ingest({
        organizationId: input.organizationId,
        scanId: input.scanId,
        shard,
        records: page.records,
      });

      scan = await advanceRecoveryScanShard(prisma, {
        organizationId: input.organizationId,
        scanId: input.scanId,
        shardIndex: shard.index,
        shardKey: shard.key,
        cursor: page.nextCursor,
        pageCount: 1,
        recordsScanned: page.records.length,
        recordsAccepted: ingested.accepted,
        recordsRejected: ingested.rejected,
        opportunitiesFound: ingested.opportunitiesFound,
        eligibleFound: ingested.eligibleFound,
        expiredFound: ingested.expiredFound,
        needsEvidenceFound: ingested.needsEvidenceFound,
        ...lease(),
        now: now(),
      });

      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    if (blockedReason !== null) break;
  }

  const finished = blockedReason
    ? await finishRecoveryScan(prisma, {
        organizationId: input.organizationId,
        scanId: input.scanId,
        status: 'BLOCKED',
        reasonCodes: [blockedReason],
        ...lease(),
        now: now(),
      })
    : await finishRecoveryScan(prisma, {
        organizationId: input.organizationId,
        scanId: input.scanId,
        status: 'COMPLETED',
        ...lease(),
        now: now(),
      });

  return {
    status: finished.status,
    shardsCompleted: finished.shardsCompleted,
    shardsTotal: finished.shardsTotal,
    recordsScanned: finished.recordsScanned,
    blocked: blockedReason !== null,
    reasonCodes: (finished.reasonCodes as string[] | null) ?? [],
  };
}
