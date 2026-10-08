// HISTORICAL_RECOVERY_SCAN_V1 / PHASE 4 —— RecoveryWindowResolver（确定性，纯函数）
// ---------------------------------------------------------------------------
// requestedRange = 用户希望看的范围
// effectiveRange = min(用户 requested, 数据源可获得, 该领域适用规则允许)
//
// Customs 特例：**不得**用全球统一 3–5 年规则；只按真实 remedy-specific policy 判断，
//   且未 LEGAL_VERIFIED / 缺 jurisdiction / 缺 anchor → INDETERMINATE 并阻止 CLAIM_READY。

import { toScanDay, type ScanCoverageStatus } from './scan-identity';

export const RECOVERY_WINDOW_REASON_CODES = [
  'REQUESTED_RANGE_APPLIED',
  'SOURCE_HISTORY_LIMITED',
  'POLICY_WINDOW_SHORTER',
  'RULE_UNVERIFIED',
  'MISSING_JURISDICTION',
  'MISSING_ANCHOR',
  'FULL_COVERAGE',
  'PARTIAL_COVERAGE',
] as const;
export type RecoveryWindowReasonCode = (typeof RECOVERY_WINDOW_REASON_CODES)[number];

export interface RecoveryWindowPolicyWindow {
  readonly anchorField: string;
  readonly daysFromAnchor: number;
  readonly verified: boolean;
  readonly anchorDate: Date | string | null;
  readonly policyId?: string;
  readonly policyVersion?: string;
}

export interface RecoveryWindowInput {
  readonly domain: string;
  readonly requestedFrom: Date | string;
  readonly requestedTo: Date | string;
  readonly jurisdiction?: string | null;
  /** 数据源实际可获得区间（未知则传 null） */
  readonly sourceCoverageFrom?: Date | string | null;
  readonly sourceCoverageTo?: Date | string | null;
  /** 仅当该域有适用规则窗口时提供（例如 Customs remedy policy） */
  readonly policyWindow?: RecoveryWindowPolicyWindow | null;
}

export interface RecoveryWindowResult {
  readonly requestedFrom: string;
  readonly requestedTo: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string;
  readonly coverage: ScanCoverageStatus;
  readonly reasonCodes: readonly RecoveryWindowReasonCode[];
  /** true 时调用方**必须**阻止 CLAIM_READY（未核验 / 缺 jurisdiction / 缺 anchor） */
  readonly blocksClaimReady: boolean;
  readonly effectiveRangeClamped: boolean;
}

const MS_PER_DAY = 86_400_000;
const dayMs = (day: string) => Date.parse(day + 'T00:00:00.000Z');
const maxDay = (a: string, b: string) => (a >= b ? a : b);
const minDay = (a: string, b: string) => (a <= b ? a : b);

/**
 * 确定性窗口解析。任何不确定因素（未核验政策 / 缺 jurisdiction / 缺 anchor）→ 显式 reason code + 阻断 CLAIM_READY。
 */
export function resolveRecoveryWindow(input: RecoveryWindowInput): RecoveryWindowResult {
  const requestedFrom = toScanDay(input.requestedFrom);
  const requestedTo = toScanDay(input.requestedTo);
  if (requestedFrom > requestedTo) throw new Error('RECOVERY_WINDOW_RANGE_INVERTED');

  const reasons: RecoveryWindowReasonCode[] = ['REQUESTED_RANGE_APPLIED'];
  let effectiveFrom = requestedFrom;
  let effectiveTo = requestedTo;
  let blocksClaimReady = false;
  let coverage: ScanCoverageStatus = 'UNKNOWN';

  const domain = String(input.domain ?? '').toUpperCase();

  // 1) 数据源可获得范围
  const sourceFrom = input.sourceCoverageFrom ? toScanDay(input.sourceCoverageFrom) : null;
  const sourceTo = input.sourceCoverageTo ? toScanDay(input.sourceCoverageTo) : null;
  if (sourceFrom !== null && sourceTo !== null) {
    const clampedFrom = maxDay(effectiveFrom, sourceFrom);
    const clampedTo = minDay(effectiveTo, sourceTo);
    if (clampedFrom > clampedTo) {
      // 与请求区间完全不相交 → 无覆盖（不得伪称 FULL）
      coverage = 'SOURCE_LIMITED';
      reasons.push('SOURCE_HISTORY_LIMITED', 'PARTIAL_COVERAGE');
    } else {
      const narrowed = clampedFrom !== effectiveFrom || clampedTo !== effectiveTo;
      effectiveFrom = clampedFrom;
      effectiveTo = clampedTo;
      if (narrowed) {
        coverage = 'SOURCE_LIMITED';
        reasons.push('SOURCE_HISTORY_LIMITED', 'PARTIAL_COVERAGE');
      } else {
        coverage = 'FULL';
        reasons.push('FULL_COVERAGE');
      }
    }
  } else {
    coverage = 'UNKNOWN';
    reasons.push('PARTIAL_COVERAGE');
  }

  // 2) 领域规则窗口（Customs remedy-specific）
  const policy = input.policyWindow ?? null;
  if (domain === 'CUSTOMS') {
    if (!input.jurisdiction) {
      reasons.push('MISSING_JURISDICTION');
      blocksClaimReady = true;
    }
    if (!policy) {
      reasons.push('RULE_UNVERIFIED');
      blocksClaimReady = true;
    } else {
      if (!policy.verified) {
        reasons.push('RULE_UNVERIFIED');
        blocksClaimReady = true;
      }
      if (!policy.anchorDate) {
        reasons.push('MISSING_ANCHOR');
        blocksClaimReady = true;
      } else {
        const anchor = toScanDay(policy.anchorDate);
        const policyFrom = maxDay(anchor, requestedFrom);
        const policyDeadline = new Date(dayMs(anchor) + policy.daysFromAnchor * MS_PER_DAY).toISOString().slice(0, 10);
        const policyTo = minDay(requestedTo, policyDeadline);
        if (policyFrom > policyTo) {
          reasons.push('POLICY_WINDOW_SHORTER', 'PARTIAL_COVERAGE');
          blocksClaimReady = true;
        } else if (policyFrom !== effectiveFrom || policyTo !== effectiveTo) {
          effectiveFrom = maxDay(effectiveFrom, policyFrom);
          effectiveTo = minDay(effectiveTo, policyTo);
          reasons.push('POLICY_WINDOW_SHORTER');
        }
      }
    }
  } else if (policy) {
    if (!policy.verified) {
      reasons.push('RULE_UNVERIFIED');
      blocksClaimReady = true;
    }
    if (policy.anchorDate) {
      const anchor = toScanDay(policy.anchorDate);
      const policyDeadline = new Date(dayMs(anchor) + policy.daysFromAnchor * MS_PER_DAY).toISOString().slice(0, 10);
      const narrowedFrom = maxDay(effectiveFrom, anchor);
      const narrowedTo = minDay(effectiveTo, policyDeadline);
      if (narrowedFrom <= narrowedTo && (narrowedFrom !== effectiveFrom || narrowedTo !== effectiveTo)) {
        effectiveFrom = narrowedFrom;
        effectiveTo = narrowedTo;
        reasons.push('POLICY_WINDOW_SHORTER');
      }
    }
  }

  const effectiveRangeClamped = effectiveFrom !== requestedFrom || effectiveTo !== requestedTo;
  return {
    requestedFrom,
    requestedTo,
    effectiveFrom,
    effectiveTo,
    coverage,
    reasonCodes: [...new Set(reasons)],
    blocksClaimReady,
    effectiveRangeClamped,
  };
}
