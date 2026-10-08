// HISTORICAL_RECOVERY_SCAN_V1 / AUDIT-2R CHANGE —— historical scan execution port
// ---------------------------------------------------------------------------
// 评审约束（MSG-20261008-05）：
//   * **不得**把 `runHistoricalBackfill()` 塞进已封板的 read-only Recovery SI pack
//     （那会破坏 `writesDatabase=false` / `executesActions=false`）；
//   * 正确做法：在**既有 ONE SI Runtime 下**新增一个 execution port / domain step，
//     由 server-owned composition 在「runtime 认领了扫描任务」之后显式调用；
//   * 仍不创建新 scheduler / runtime；范围只来自 durable scan（不接受 caller 自报）。

import type { PrismaClient } from '@prisma/client';

import { runHistoricalBackfill, type BackfillIngestPort, type BackfillPagePort } from './backfill-executor';
import { loadScanScopeForClaimedTask } from './scan-scope-loader';

export interface HistoricalScanExecutionRequest {
  readonly organizationId: string;
  /** runtime 认领到的 task identity（`task:recovery:<DOMAIN>:scan:v1:...`） */
  readonly taskKey: string;
  readonly pagePort: BackfillPagePort;
  readonly ingestPort: BackfillIngestPort;
  readonly grain?: 'MONTHLY' | 'QUARTERLY';
  readonly maxPages?: number;
  readonly now?: () => Date;
}

export interface HistoricalScanExecutionOutcome {
  readonly ok: boolean;
  readonly scanId: string | null;
  readonly status: string;
  readonly blocked: boolean;
  readonly shardsCompleted: number;
  readonly recordsScanned: number;
  readonly reasonCodes: readonly string[];
}

export interface HistoricalScanExecutionPort {
  run(request: HistoricalScanExecutionRequest): Promise<HistoricalScanExecutionOutcome>;
}

/**
 * 创建 execution port（server-owned）。调用方只能是既有 runtime composition —— 它先把
 * durable scope 装载（fail-closed）再驱动既有 backfill；任何 tenant / 身份 / 任务类型不符一律 BLOCK。
 */
export function createHistoricalScanExecutionPort(prisma: PrismaClient): HistoricalScanExecutionPort {
  return {
    async run(request: HistoricalScanExecutionRequest): Promise<HistoricalScanExecutionOutcome> {
      const scope = await loadScanScopeForClaimedTask(prisma, {
        organizationId: request.organizationId,
        dedupeKey: request.taskKey,
      });
      if (!scope.ok) {
        return {
          ok: false,
          scanId: null,
          status: 'BLOCKED',
          blocked: true,
          shardsCompleted: 0,
          recordsScanned: 0,
          reasonCodes: scope.reasonCodes,
        };
      }

      const result = await runHistoricalBackfill(prisma, {
        organizationId: request.organizationId,
        scanId: scope.scope.scanId,
        pagePort: request.pagePort,
        ingestPort: request.ingestPort,
        ...(request.grain === undefined ? {} : { grain: request.grain }),
        ...(request.maxPages === undefined ? {} : { maxPages: request.maxPages }),
        ...(request.now === undefined ? {} : { now: request.now }),
      });

      return {
        ok: result.status === 'COMPLETED',
        scanId: scope.scope.scanId,
        status: result.status,
        blocked: result.blocked,
        shardsCompleted: result.shardsCompleted,
        recordsScanned: result.recordsScanned,
        reasonCodes: result.reasonCodes,
      };
    },
  };
}

export const HISTORICAL_SCAN_EXECUTION_PORT_BOUNDARY = {
  secondRuntime: false,
  secondScheduler: false,
  insideExistingOneSiRuntime: true,
  readOnlyPackUntouched: true,
  scopeFromDurableScanOnly: true,
  writesOnlyScanScopeAndCheckpoint: true,
  externalWritePerformed: false,
} as const;
