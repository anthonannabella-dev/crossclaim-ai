// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 6 —— Historical Backfill Executor
// ---------------------------------------------------------------------------
// 约束：
//   * **不新建第二 Runtime**：本执行器是既有 ONE SI Runtime 认领之后被调用的**领域步骤**，
//     不做调度、不做 lease 竞争之外的并发控制、不直接调用 runner；
//   * 分片执行：MONTHLY/QUARTERLY，逐 shard → 逐 page；每个 page 处理完才推进 durable checkpoint；
//   * crash resume：下次调用从 `nextShardIndex` + `shardCursor` 继续；
//   * 幂等：同一 page 重放不得产生重复业务结果 —— 由 ingest 端口保证（既有 fingerprint 去重链）。

import type { PrismaClient, RecoveryScanRun } from '@prisma/client';

import { advanceRecoveryScanShard, finishRecoveryScan, loadRecoveryScanById, setRecoveryScanCoverage } from './scan-store';
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
    readonly now?: () => Date;
  },
): Promise<BackfillRunResult> {
  const now = input.now ?? (() => new Date());
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

  const shards = planScanShards({ from: scan.effectiveFrom, to: scan.effectiveTo, grain: input.grain });
  if (scan.shardsTotal !== shards.length) {
    scan = await prisma.recoveryScanRun.update({
      where: { organizationId_id: { organizationId: input.organizationId, id: input.scanId } },
      data: { shardsTotal: shards.length, updatedAt: now() },
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
        now: now(),
      })
    : await finishRecoveryScan(prisma, {
        organizationId: input.organizationId,
        scanId: input.scanId,
        status: 'COMPLETED',
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
