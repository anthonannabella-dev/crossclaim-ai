// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 2 —— 确定性 scan 身份
// ---------------------------------------------------------------------------
// 设计约束（HOST）：
//   * scan 身份必须**确定性**：同 goal + domain + provider + account + 区间 + policy → 同 dedupeKey / scanDigest；
//   * **不得**包含 transient timestamp（否则每次运行都会生成第二个 scan）；
//   * 身份一旦创建不可改写（DB 侧有 cc_recovery_scan_identity__* 触发器）。

import { digestOf } from '../config-execution-durability/digests';

export const RECOVERY_SCAN_POLICY_VERSION = 'historical-recovery-scan/v1';

export const SCAN_STATUSES = ['CREATED', 'RUNNING', 'PARTIAL', 'BLOCKED', 'COMPLETED', 'FAILED'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const SCAN_TERMINAL_STATUSES: readonly ScanStatus[] = ['COMPLETED', 'BLOCKED', 'FAILED'];

export const SCAN_COVERAGE_STATUSES = ['FULL', 'PARTIAL', 'SOURCE_LIMITED', 'UNKNOWN'] as const;
export type ScanCoverageStatus = (typeof SCAN_COVERAGE_STATUSES)[number];

export const SHARD_GRAINS = ['MONTHLY', 'QUARTERLY'] as const;
export type ShardGrain = (typeof SHARD_GRAINS)[number];

/** 日期口径统一到 UTC 日（避免时刻导致的身份抖动） */
export function toScanDay(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('RECOVERY_SCAN_INVALID_DATE: ' + String(value));
  return date.toISOString().slice(0, 10);
}

export interface RecoveryScanIdentityInput {
  readonly goalDigest: string;
  readonly domain: string;
  readonly provider?: string | null;
  readonly platformAccountId?: string | null;
  readonly effectiveFrom: Date | string;
  readonly effectiveTo: Date | string;
  readonly requestedMonths: number;
  readonly scanPolicyVersion?: string;
}

export interface RecoveryScanIdentity {
  readonly scanPolicyVersion: string;
  readonly scanDigest: string;
  readonly dedupeKey: string;
  readonly scope: {
    readonly goalDigest: string;
    readonly domain: string;
    readonly provider: string | null;
    readonly platformAccountId: string | null;
    readonly effectiveFrom: string;
    readonly effectiveTo: string;
    readonly requestedMonths: number;
  };
}

/** 构造 scan 身份。**纯函数**：同样输入永远得到同样 dedupeKey / scanDigest。 */
export function buildRecoveryScanIdentity(input: RecoveryScanIdentityInput): RecoveryScanIdentity {
  const goalDigest = String(input.goalDigest ?? '').trim();
  if (goalDigest === '') throw new Error('RECOVERY_SCAN_GOAL_DIGEST_REQUIRED');
  const months = Math.trunc(Number(input.requestedMonths));
  if (!Number.isFinite(months) || months < 1) throw new Error('RECOVERY_SCAN_INVALID_MONTHS');

  const scope = {
    goalDigest,
    domain: String(input.domain ?? '').toUpperCase(),
    provider: input.provider ? String(input.provider).toUpperCase() : null,
    platformAccountId: input.platformAccountId ? String(input.platformAccountId) : null,
    effectiveFrom: toScanDay(input.effectiveFrom),
    effectiveTo: toScanDay(input.effectiveTo),
    requestedMonths: months,
  };
  const scanPolicyVersion = input.scanPolicyVersion ?? RECOVERY_SCAN_POLICY_VERSION;
  const scanDigest = digestOf({ version: scanPolicyVersion, ...scope });
  const dedupeKey = [
    'scan',
    'v1',
    goalDigest.slice(0, 16),
    scope.domain,
    scope.provider ?? '-',
    scope.platformAccountId ?? '-',
    scope.effectiveFrom,
    scope.effectiveTo,
    String(scope.requestedMonths),
  ].join(':');

  return { scanPolicyVersion, scanDigest, dedupeKey, scope };
}

/** 校验持久化 scan 的 digest 是否与身份字段一致（篡改检测 → fail-closed） */
export function verifyRecoveryScanDigest(row: {
  goalDigest: string;
  domain: string;
  provider: string | null;
  platformAccountId: string | null;
  effectiveFrom: Date | string;
  effectiveTo: Date | string;
  requestedMonths: number;
  scanPolicyVersion: string;
  scanDigest: string;
}): boolean {
  const expected = buildRecoveryScanIdentity({
    goalDigest: row.goalDigest,
    domain: row.domain,
    provider: row.provider,
    platformAccountId: row.platformAccountId,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    requestedMonths: row.requestedMonths,
    scanPolicyVersion: row.scanPolicyVersion,
  });
  return expected.scanDigest === row.scanDigest;
}
