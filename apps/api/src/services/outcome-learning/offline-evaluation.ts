/**
 * PHASE 4 U4 FINAL —— Offline Evaluation（显式 resolved denominator + 评估身份/来源闭合）
 * ---------------------------------------------------------------
 * 依据审计 NEXT（MSG-20261005-62）：
 *   (1) evaluationDigest 必须绑定 datasetVersion + evaluationVersion + sorted verified outcomeDigests
 *       + sorted excluded{digest,reason} + metric result —— 同一 digest 必须唯一对应同一批 verified 证据；
 *   (2) 删除“公开旁路”：纯 evaluator 改为 **module-internal**，外部唯一正式入口是
 *       `evaluateVerifiedLearningRecords()`，其结果带 provenance（U5 candidate 只能绑定带 provenance 的评估）。
 *
 * 口径（MSG-20261005-61 前置已确认）：
 *   resolved = SUCCESS + FAILURE + REJECTED；PARTIAL / MANUAL_REVIEW / UNKNOWN 单独报告，不入分母；
 *   分母为 0 → successRate = null（不伪造成 0/NaN）；禁止 successCount / allRecords 作为正式指标。
 *
 * 硬约束：纯离线、确定性、无网络、无真实模型调用、只读零写入、无第二 Meta Evidence Store；
 * 不修改 Policy / Guard / Router / Action Runtime；AUTO_PROMOTION = OFF。
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
  duplicateVerifiedOutcome: 'DEDUPED_BY_OUTCOME_DIGEST_BEFORE_METRICS（identity + metrics 同一集合）',
  duplicateDigestConflict: 'FAIL_CLOSED（OFFLINE_EVALUATION_DUPLICATE_DIGEST_CONFLICT）',
  zeroDenominator: 'NULL_NOT_ZERO（分母为 0 时 successRate = null，不伪造成 0）',
  rateSemantics:
    'failureRate = (FAILURE + REJECTED) / resolved = NON_SUCCESS_RATE（REJECTED 是 failureRate 的子集；failureRate 与 rejectedRate 不互斥，三率相加不为 100%）',
  verifiedOnly: true,
  rawEvaluator: 'MODULE_INTERNAL（不导出；正式入口仅 evaluateVerifiedLearningRecords）',
  verifiedEntry: 'evaluateVerifiedLearningRecords（先做 U2 trusted lineage binding）',
  evaluationIdentity:
    'evaluationVersion + datasetVersion + sorted verified outcomeDigests + sorted excluded{digest,reason} + metric result',
  contextInIdentity: 'IMPLIED_BY_VERIFIED_OUTCOME_DIGESTS（provider/domain/evidenceQuality/humanIntervention/recoveryAmount 变化 → outcome digest 变化 → evaluationDigest 变化）',
  callerSuppliedEvaluationResult: 'FORBIDDEN（无 provenance 的评估结果不得进入 U5 candidate）',
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
    definition: '（FAILURE + REJECTED）/ resolvedDenominator = NON_SUCCESS_RATE',
    denominator: 'RESOLVED（分母为 0 → null）',
  },
  {
    key: 'rejectedRate',
    definition: 'REJECTED / resolvedDenominator（REJECTED ⊂ failureRate，两率不互斥）',
    denominator: 'RESOLVED（分母为 0 → null）',
  },
  {
    key: 'unresolvedShareOfAllRecords',
    definition: 'unresolvedCount / totalRecords（仅报告，不参与 success-rate 分母）',
    denominator: 'ALL_RECORDS',
  },
] as const;

/** 禁止作为正式指标的键（保留在契约里，便于审计核对未实现）。 */
export const OFFLINE_FORBIDDEN_METRIC_KEYS = [
  'successRateOverAllRecords',
  'overallSuccessRate',
  'successCountOverAllRecords',
] as const;

export interface OfflineEvaluationOptions {
  datasetVersion?: string;
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
  /** NON_SUCCESS_RATE：(FAILURE + REJECTED) / resolved；REJECTED 是其子集（见 rejectedRate）。 */
  failureRate: number | null;
  rejectedRate: number | null;
}

export interface UnresolvedBreakdown {
  count: number;
  excludedFromSuccessRate: true;
  byOutcome: Record<UnresolvedOutcome, number>;
}

export interface OfflineEvaluationProvenance {
  kind: 'VERIFIED_OFFLINE_EVALUATION';
  ledgerProvenance: 'SERVER_OWNED_COMPOSITION';
  verifiedOnly: true;
  evaluationVersion: string;
  datasetVersion: string;
}

export interface OfflineEvaluationMetrics {
  evaluationVersion: string;
  datasetVersion: string;
  totalRecords: number;
  /** U5 FINAL：只读 verified outcome 身份（sorted + 去重），供 candidate 做集合级绑定。 */
  verifiedOutcomeDigests: readonly string[];
  verifiedOutcomeSetDigest: string;
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
  /** 绑定 evaluationVersion + datasetVersion + sorted verified outcomeDigests + sorted excluded + metric result。 */
  evaluationDigest: string;
}

export interface OfflineEvaluationResult extends OfflineEvaluationMetrics {
  /** 仅由正式 verified 入口产生的评估结果才带 provenance。 */
  provenance: OfflineEvaluationProvenance;
}

const VERIFIED_OFFLINE_EVALUATIONS = new WeakSet<OfflineEvaluationResult>();
const VERIFIED_OFFLINE_EVALUATION_FINGERPRINTS = new WeakMap<OfflineEvaluationResult, string>();

/** 对象完整性：冻结所有被 U5 消费的字段（仅冻结顶层不够）。 */
const freezeEvaluation = (result: OfflineEvaluationResult): void => {
  Object.freeze(result.verifiedOutcomeDigests);
  Object.freeze(result.resolved.byOutcome);
  Object.freeze(result.resolved);
  Object.freeze(result.unresolved.byOutcome);
  Object.freeze(result.unresolved);
  Object.freeze(result.context.byEvidenceQuality);
  Object.freeze(result.context.byDomain);
  Object.freeze(result.context);
  for (const item of result.excluded) Object.freeze(item);
  Object.freeze(result.excluded);
  Object.freeze(result.provenance);
  Object.freeze(result);
};

const sortedUnique = (values: readonly string[]): string[] =>
  Array.from(new Set(values)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** canonical fingerprint：覆盖 U5 实际消费的所有字段（U5 FINAL2 anti-tamper）。 */
const evaluationFingerprint = (result: OfflineEvaluationResult): string =>
  JSON.stringify({
    evaluationVersion: result.evaluationVersion,
    datasetVersion: result.datasetVersion,
    totalRecords: result.totalRecords,
    verifiedOutcomeDigests: [...result.verifiedOutcomeDigests],
    verifiedOutcomeSetDigest: result.verifiedOutcomeSetDigest,
    resolved: {
      denominatorKind: result.resolved.denominatorKind,
      denominator: result.resolved.denominator,
      defined: result.resolved.defined,
      byOutcome: { ...result.resolved.byOutcome },
      successCount: result.resolved.successCount,
      failureCount: result.resolved.failureCount,
      rejectedCount: result.resolved.rejectedCount,
      successRate: result.resolved.successRate,
      failureRate: result.resolved.failureRate,
      rejectedRate: result.resolved.rejectedRate,
    },
    unresolved: {
      count: result.unresolved.count,
      excludedFromSuccessRate: result.unresolved.excludedFromSuccessRate,
      byOutcome: { ...result.unresolved.byOutcome },
    },
    unresolvedShareOfAllRecords: result.unresolvedShareOfAllRecords,
    insufficientData: result.insufficientData,
    context: {
      humanInterventionCount: result.context.humanInterventionCount,
      byEvidenceQuality: { ...result.context.byEvidenceQuality },
      byDomain: { ...result.context.byDomain },
    },
    excludedCount: result.excludedCount,
    excluded: result.excluded.map((item) => ({ digest: item.digest, reason: item.reason })),
    evaluationDigest: result.evaluationDigest,
    provenance: {
      kind: result.provenance.kind,
      ledgerProvenance: result.provenance.ledgerProvenance,
      verifiedOnly: result.provenance.verifiedOnly,
      evaluationVersion: result.provenance.evaluationVersion,
      datasetVersion: result.provenance.datasetVersion,
    },
  });

/** 只读 provenance：只有 evaluateVerifiedLearningRecords() 产出的评估才为 true。 */
export function isVerifiedOfflineEvaluation(result: OfflineEvaluationResult | null | undefined): boolean {
  if (result === null || result === undefined) return false;
  if (!VERIFIED_OFFLINE_EVALUATIONS.has(result)) return false;
  const fingerprint = VERIFIED_OFFLINE_EVALUATION_FINGERPRINTS.get(result);
  if (fingerprint === undefined) return false;
  try {
    // 不仅查 identity：重算 canonical fingerprint，原地篡改一律失败
    return fingerprint === evaluationFingerprint(result);
  } catch {
    return false;
  }
}

const bump = (map: Record<string, number>, key: string): void => {
  map[key] = (map[key] ?? 0) + 1;
};

const zeroResolved = (): Record<ResolvedOutcome, number> => ({ SUCCESS: 0, FAILURE: 0, REJECTED: 0 });
const zeroUnresolved = (): Record<UnresolvedOutcome, number> => ({ PARTIAL: 0, MANUAL_REVIEW: 0, UNKNOWN: 0 });

const requireDatasetVersion = (datasetVersion: string): string => {
  if (typeof datasetVersion !== 'string' || datasetVersion.trim() === '') {
    throw new Error('OFFLINE_EVALUATION_DATASET_VERSION_REQUIRED');
  }
  return datasetVersion;
};

const sortAscending = (values: readonly string[]): string[] => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * **module-internal**：纯 evaluator（不导出）。
 * 只接受已验证记录；未知 finalOutcome / 空 datasetVersion / 非数组输入 → fail-closed。
 */
function evaluateOfflineOutcomesInternal(
  records: readonly OutcomeRecord[],
  options: OfflineEvaluationOptions,
  excluded: ReadonlyArray<{ digest: string; reason: string }>,
): OfflineEvaluationMetrics {
  if (!Array.isArray(records)) {
    throw new Error('OFFLINE_EVALUATION_RECORDS_REQUIRED');
  }
  const datasetVersion = requireDatasetVersion(options.datasetVersion ?? 'learning-dataset/v1');

  const byOutcome = zeroResolved();
  const unresolvedByOutcome = zeroUnresolved();
  const byEvidenceQuality: Record<string, number> = {};
  const byDomain: Record<string, number> = {};
  const outcomeDigests: string[] = [];
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
    outcomeDigests.push(String(record.digest));
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

  // 评估身份：metric result + sorted verified outcomeDigests + sorted excluded{digest,reason}
  const metricResult = [
    'total=' + String(totalRecords),
    'success=' + String(successCount),
    'failure=' + String(byOutcome.FAILURE),
    'rejected=' + String(byOutcome.REJECTED),
    'partial=' + String(unresolvedByOutcome.PARTIAL),
    'manual=' + String(unresolvedByOutcome.MANUAL_REVIEW),
    'unknown=' + String(unresolvedByOutcome.UNKNOWN),
    'resolved=' + String(denominator),
    'unresolved=' + String(unresolvedCount),
  ].join(',');
  const preimage = [
    OFFLINE_EVALUATION_VERSION,
    datasetVersion,
    metricResult,
    'verified=' + sortedUnique(outcomeDigests).join('+'),
    'excluded=' +
      sortAscending(excluded.map((item) => String(item.digest) + ':' + String(item.reason))).join('+'),
  ].join('|');

  return {
    evaluationVersion: OFFLINE_EVALUATION_VERSION,
    datasetVersion,
    totalRecords,
    // set 语义（与 U3 manifest 一致）：sorted + 去重
    verifiedOutcomeDigests: sortedUnique(outcomeDigests),
    verifiedOutcomeSetDigest:
      'verified-outcomes:' +
      createHash('sha256').update(sortedUnique(outcomeDigests).join('+')).digest('hex').slice(0, 16),
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
    evaluationDigest: 'offline-eval:' + createHash('sha256').update(preimage).digest('hex').slice(0, 16),
  };
}

/**
 * **唯一正式入口**：verified-only 离线评估。
 * 先做 U2 trusted lineage binding（U3 学习路径），只有通过 binding 的记录进入评估；
 * 排除项如实登记并参与 evaluationDigest。lineage ledger 缺失或 provenance 不可信 → fail-closed。
 */
/** canonical 内容键（不含 digest）：用于识别“同 digest 但内容不一致”的伪造记录。 */
const recordContentKey = (record: OutcomeRecord): string => {
  const rest: Record<string, unknown> = { ...(record as unknown as Record<string, unknown>) };
  delete rest.digest;
  return JSON.stringify(Object.keys(rest).sort().map((key) => [key, rest[key]]));
};

/**
 * PHASE 4 FINAL CLOSURE：正式 evaluation 在计算 metrics 前按 OutcomeRecord.digest 去重。
 * 同 digest 但 canonical 内容不一致 → fail-closed（绝不任选一条）。
 */
const dedupeVerifiedRecords = (records: readonly OutcomeRecord[]): OutcomeRecord[] => {
  const byDigest = new Map<string, { record: OutcomeRecord; contentKey: string }>();
  for (const record of records) {
    const digest = typeof record?.digest === 'string' ? record.digest : '';
    const contentKey = recordContentKey(record);
    const seen = byDigest.get(digest);
    if (seen === undefined) {
      byDigest.set(digest, { record, contentKey });
      continue;
    }
    if (seen.contentKey !== contentKey) {
      throw new Error('OFFLINE_EVALUATION_DUPLICATE_DIGEST_CONFLICT:' + digest);
    }
  }
  return [...byDigest.values()].map((item) => item.record);
};

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
  const datasetVersion = requireDatasetVersion(options.datasetVersion ?? 'learning-dataset/v1');
  const verified = await buildVerifiedLearningProjection(lineageLedger, records);
  // verified records → dedupe by digest → metrics + identity（totalRecords = uniqueVerifiedRecords.length）
  const uniqueVerifiedRecords = dedupeVerifiedRecords(verified.verifiedRecords);
  const metrics = evaluateOfflineOutcomesInternal(uniqueVerifiedRecords, { datasetVersion }, verified.excluded);
  const result: OfflineEvaluationResult = {
    ...metrics,
    provenance: {
      kind: 'VERIFIED_OFFLINE_EVALUATION',
      ledgerProvenance: 'SERVER_OWNED_COMPOSITION',
      verifiedOnly: true,
      evaluationVersion: OFFLINE_EVALUATION_VERSION,
      datasetVersion,
    },
  };
  freezeEvaluation(result);
  VERIFIED_OFFLINE_EVALUATIONS.add(result);
  VERIFIED_OFFLINE_EVALUATION_FINGERPRINTS.set(result, evaluationFingerprint(result));
  return result;
}
