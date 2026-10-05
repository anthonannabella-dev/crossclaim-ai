/**
 * PHASE 4 U4 —— Offline Evaluation（显式 resolved denominator）
 * ---------------------------------------------------------------
 * 依据审计 NEXT（MSG-20261005-61）：
 *   - 必须显式定义正式评估分母：resolved = SUCCESS + FAILURE + REJECTED；
 *   - PARTIAL / MANUAL_REVIEW / UNKNOWN **单独报告**，不得默认进入 success-rate 分母；
 *   - 不得继续把 `successCount / allRecords` 当作正式质量指标；
 *   - 评估只消费 U3 的 **verified-only** 学习证据/记录；未过 trusted lineage binding 的记录不得进入评估。
 *
 * 硬约束：
 *   - 纯离线、确定性、**无网络**（REAL_MODEL_NETWORK / PAID_MODEL_CALLS = HOLD）；
 *   - 只读投影，不写任何存储，不建立第二 Meta Evidence Store；
 *   - 只观察：不修改 Policy / Guard / Router / Action Runtime；AUTO_PROMOTION = OFF；
 *   - 分母为 0 时返回 `null`（defined = false），不返回 0 或 NaN 冒充“成功率”。
 */

import { createHash } from 'node:crypto';

import { buildVerifiedLearningProjection } from './learning-evidence';
import { isAppOutcomeLineageLedger, type OutcomeLineageLedgerPort } from './outcome-lineage';
import { FINAL_OUTCOMES, type OutcomeRecord } from './outcome-record';

export const OFFLINE_EVALUATION_VERSION = 'offline-evaluation/v1';

/** 正式分母口径：只有这三类算“已判定结果”。 */
export const RESOLVED_OUTCOMES = ['SUCCESS', 'FAILURE', 'REJECTED'] as const;
/** 未判定：单独报告，不进入 success-rate 分母。 */
export const UNRESOLVED_OUTCOMES = ['PARTIAL', 'MANUAL_REVIEW', 'UNKNOWN'] as const;

export type ResolvedOutcome = (typeof RESOLVED_OUTCOMES)[number];
export type UnresolvedOutcome = (typeof UNRESOLVED_OUTCOMES)[number];

export const OFFLINE_EVALUATION_BOUNDARY = {
  observationOnly: true,
  offline: true,
  network: 'FORBIDDEN',
  realModelCalls: 'FORBIDDEN',
  autoPolicyMutation: 'FORBIDDEN',
  autoPromotion: 'OFF',
  successRateDenominator: 'RESOLVED_ONLY',
  resolvedDenominator: 'SUCCESS + FAILURE + REJECTED',
  unresolvedHandling: 'REPORTED_SEPARATELY',
  unresolvedInSuccessRateDenominator: 'FORBIDDEN',
  forbiddenMetric: 'successCount / allRecords（禁止作为正式质量指标）',
  zeroDenominator: 'NULL_NOT_ZERO（分母为 0 时 successRate = null，不伪造成 0）',
  verifiedOnly: true,
  secondMetaEvidenceStore: 'FORBIDDEN',
  productionWrite: 'HOLD',
} as const;

/** 正式指标口径（可被审计逐条核对）。 */
export const OFFLINE_METRIC_DEFINITIONS = [
  {
    key: 'resolvedDenominator',
    definition: 'SUCCESS + FAILURE + REJECTED 的计数',
    denominator: 'RESOLVED',
  },
  {
    key: 'successRate',
    definition: 'successCount / resolvedDenominator',
    denominator: 'RESOLVED（分母为 0 → null）',
  },
  {
    key: 'failureRate',
    definition: 'failureCount / resolvedDenominator（FAILURE + REJECTED）',
    denominator: 'RESOLVED（分母为 0 → null）',
  },
  {
    key: 'unresolvedShareOfAllRecords',
    definition: 'unresolvedCount / totalRecords（仅报告，不参与 success-rate 分母）',
    denominator: 'ALL_RECORDS',
  },
] as const;

/** 禁止作为正式指标的键（保留在契约里，便于审计核对未实现）。 */
export const OFFLINE_FORBIDDEN_METRIC_KEYS = ['successRateOverAllRecords', 'overallSuccessRate', 'successCountOverAllRecords'] as const;

export interface OfflineEvaluationOptions {
  datasetVersion?: string;
  /** U2/U3 路径中未通过 trusted binding 而被排除的记录（仅如实登记，不参与任何分母）。 */
  excluded?: ReadonlyArray<{ digest: string; reason: string }>;
}

export interface ResolvedBreakdown {
  denominatorKind: 'RESOLVED';
  denominator: number;
  defined: boolean;
  byOutcome: Record<ResolvedOutcome, number>;
  successCount: number;
  failureCount: number;
  rejectedCount: number;
  successRate: number | null;
  failureRate: number | null;
  rejectedRate: number | null;
}

export interface UnresolvedBreakdown {
  count: number;
  excludedFromSuccessRate: true;
  byOutcome: Record<UnresolvedOutcome, number>;
}

export interface OfflineEvaluationResult {
  evaluationVersion: string;
  datasetVersion: string;
  totalRecords: number;
  resolved: ResolvedBreakdown;
  unresolved: UnresolvedBreakdown;
  unresolvedShareOfAllRecords: number | null;
  /** 分母为 0 时为 true：此时任何“成功率”都不可报告。 */
  insufficientData: boolean;
  context: {
    humanInterventionCount: number;
    byEvidenceQuality: Record<string, number>;
    byDomain: Record<string, number>;
  };
  excludedCount: number;
  excluded: ReadonlyArray<{ digest: string; reason: string }>;
  evaluationDigest: string;
}

const bump = (map: Record<string, number>, key: string): void => {
  map[key] = (map[key] ?? 0) + 1;
};

const zeroResolved = (): Record<ResolvedOutcome, number> => ({ SUCCESS: 0, FAILURE: 0, REJECTED: 0 });
const zeroUnresolved = (): Record<UnresolvedOutcome, number> => ({ PARTIAL: 0, MANUAL_REVIEW: 0, UNKNOWN: 0 });

/**
 * 离线评估（纯函数、确定性）。
 * 只接受 canonical OutcomeRecord（且调用方应按 verified-only 口径传入）；
 * 任何未知 finalOutcome / 空 datasetVersion / 非数组输入 → fail-closed。
 */
export function evaluateOfflineOutcomes(
  records: readonly OutcomeRecord[] | null | undefined,
  options: OfflineEvaluationOptions = {},
): OfflineEvaluationResult {
  if (!Array.isArray(records)) {
    throw new Error('OFFLINE_EVALUATION_RECORDS_REQUIRED');
  }
  const datasetVersion = options.datasetVersion ?? 'learning-dataset/v1';
  if (typeof datasetVersion !== 'string' || datasetVersion.trim() === '') {
    throw new Error('OFFLINE_EVALUATION_DATASET_VERSION_REQUIRED');
  }
  const excluded = Array.isArray(options.excluded) ? options.excluded : [];

  const byOutcome = zeroResolved();
  const unresolvedByOutcome = zeroUnresolved();
  const byEvidenceQuality: Record<string, number> = {};
  const byDomain: Record<string, number> = {};
  let humanInterventionCount = 0;

  for (const record of records) {
    const finalOutcome = record?.finalOutcome;
    if (!FINAL_OUTCOMES.includes(finalOutcome)) {
      throw new Error('OFFLINE_EVALUATION_UNKNOWN_FINAL_OUTCOME:' + String(finalOutcome));
    }
    if (RESOLVED_OUTCOMES.includes(finalOutcome as ResolvedOutcome)) {
      byOutcome[finalOutcome as ResolvedOutcome] += 1;
    } else {
      unresolvedByOutcome[finalOutcome as UnresolvedOutcome] += 1;
    }
    bump(byEvidenceQuality, record.evidenceQuality);
    bump(byDomain, record.domain);
    if (record.humanIntervention === true) humanInterventionCount += 1;
  }

  const successCount = byOutcome.SUCCESS;
  const failureCount = byOutcome.FAILURE + byOutcome.REJECTED;
  const denominator = successCount + failureCount;
  const unresolvedCount = unresolvedByOutcome.PARTIAL + unresolvedByOutcome.MANUAL_REVIEW + unresolvedByOutcome.UNKNOWN;
  const totalRecords = records.length;
  const defined = denominator > 0;

  const result: OfflineEvaluationResult = {
    evaluationVersion: OFFLINE_EVALUATION_VERSION,
    datasetVersion,
    totalRecords,
    resolved: {
      denominatorKind: 'RESOLVED',
      denominator,
      defined,
      byOutcome,
      successCount,
      failureCount,
      rejectedCount: byOutcome.REJECTED,
      successRate: defined ? successCount / denominator : null,
      failureRate: defined ? failureCount / denominator : null,
      rejectedRate: defined ? byOutcome.REJECTED / denominator : null,
    },
    unresolved: {
      count: unresolvedCount,
      excludedFromSuccessRate: true,
      byOutcome: unresolvedByOutcome,
    },
    unresolvedShareOfAllRecords: totalRecords === 0 ? null : unresolvedCount / totalRecords,
    insufficientData: denominator === 0,
    context: { humanInterventionCount, byEvidenceQuality, byDomain },
    excludedCount: excluded.length,
    excluded: [...excluded],
    evaluationDigest: '',
  };

  const preimage = [
    OFFLINE_EVALUATION_VERSION,
    datasetVersion,
    String(totalRecords),
    String(successCount),
    String(byOutcome.FAILURE),
    String(byOutcome.REJECTED),
    String(unresolvedByOutcome.PARTIAL),
    String(unresolvedByOutcome.MANUAL_REVIEW),
    String(unresolvedByOutcome.UNKNOWN),
    String(excluded.length),
  ].join('|');
  result.evaluationDigest = 'offline-eval:' + createHash('sha256').update(preimage).digest('hex').slice(0, 16);
  return result;
}

/**
 * verified-only 评估入口：先做 U2 trusted lineage binding（U3 学习路径），
 * 只有通过 binding 的记录进入评估；排除项如实登记。
 * lineage ledger 缺失或 provenance 不可信 → fail-closed（不评估、不返回 0 分母结果）。
 */
export async function evaluateVerifiedLearningRecords(
  lineageLedger: OutcomeLineageLedgerPort | null | undefined,
  records: readonly OutcomeRecord[] | null | undefined,
  options: OfflineEvaluationOptions = {},
): Promise<OfflineEvaluationResult> {
  if (lineageLedger === null || lineageLedger === undefined) {
    throw new Error('OFFLINE_EVALUATION_LINEAGE_LEDGER_REQUIRED');
  }
  if (!isAppOutcomeLineageLedger(lineageLedger)) {
    throw new Error('OFFLINE_EVALUATION_LINEAGE_LEDGER_NOT_TRUSTED');
  }
  if (!Array.isArray(records)) {
    throw new Error('OFFLINE_EVALUATION_RECORDS_REQUIRED');
  }
  const verified = await buildVerifiedLearningProjection(lineageLedger, records);
  return evaluateOfflineOutcomes(verified.verifiedRecords, { ...options, excluded: verified.excluded });
}
