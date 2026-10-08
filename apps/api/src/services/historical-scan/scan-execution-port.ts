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
import {
  claimRecoveryScanRun,
  loadRecoveryScanById,
  reclaimRecoveryScanLease,
  RecoveryScanError,
} from './scan-store';

export interface HistoricalScanExecutionRequest {
  readonly organizationId: string;
  /** runtime 认领到的 task identity（`task:recovery:<DOMAIN>:scan:v1:...`） */
  readonly taskKey: string;
  readonly pagePort: BackfillPagePort;
  readonly ingestPort: BackfillIngestPort;
  /**
   * AUDIT-3 CHANGE 2：调用方（runtime worker）自己的 **durable 执行身份**。
   * 端口不会「凭空推进」：必须先 claim（CREATED）或接管过期租约（RUNNING + 过期），
   * 或已持有未过期租约；否则 BLOCKED。checkpoint/coverage/finish 写入均以该 owner 做条件更新（fencing）。
   */
  readonly ownerRef: string;
  /** 租约时长（毫秒）；缺省 60s */
  readonly leaseMs?: number;
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
      const blocked = (scanId: string | null, reasonCodes: readonly string[]): HistoricalScanExecutionOutcome => ({
        ok: false,
        scanId,
        status: 'BLOCKED',
        blocked: true,
        shardsCompleted: 0,
        recordsScanned: 0,
        reasonCodes,
      });
      if (typeof request.ownerRef !== 'string' || request.ownerRef.trim() === '') {
        return blocked(null, ['RECOVERY_SCAN_OWNER_REQUIRED']);
      }
      const scope = await loadScanScopeForClaimedTask(prisma, {
        organizationId: request.organizationId,
        dedupeKey: request.taskKey,
      });
      if (!scope.ok) {
        return blocked(null, scope.reasonCodes);
      }

      const organizationId = request.organizationId;
      const scanId = scope.scope.scanId;
      const current = await loadRecoveryScanById(prisma, { organizationId, scanId });
      if (current === null) return blocked(scanId, ['RECOVERY_SCAN_NOT_FOUND']);

      const now = request.now?.() ?? new Date();
      const leaseExpiresAt = new Date(now.getTime() + (request.leaseMs ?? 60_000));
      const ownerRef = request.ownerRef;
      if (current.status === 'CREATED') {
        const claimed = await claimRecoveryScanRun(prisma, {
          organizationId,
          scanId,
          leaseOwner: ownerRef,
          leaseExpiresAt,
          now,
        });
        if (claimed === null) return blocked(scanId, ['RECOVERY_SCAN_CLAIM_RACE']);
      } else if (current.status === 'RUNNING') {
        const heldBySelf =
          current.leaseOwner === ownerRef &&
          (current.leaseExpiresAt === null || current.leaseExpiresAt.getTime() > now.getTime());
        const expired = current.leaseExpiresAt !== null && current.leaseExpiresAt.getTime() <= now.getTime();
        if (!heldBySelf) {
          if (!expired) return blocked(scanId, ['RECOVERY_SCAN_LEASE_NOT_HELD']);
          const reclaimed = await reclaimRecoveryScanLease(prisma, {
            organizationId,
            scanId,
            leaseOwner: ownerRef,
            leaseExpiresAt,
            now,
          });
          if (reclaimed === null) return blocked(scanId, ['RECOVERY_SCAN_LEASE_RECLAIM_FAILED']);
        }
      } else {
        return blocked(scanId, ['RECOVERY_SCAN_NOT_RUNNABLE']);
      }

      let result;
      try {
        result = await runHistoricalBackfill(prisma, {
          organizationId,
          scanId,
          pagePort: request.pagePort,
          ingestPort: request.ingestPort,
          expectedLeaseOwner: ownerRef,
          ...(request.grain === undefined ? {} : { grain: request.grain }),
          ...(request.maxPages === undefined ? {} : { maxPages: request.maxPages }),
          ...(request.now === undefined ? {} : { now: request.now }),
        });
      } catch (error) {
        if (error instanceof RecoveryScanError && error.code === 'RECOVERY_SCAN_LEASE_FENCED') {
          return blocked(scanId, ['RECOVERY_SCAN_LEASE_FENCED']);
        }
        throw error;
      }

      return {
        ok: result.status === 'COMPLETED',
        scanId,
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
  /** AUDIT-3 CHANGE 2：执行资格必须由 durable 租约证明；写入以 owner 做条件更新（fencing） */
  requiresDurableOwnership: true,
  claimsOrReclaimsBeforeBackfill: true,
  fencingOnCheckpointWrites: true,
  writesOnlyScanScopeAndCheckpoint: true,
  externalWritePerformed: false,
} as const;
