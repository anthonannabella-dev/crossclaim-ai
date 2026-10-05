/**
 * Recovery SI —— P2-A：SI 决策 → RSI 能力级 Outcome Signal（匿名 · 聚合 · 只读）
 * ---------------------------------------------------------------
 * 授权：MSG-20261005-13（Recovery SI Phase 2 设计 = PASS WITH REVISE）。
 *   · P2-A = AUTHORIZED_WITH_CONDITIONS，**硬前置**：
 *     `RECOVERY_OUTCOME_TO_RSI = AGGREGATED_ANONYMIZED_CAPABILITY_SIGNAL_ONLY`；
 *   · RSI 侧（observer / incident / task / evidence）**不得**看到任何客户事实：
 *     禁止 `organizationId / userId / caseId / opportunityRef / claimId / paymentAccountRef /
 *     entryNumber / invoice·order·shipment identifiers / raw evidence refs / customer-specific
 *     monetary amount`；
 *   · 只允许**能力级聚合**指标（`estimate_error_bucket` / `authorization_block_rate` /
 *     `evidence_missing_rate` / `median_time_to_ready`），或
 *     `signal = CUSTOMS_ESTIMATE_CALIBRATION_DRIFT` + `refs = rule-version:v3 / algorithm-version:v2`；
 *   · 本模块只做**映射 + 校验**：不落库、不发网络、不读凭据；把 outcome signal 真正投递进
 *     RSI incident/task 属内部写入，本轮**不接线**（`RSI_SINK_NOT_WIRED_IN_P2_A`，fail-closed）。
 *
 * 反匿名化保护：小于 `RECOVERY_OUTCOME_MIN_COHORT` 的 cohort 直接**不产生信号**（宁缺毋滥）。
 */

import type { RecoveryDomain } from './customer-recovery-state';
import type { RecoverySupervisionResult } from './recovery-supervisor';

/** P2-A 硬前置（裁决原文常量名，缺一不可） */
export const RECOVERY_OUTCOME_TO_RSI = 'AGGREGATED_ANONYMIZED_CAPABILITY_SIGNAL_ONLY' as const;

/** 允许出现的能力级指标（裁决枚举；新增指标必须先过架构审计） */
export const RSI_OUTCOME_METRICS = [
  'estimate_error_bucket',
  'authorization_block_rate',
  'evidence_missing_rate',
  'median_time_to_ready',
] as const;
export type RsiOutcomeMetric = (typeof RSI_OUTCOME_METRICS)[number];

/** 小于该 cohort 不产生信号（防反匿名化） */
export const RECOVERY_OUTCOME_MIN_COHORT = 5;

/** 明确禁止的字段（命中即整条信号 fail-closed，绝不“脱敏后仍发送”） */
export const RSI_OUTCOME_FORBIDDEN_KEYS: readonly string[] = [
  'organizationId',
  'organizationRef',
  'orgId',
  'tenantId',
  'userId',
  'userRef',
  'actorUserId',
  'caseId',
  'caseRef',
  'claimId',
  'claimRef',
  'opportunityId',
  'opportunityRef',
  'paymentAccountRef',
  'payoutAccountRef',
  'accountId',
  'entryNumber',
  'entryRef',
  'invoiceRef',
  'invoiceReference',
  'orderRef',
  'shipmentRef',
  'trackingNumber',
  'importerOfRecordRef',
  'legalEntityRef',
  'aceAccountRef',
  'brokerRef',
  'poaRef',
  'evidenceRef',
  'evidenceRefs',
  'evidenceIds',
  'rawEvidenceRefs',
  'transactionRef',
  'recoveryLedgerRef',
  'amount',
  'amounts',
  'recoverableAmount',
  'expectedRecovery',
  'customerAmount',
  'settlementAmount',
  'currency',
];

/** 顶层键白名单：除这些键以外的一切键都属于 UNEXPECTED_FIELD */
export const RSI_OUTCOME_ALLOWED_KEYS: readonly string[] = [
  'signal',
  'domain',
  'metrics',
  'refs',
  'cohortSize',
  'riskClass',
  'dedupeKey',
  'summary',
  'reasonCodes',
];

/** refs 只允许指向「版本 / 能力」而不是记录（不允许 opportunityRef 之类的业务引用） */
const ALLOWED_REF_PATTERN = /^(rule-version|algorithm-version|capability|tool-registry):[A-Za-z0-9._-]+$/;
/**
 * 出现在摘要里就说明有人把标识符 / 客户金额塞进来了：
 * 邮箱、绝对路径、货币符号、千分位金额、5 位以上数字串、`org-/opp-/case-…` 前缀引用。
 */
const IDENTIFIER_LEAK_PATTERN = /(@|[A-Za-z]:\\|\$\s?\d|\d{1,3}(?:,\d{3})+|\b\d{5,}\b|\b(?:org|opp|case|claim|inv|order|ship)[-_][A-Za-z0-9-]+)/i;

export interface RecoveryOutcomeSignal {
  signal: string;
  domain: RecoveryDomain;
  metrics: Readonly<Partial<Record<RsiOutcomeMetric, string | number>>>;
  refs: readonly string[];
  cohortSize: number;
  riskClass: 'LOW' | 'MEDIUM' | 'HIGH';
  dedupeKey: string;
  summary: string;
  reasonCodes: readonly string[];
}

export type RecoveryOutcomeViolationReason =
  | 'NOT_AN_OBJECT'
  | 'FORBIDDEN_FIELD'
  | 'UNEXPECTED_FIELD'
  | 'METRIC_NOT_ALLOWED'
  | 'METRIC_VALUE_OUT_OF_RANGE'
  | 'REF_NOT_ALLOWED'
  | 'COHORT_TOO_SMALL'
  | 'SUMMARY_LEAKS_IDENTIFIER';

export interface RecoveryOutcomeViolation {
  path: string;
  reason: RecoveryOutcomeViolationReason;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const rateIsValid = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const timeToReadyIsValid = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 1_000_000_000;
const bucketIsValid = (value: unknown): boolean =>
  typeof value === 'string' && ['0-5%', '5-10%', '10-20%', '>20%'].includes(value);

/**
 * 深度扫描：任何一条违规都意味着**整条信号不得投递**（fail-closed，不做“就地脱敏重发”）。
 */
export function scanRecoveryOutcomeSignal(candidate: unknown): readonly RecoveryOutcomeViolation[] {
  const violations: RecoveryOutcomeViolation[] = [];
  if (!isPlainObject(candidate)) return [{ path: '$', reason: 'NOT_AN_OBJECT' }];

  for (const key of Object.keys(candidate)) {
    if (RSI_OUTCOME_FORBIDDEN_KEYS.includes(key)) {
      violations.push({ path: `$.${key}`, reason: 'FORBIDDEN_FIELD' });
      continue;
    }
    if (!RSI_OUTCOME_ALLOWED_KEYS.includes(key)) {
      violations.push({ path: `$.${key}`, reason: 'UNEXPECTED_FIELD' });
    }
  }

  const metrics = candidate.metrics;
  if (isPlainObject(metrics)) {
    for (const [key, value] of Object.entries(metrics)) {
      if (RSI_OUTCOME_FORBIDDEN_KEYS.includes(key)) {
        violations.push({ path: `$.metrics.${key}`, reason: 'FORBIDDEN_FIELD' });
        continue;
      }
      if (!(RSI_OUTCOME_METRICS as readonly string[]).includes(key)) {
        violations.push({ path: `$.metrics.${key}`, reason: 'METRIC_NOT_ALLOWED' });
        continue;
      }
      if (key === 'estimate_error_bucket' ? !bucketIsValid(value) : key === 'median_time_to_ready' ? !timeToReadyIsValid(value) : !rateIsValid(value)) {
        violations.push({ path: `$.metrics.${key}`, reason: 'METRIC_VALUE_OUT_OF_RANGE' });
      }
    }
  }

  const refs = candidate.refs;
  if (Array.isArray(refs)) {
    refs.forEach((ref, index) => {
      if (typeof ref !== 'string' || !ALLOWED_REF_PATTERN.test(ref)) {
        violations.push({ path: `$.refs[${index}]`, reason: 'REF_NOT_ALLOWED' });
      }
    });
  }

  const cohortSize = candidate.cohortSize;
  if (typeof cohortSize !== 'number' || !Number.isInteger(cohortSize) || cohortSize < RECOVERY_OUTCOME_MIN_COHORT) {
    violations.push({ path: '$.cohortSize', reason: 'COHORT_TOO_SMALL' });
  }

  const summary = candidate.summary;
  if (typeof summary === 'string' && IDENTIFIER_LEAK_PATTERN.test(summary)) {
    violations.push({ path: '$.summary', reason: 'SUMMARY_LEAKS_IDENTIFIER' });
  }

  return violations;
}

export interface RecoveryOutcomeSignalInput {
  supervision: RecoverySupervisionResult;
  /** 确定性算法版本（例如 `v2`），用于 refs 追溯，不含客户信息 */
  algorithmVersion: string;
  /** 生效中的 RuleVersion 引用（例如 `rule-version:v3`） */
  ruleVersionRefs?: readonly string[];
  /** 预测 vs 实际（只在**聚合**后用于分档；原始金额绝不进入信号） */
  estimateErrorSamples?: readonly { predicted: number; actual: number }[];
  /** time-to-ready 样本（毫秒），同样只用于取中位数 */
  timeToReadySamplesMs?: readonly number[];
}

export interface RecoveryOutcomeSignalSkipped {
  domain: RecoveryDomain;
  reason: 'NO_ACTIONS' | 'COHORT_TOO_SMALL' | 'VIOLATIONS';
}

export interface RecoveryOutcomeSignalBuildResult {
  signals: readonly RecoveryOutcomeSignal[];
  skipped: readonly RecoveryOutcomeSignalSkipped[];
  violations: readonly RecoveryOutcomeViolation[];
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1] ?? upper;
  return Number(((lower + upper) / 2).toFixed(4));
};

const errorBucket = (medianRelativeError: number): string =>
  medianRelativeError <= 0.05 ? '0-5%' : medianRelativeError <= 0.1 ? '5-10%' : medianRelativeError <= 0.2 ? '10-20%' : '>20%';

const rate = (numerator: number, denominator: number): number => Number((numerator / denominator).toFixed(4));

/**
 * SI 决策 → 能力级聚合信号。**按 domain 聚合**，任何低于最小 cohort 的域不产生信号。
 */
export function buildRecoveryOutcomeSignals(input: RecoveryOutcomeSignalInput): RecoveryOutcomeSignalBuildResult {
  const actions = input.supervision.plan?.actions ?? [];
  const domains: RecoveryDomain[] = ['PLATFORM', 'CARRIER', 'CUSTOMS', 'INDEPENDENT_SITE'];
  const signals: RecoveryOutcomeSignal[] = [];
  const skipped: RecoveryOutcomeSignalSkipped[] = [];
  const violations: RecoveryOutcomeViolation[] = [];

  for (const domain of domains) {
    const domainActions = actions.filter((action) => action.domain === domain);
    if (domainActions.length === 0) continue;
    if (domainActions.length < RECOVERY_OUTCOME_MIN_COHORT) {
      skipped.push({ domain, reason: 'COHORT_TOO_SMALL' });
      continue;
    }

    const cohortSize = domainActions.length;
    const blocked = domainActions.filter(
      (action) => action.proposedAction === 'REQUEST_AUTHORIZATION' || action.reasonCodes.includes('AUTHORIZATION_MISSING'),
    ).length;
    const evidenceMissing = domainActions.filter(
      (action) => action.proposedAction === 'REQUEST_EVIDENCE' || action.reasonCodes.includes('EVIDENCE_INCOMPLETE'),
    ).length;

    const metrics: Partial<Record<RsiOutcomeMetric, string | number>> = {
      authorization_block_rate: rate(blocked, cohortSize),
      evidence_missing_rate: rate(evidenceMissing, cohortSize),
    };
    const reasonCodes = new Set<string>(['AGGREGATED_ONLY', 'ANONYMIZED_ONLY']);

    const estimateSamples = input.estimateErrorSamples ?? [];
    if (estimateSamples.length >= RECOVERY_OUTCOME_MIN_COHORT) {
      const relativeErrors = estimateSamples.map((sample) =>
        Math.abs(sample.predicted - sample.actual) / Math.max(Math.abs(sample.actual), 1),
      );
      metrics.estimate_error_bucket = errorBucket(median(relativeErrors));
    } else {
      reasonCodes.add('ESTIMATE_ERROR_NOT_MEASURABLE');
    }

    const timeSamples = (input.timeToReadySamplesMs ?? []).filter((value) => Number.isInteger(value) && value > 0);
    if (timeSamples.length >= RECOVERY_OUTCOME_MIN_COHORT) {
      metrics.median_time_to_ready = median(timeSamples);
    } else {
      reasonCodes.add('TIME_TO_READY_NOT_MEASURABLE');
    }

    const bucket = metrics.estimate_error_bucket;
    const drifting = bucket === '10-20%' || bucket === '>20%';
    const signalName = drifting ? `${domain}_ESTIMATE_CALIBRATION_DRIFT` : `${domain}_RECOVERY_CAPABILITY_SIGNAL`;
    const blockRate = typeof metrics.authorization_block_rate === 'number' ? metrics.authorization_block_rate : 0;
    const riskClass: RecoveryOutcomeSignal['riskClass'] =
      bucket === '>20%' ? 'HIGH' : drifting || blockRate >= 0.5 ? 'MEDIUM' : 'LOW';

    const refs = [...new Set([...(input.ruleVersionRefs ?? []), `algorithm-version:${input.algorithmVersion}`])].sort();
    const metricKeys = Object.keys(metrics).sort();
    const signal: RecoveryOutcomeSignal = {
      signal: signalName,
      domain,
      metrics,
      refs,
      cohortSize,
      riskClass,
      dedupeKey: `${signalName}:cohort>=${Math.floor(cohortSize / RECOVERY_OUTCOME_MIN_COHORT) * RECOVERY_OUTCOME_MIN_COHORT}:${metricKeys.join(',')}`,
      summary: `Recovery capability signal for ${domain}: ${metricKeys.join(', ')} (aggregated ${cohortSize} actions)`,
      reasonCodes: [...reasonCodes].sort(),
    };

    const signalViolations = scanRecoveryOutcomeSignal(signal);
    if (signalViolations.length > 0) {
      skipped.push({ domain, reason: 'VIOLATIONS' });
      violations.push(...signalViolations);
      continue;
    }
    signals.push(signal);
  }

  return { signals, skipped, violations };
}

export interface RecoveryOutcomeSignalSink {
  emit(signal: RecoveryOutcomeSignal): void | Promise<void>;
}

export type RecoveryOutcomePublishResult =
  | { published: true; count: number }
  | {
      published: false;
      reason: 'RSI_SINK_NOT_WIRED_IN_P2_A' | 'SIGNAL_REJECTED';
      violations: readonly RecoveryOutcomeViolation[];
    };

/**
 * 投递入口：**先全量校验，再考虑投递**。没有 sink（本阶段默认）→ fail-closed 且零写入。
 */
export async function publishRecoveryOutcomeSignals(
  signals: readonly RecoveryOutcomeSignal[],
  sink?: RecoveryOutcomeSignalSink,
): Promise<RecoveryOutcomePublishResult> {
  const violations = signals.flatMap((signal, index) =>
    scanRecoveryOutcomeSignal(signal).map((violation) => ({ path: `signals[${index}]${violation.path.slice(1)}`, reason: violation.reason })),
  );
  if (violations.length > 0) return { published: false, reason: 'SIGNAL_REJECTED', violations };
  if (sink === undefined) return { published: false, reason: 'RSI_SINK_NOT_WIRED_IN_P2_A', violations: [] };
  for (const signal of signals) await sink.emit(signal);
  return { published: true, count: signals.length };
}

export const RECOVERY_OUTCOME_SIGNAL_BOUNDARY = {
  hardPrecondition: RECOVERY_OUTCOME_TO_RSI,
  aggregatedOnly: true,
  anonymizedOnly: true,
  customerFactsAllowed: false,
  perTenantSignalsAllowed: false,
  customerMonetaryAmountsAllowed: false,
  minCohortSize: RECOVERY_OUTCOME_MIN_COHORT,
  allowedMetrics: RSI_OUTCOME_METRICS,
  failClosedOnViolation: true,
  sanitizeAndResend: false,
  writesDatabase: false,
  networkCalls: 0,
  productionCredentialsRead: false,
  rsiIncidentTaskWiring: 'NOT_WIRED_IN_P2_A',
} as const;
