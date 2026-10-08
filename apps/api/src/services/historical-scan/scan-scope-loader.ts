// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 3 —— Runtime 侧 durable scan scope 装载
// ---------------------------------------------------------------------------
// 约束（HOST）：
//   * Runtime **不得**接受 caller 自报的 from / to / months / domain / account / provider；
//   * Runtime 必须按 server-owned deterministic scan identity（dedupeKey）从 durable `RecoveryScanRun`
//     重新加载范围与检查点；
//   * tenant mismatch / account mismatch / missing scan / digest mismatch → **BLOCK**；
//   * `RsiSafeTask` 保持最小（只带 dedupeKey 等），复杂 historical payload 不得塞进 task；
//   * 不调用 runner、不绕过 claim / lease / park-for-judge / reserved namespace。

import type { PrismaClient, RecoveryScanRun } from '@prisma/client';

import { loadRecoveryScanScope } from './scan-store';
import { toScanDay, verifyRecoveryScanDigest, type ScanCoverageStatus, type ScanStatus } from './scan-identity';

/** 历史扫描任务在既有保留命名空间下的稳定前缀（task draft 由 planner 生成，caller 不得自定义） */
export const RECOVERY_SCAN_TASK_PREFIX = 'task:recovery:';

export interface ClaimedScanTaskRef {
  readonly organizationId: string;
  /** 既有 task identity（最小字段）；scan 身份由它确定性映射到 durable scan */
  readonly dedupeKey: string;
  /** 可选：caller 声称的账户只用于**比对**，不作为范围来源 */
  readonly assertedPlatformAccountId?: string | null;
  /** 可选：caller 若自报范围，必须被忽略并记录（见 callerScopeAsserted） */
  readonly assertedRange?: { from?: string; to?: string; months?: number } | null;
}

export interface LoadedScanScope {
  readonly scanId: string;
  readonly organizationId: string;
  readonly goalId: string;
  readonly domain: string;
  readonly provider: string | null;
  readonly platformAccountId: string | null;
  readonly requestedFrom: string;
  readonly requestedTo: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string;
  readonly requestedMonths: number;
  readonly scanPolicyVersion: string;
  readonly scanDigest: string;
  readonly status: ScanStatus;
  readonly coverage: ScanCoverageStatus;
  readonly checkpoint: {
    readonly shardsTotal: number;
    readonly shardsCompleted: number;
    readonly nextShardIndex: number;
    readonly shardCursor: string | null;
  };
  /** 恒为 false：范围永远来自 durable 行，不来自 caller */
  readonly callerRangeTrusted: false;
}

export type ScanScopeLoadResult =
  | { readonly ok: true; readonly scope: LoadedScanScope; readonly reasonCodes: readonly string[] }
  | { readonly ok: false; readonly block: true; readonly reasonCodes: readonly string[] };

/** 该 task 是否属于历史扫描（只有扫描任务才需要装载 durable scope） */
export function isRecoveryScanTask(dedupeKey: string): boolean {
  return typeof dedupeKey === 'string' && dedupeKey.includes('scan:v1:');
}

function toScope(row: RecoveryScanRun): LoadedScanScope {
  return {
    scanId: row.id,
    organizationId: row.organizationId,
    goalId: row.goalId,
    domain: row.domain,
    provider: row.provider,
    platformAccountId: row.platformAccountId,
    requestedFrom: toScanDay(row.requestedFrom),
    requestedTo: toScanDay(row.requestedTo),
    effectiveFrom: toScanDay(row.effectiveFrom),
    effectiveTo: toScanDay(row.effectiveTo),
    requestedMonths: row.requestedMonths,
    scanPolicyVersion: row.scanPolicyVersion,
    scanDigest: row.scanDigest,
    status: row.status as ScanStatus,
    coverage: row.sourceCoverageStatus as ScanCoverageStatus,
    checkpoint: {
      shardsTotal: row.shardsTotal,
      shardsCompleted: row.shardsCompleted,
      nextShardIndex: row.nextShardIndex,
      shardCursor: row.shardCursor,
    },
    callerRangeTrusted: false,
  };
}

/**
 * 从 durable scan 装载 scope。任何不确定都 **BLOCK**（fail-closed），绝不回落到 caller 自报范围。
 */
export async function loadScanScopeForClaimedTask(
  prisma: PrismaClient,
  ref: ClaimedScanTaskRef,
): Promise<ScanScopeLoadResult> {
  const reasonCodes: string[] = [];

  // caller 自报范围只允许"被忽略"，并显式记录（绝不采用）
  if (ref.assertedRange && (ref.assertedRange.from || ref.assertedRange.to || ref.assertedRange.months)) {
    reasonCodes.push('CALLER_RANGE_IGNORED_NOT_TRUSTED');
  }

  if (typeof ref.organizationId !== 'string' || ref.organizationId.trim() === '') {
    return { ok: false, block: true, reasonCodes: [...reasonCodes, 'RECOVERY_SCAN_TENANT_CONTEXT_REQUIRED'] };
  }
  if (!isRecoveryScanTask(ref.dedupeKey)) {
    return { ok: false, block: true, reasonCodes: [...reasonCodes, 'NOT_A_HISTORICAL_SCAN_TASK'] };
  }

  let row: RecoveryScanRun | null;
  try {
    row = await loadRecoveryScanScope(prisma, {
      organizationId: ref.organizationId,
      dedupeKey: ref.dedupeKey,
    });
  } catch {
    // digest 不一致等 → 一律 BLOCK（不泄露细节、不回落到 caller 范围）
    return { ok: false, block: true, reasonCodes: [...reasonCodes, 'RECOVERY_SCAN_DIGEST_MISMATCH'] };
  }

  // 组织维度不匹配（含跨租户）：org-scoped 查询返回 null
  if (!row) {
    return { ok: false, block: true, reasonCodes: [...reasonCodes, 'RECOVERY_SCAN_MISSING_OR_TENANT_MISMATCH'] };
  }
  if (row.organizationId !== ref.organizationId) {
    return { ok: false, block: true, reasonCodes: [...reasonCodes, 'RECOVERY_SCAN_TENANT_MISMATCH'] };
  }
  if (!verifyRecoveryScanDigest(row)) {
    return { ok: false, block: true, reasonCodes: [...reasonCodes, 'RECOVERY_SCAN_DIGEST_MISMATCH'] };
  }

  // 账户维度：caller 的断言只用于比对，不作范围来源
  const asserted = ref.assertedPlatformAccountId ?? null;
  if (asserted !== null && asserted !== row.platformAccountId) {
    return { ok: false, block: true, reasonCodes: [...reasonCodes, 'RECOVERY_SCAN_ACCOUNT_MISMATCH'] };
  }

  return { ok: true, scope: toScope(row), reasonCodes };
}

/**
 * 断言 Runtime **只**使用 server-owned scope：若调用方试图用 task payload 覆盖范围字段 → BLOCK。
 * （用于把「不得让 task payload 成为第二事实源」写成可测的运行时约束。）
 */
export function assertScopeNotCallerOwned(payload: Record<string, unknown> | null | undefined): {
  readonly ok: boolean;
  readonly reasonCodes: readonly string[];
} {
  if (!payload) return { ok: true, reasonCodes: [] };
  const forbidden = ['from', 'to', 'months', 'requestedFrom', 'requestedTo', 'effectiveFrom', 'effectiveTo', 'timeRange'];
  const offenders = forbidden.filter((key) => Object.prototype.hasOwnProperty.call(payload, key));
  if (offenders.length > 0) {
    return { ok: false, reasonCodes: ['TASK_PAYLOAD_SCOPE_FORBIDDEN:' + offenders.join(',')] };
  }
  return { ok: true, reasonCodes: [] };
}
