// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 9 —— customer-safe scan summary（纯函数）
// ---------------------------------------------------------------------------
// 禁止：跨币种求和 / 未覆盖完整区间却显示「检查完成」/ 把 estimate 写成 recovered /
//       把 CLAIM_READY 写成 filed / 把 opportunity 写成 money recovered。
// 本模块只做**只读投影**，不产生任何事实、不改变执行能力。

import type { RecoveryScanRun } from '@prisma/client';

import { toScanDay, type ScanCoverageStatus, type ScanStatus } from './scan-identity';

export interface ScanSummaryView {
  readonly scanId: string;
  readonly status: ScanStatus;
  readonly requestedFrom: string;
  readonly requestedTo: string;
  readonly requestedMonths: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string;
  readonly coverageFrom: string | null;
  readonly coverageTo: string | null;
  readonly coverage: ScanCoverageStatus;
  readonly effectiveRangeClamped: boolean;
  readonly shardsTotal: number;
  readonly shardsCompleted: number;
  readonly recordsScanned: number;
  readonly opportunitiesFound: number;
  readonly eligibleFound: number;
  readonly needsEvidenceFound: number;
  readonly expiredFound: number;
  readonly completedAt: string | null;
  /** 诚实边界：本单元只到 CLAIM_READY / discovery，以下恒为 0 / false */
  readonly claimReadyPrepared: number;
  readonly claimsFiled: 0;
  readonly externalActionPerformed: false;
  readonly externalWritePerformed: false;
  readonly filingPerformed: false;
  readonly paymentPerformed: false;
  readonly disclaimerCodes: readonly string[];
}

export function buildScanSummaryView(row: RecoveryScanRun): ScanSummaryView {
  const coverage = row.sourceCoverageStatus as ScanCoverageStatus;
  const status = row.status as ScanStatus;
  const clamped =
    toScanDay(row.effectiveFrom) !== toScanDay(row.requestedFrom) ||
    toScanDay(row.effectiveTo) !== toScanDay(row.requestedTo);

  const disclaimerCodes: string[] = ['SCAN_IS_DISCOVERY_NOT_FILING'];
  if (coverage !== 'FULL') disclaimerCodes.push('COVERAGE_NOT_FULL');
  if (clamped) disclaimerCodes.push('EFFECTIVE_RANGE_NARROWER_THAN_REQUESTED');
  if (status !== 'COMPLETED') disclaimerCodes.push('SCAN_NOT_COMPLETED');

  return {
    scanId: row.id,
    status,
    requestedFrom: toScanDay(row.requestedFrom),
    requestedTo: toScanDay(row.requestedTo),
    requestedMonths: row.requestedMonths,
    effectiveFrom: toScanDay(row.effectiveFrom),
    effectiveTo: toScanDay(row.effectiveTo),
    coverageFrom: row.coverageStart ? toScanDay(row.coverageStart) : null,
    coverageTo: row.coverageEnd ? toScanDay(row.coverageEnd) : null,
    coverage,
    effectiveRangeClamped: clamped,
    shardsTotal: row.shardsTotal,
    shardsCompleted: row.shardsCompleted,
    recordsScanned: row.recordsScanned,
    opportunitiesFound: row.opportunitiesFound,
    eligibleFound: row.eligibleFound,
    needsEvidenceFound: row.needsEvidenceFound,
    expiredFound: row.expiredFound,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    claimReadyPrepared: row.eligibleFound,
    claimsFiled: 0,
    externalActionPerformed: false,
    externalWritePerformed: false,
    filingPerformed: false,
    paymentPerformed: false,
    disclaimerCodes,
  };
}

/** 只有「请求区间内被数据源完整覆盖」才允许对外表述为完整覆盖。 */
export function scanCoverageIsFull(summary: ScanSummaryView): boolean {
  return (
    summary.coverage === 'FULL' &&
    summary.coverageFrom !== null &&
    summary.coverageTo !== null &&
    summary.coverageFrom <= summary.requestedFrom &&
    summary.coverageTo >= summary.requestedTo
  );
}
