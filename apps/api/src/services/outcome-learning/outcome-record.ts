/**
 * PHASE 4 U1 —— OUTCOME / LEARNING DATA PIPELINE：canonical outcome 记录契约
 * ---------------------------------------------------------------
 * 定位：**只做观察**。本模块不修改 Policy / Guard / Router / Action Runtime，
 * 也不产生任何生产写入（REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT /
 * TRANSPORT / PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT 全部 HOLD）。
 *
 * 硬约束：
 *   - 记录只允许**结构化字段 + 引用**：不得携带凭据，不得携带原始 payload / provider 响应。
 *   - 数值字段必须是有限非负数；非有限或负数一律 fail-closed（拒绝构建）。
 *   - lineage（actionRef / proposalRef / evidenceRef）为必填：outcome 只能**引用**，不得复制原始事实。
 *   - AUTO_PROMOTION = OFF；任何 meta-improvement 只能提建议，必须经外部 Judge / 人工裁决。
 */

import { createHash } from 'node:crypto';

import { scanCredentialFields } from '../action-runtime/provider-adapter-contract';

export const OUTCOME_DIMENSIONS = [
  'taskType',
  'domain',
  'provider',
  'strategy',
  'modelTier',
  'inputCost',
  'outputCost',
  'latencyMs',
  'evidenceQuality',
  'actionResult',
  'rejectionReason',
  'recoveryAmount',
  'success',
  'humanIntervention',
  'retryReconcile',
  'finalOutcome',
] as const;
export type OutcomeDimension = (typeof OUTCOME_DIMENSIONS)[number];

export const FINAL_OUTCOMES = ['SUCCESS', 'FAILURE', 'PARTIAL', 'REJECTED', 'MANUAL_REVIEW', 'UNKNOWN'] as const;
export type FinalOutcome = (typeof FINAL_OUTCOMES)[number];

export const EVIDENCE_QUALITIES = ['STRONG', 'WEAK', 'MISSING', 'UNKNOWN'] as const;
export type EvidenceQuality = (typeof EVIDENCE_QUALITIES)[number];

export const RETRY_RECONCILE_STATES = ['NONE', 'RETRIED', 'RECONCILED', 'MANUAL_REVIEW'] as const;
export type RetryReconcileState = (typeof RETRY_RECONCILE_STATES)[number];

export const OUTCOME_LEARNING_BOUNDARY = {
  observationOnly: true,
  autoPolicyMutation: 'FORBIDDEN',
  autoPromotion: 'OFF',
  rawPayload: 'FORBIDDEN（只允许结构化字段 + 引用）',
  credentialFields: 'FORBIDDEN',
  lineage: 'REQUIRED（actionRef / proposalRef / evidenceRef 只引用，不复制）',
  secondMetaEvidenceStore: 'FORBIDDEN（复用既有 rsi-evidence-ledger）',
  productionWrite: 'HOLD',
} as const;

/** 原始载荷/响应键：一旦出现即拒绝（防止把原始事实抄进学习数据）。 */
const RAW_PAYLOAD_KEY = /^(payload|payloads|response|responses|body|raw|rawpayload|raw_payload)$/i;

export interface OutcomeRecordInput {
  organizationId: string;
  taskId: string;
  taskType: string;
  domain: string;
  provider?: string | null;
  strategy?: string | null;
  modelTier?: string | null;
  inputCost?: unknown;
  outputCost?: unknown;
  latencyMs?: unknown;
  evidenceQuality?: unknown;
  actionResult?: unknown;
  rejectionReason?: string | null;
  recoveryAmount?: unknown;
  success?: unknown;
  humanIntervention?: unknown;
  retryReconcile?: unknown;
  finalOutcome?: unknown;
  /** lineage：只引用，不复制原始事实 */
  actionRef?: string | null;
  proposalRef?: string | null;
  evidenceRef?: string | null;
}

export interface OutcomeRecord {
  organizationId: string;
  taskId: string;
  taskType: string;
  domain: string;
  provider: string | null;
  strategy: string | null;
  modelTier: string | null;
  inputCost: number | null;
  outputCost: number | null;
  latencyMs: number | null;
  evidenceQuality: EvidenceQuality;
  actionResult: string | null;
  rejectionReason: string | null;
  recoveryAmount: number | null;
  success: boolean | null;
  humanIntervention: boolean;
  retryReconcile: RetryReconcileState;
  finalOutcome: FinalOutcome;
  actionRef: string;
  proposalRef: string;
  evidenceRef: string;
  digest: string;
}

export type OutcomeBuildResult = { ok: true; record: OutcomeRecord } | { ok: false; reason: string };

const required = (v: unknown): string =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : '';

const optionalText = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/** 有限非负数值；空值 → null；非法 → 'INVALID' */
const nonNegativeNumber = (v: unknown): number | null | 'INVALID' => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 'INVALID';
  return n;
};

const optionalBoolean = (v: unknown): boolean | null | 'INVALID' => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return 'INVALID';
};

const enumOr = <T extends readonly string[]>(allowed: T, v: unknown, fallback: T[number]): T[number] | 'INVALID' => {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v);
  return (allowed as readonly string[]).includes(s) ? (s as T[number]) : 'INVALID';
};

const hasRawPayloadKey = (input: Record<string, unknown>): boolean =>
  Object.keys(input).some((key) => RAW_PAYLOAD_KEY.test(key));

/** 构建 canonical outcome 记录（fail-closed：任何违规都拒绝，不静默清洗）。 */
export function buildOutcomeRecord(input: OutcomeRecordInput | null | undefined): OutcomeBuildResult {
  if (input === null || input === undefined || typeof input !== 'object') {
    return { ok: false, reason: 'OUTCOME_RECORD_INPUT_REQUIRED' };
  }
  const raw = input as unknown as Record<string, unknown>;

  const organizationId = required(input.organizationId);
  const taskId = required(input.taskId);
  const taskType = required(input.taskType);
  const domain = required(input.domain);
  if (organizationId === '' || taskId === '' || taskType === '' || domain === '') {
    return { ok: false, reason: 'OUTCOME_RECORD_IDENTITY_REQUIRED' };
  }

  if (hasRawPayloadKey(raw)) {
    return { ok: false, reason: 'OUTCOME_RECORD_RAW_PAYLOAD_FORBIDDEN' };
  }
  const credentialKeys = scanCredentialFields(raw);
  if (credentialKeys.length > 0) {
    return { ok: false, reason: 'OUTCOME_RECORD_CREDENTIAL_FIELDS_FORBIDDEN:' + credentialKeys.join(',') };
  }

  const actionRef = required(input.actionRef);
  const proposalRef = required(input.proposalRef);
  const evidenceRef = required(input.evidenceRef);
  if (actionRef === '' || proposalRef === '' || evidenceRef === '') {
    return { ok: false, reason: 'OUTCOME_RECORD_LINEAGE_REQUIRED' };
  }

  const inputCost = nonNegativeNumber(input.inputCost);
  const outputCost = nonNegativeNumber(input.outputCost);
  const latencyMs = nonNegativeNumber(input.latencyMs);
  const recoveryAmount = nonNegativeNumber(input.recoveryAmount);
  if (inputCost === 'INVALID' || outputCost === 'INVALID' || latencyMs === 'INVALID' || recoveryAmount === 'INVALID') {
    return { ok: false, reason: 'OUTCOME_RECORD_NUMERIC_FIELD_INVALID' };
  }

  const success = optionalBoolean(input.success);
  const humanIntervention = optionalBoolean(input.humanIntervention);
  if (success === 'INVALID' || humanIntervention === 'INVALID') {
    return { ok: false, reason: 'OUTCOME_RECORD_BOOLEAN_FIELD_INVALID' };
  }

  const evidenceQuality = enumOr(EVIDENCE_QUALITIES, input.evidenceQuality, 'UNKNOWN');
  const retryReconcile = enumOr(RETRY_RECONCILE_STATES, input.retryReconcile, 'NONE');
  const finalOutcome = enumOr(FINAL_OUTCOMES, input.finalOutcome, 'UNKNOWN');
  if (evidenceQuality === 'INVALID' || retryReconcile === 'INVALID' || finalOutcome === 'INVALID') {
    return { ok: false, reason: 'OUTCOME_RECORD_ENUM_INVALID' };
  }

  const canonical = {
    organizationId,
    taskId,
    taskType,
    domain,
    provider: optionalText(input.provider),
    strategy: optionalText(input.strategy),
    modelTier: optionalText(input.modelTier),
    inputCost,
    outputCost,
    latencyMs,
    evidenceQuality,
    actionResult: optionalText(input.actionResult),
    rejectionReason: optionalText(input.rejectionReason),
    recoveryAmount,
    success,
    humanIntervention: humanIntervention === true,
    retryReconcile,
    finalOutcome,
    actionRef,
    proposalRef,
    evidenceRef,
  };
  const digest = 'outcome:' + createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
  return { ok: true, record: { ...canonical, digest } };
}

export interface LearningDatasetProjection {
  recordCount: number;
  byDomain: Record<string, number>;
  byProvider: Record<string, number>;
  byFinalOutcome: Record<string, number>;
  successCount: number;
  failureCount: number;
  successRate: number | null;
  totalRecoveryAmount: number;
  averageLatencyMs: number | null;
  totalInputCost: number;
  totalOutputCost: number;
  humanInterventionCount: number;
  manualReviewCount: number;
}

/**
 * 只读投影：从 canonical outcome 派生学习数据集视图。
 * 纯函数 —— 不修改入参，不写入任何存储，不产生建议之外的动作。
 */
export function projectLearningDataset(records: readonly OutcomeRecord[]): LearningDatasetProjection {
  const byDomain: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  const byFinalOutcome: Record<string, number> = {};
  let successCount = 0;
  let failureCount = 0;
  let totalRecoveryAmount = 0;
  let totalInputCost = 0;
  let totalOutputCost = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let humanInterventionCount = 0;
  let manualReviewCount = 0;

  for (const record of records) {
    byDomain[record.domain] = (byDomain[record.domain] ?? 0) + 1;
    const providerKey = record.provider ?? 'UNKNOWN';
    byProvider[providerKey] = (byProvider[providerKey] ?? 0) + 1;
    byFinalOutcome[record.finalOutcome] = (byFinalOutcome[record.finalOutcome] ?? 0) + 1;
    if (record.finalOutcome === 'SUCCESS') successCount += 1;
    if (record.finalOutcome === 'FAILURE' || record.finalOutcome === 'REJECTED') failureCount += 1;
    if (record.finalOutcome === 'MANUAL_REVIEW') manualReviewCount += 1;
    if (record.recoveryAmount !== null) totalRecoveryAmount += record.recoveryAmount;
    if (record.inputCost !== null) totalInputCost += record.inputCost;
    if (record.outputCost !== null) totalOutputCost += record.outputCost;
    if (record.latencyMs !== null) {
      latencySum += record.latencyMs;
      latencyCount += 1;
    }
    if (record.humanIntervention) humanInterventionCount += 1;
  }

  const recordCount = records.length;
  return {
    recordCount,
    byDomain,
    byProvider,
    byFinalOutcome,
    successCount,
    failureCount,
    successRate: recordCount === 0 ? null : successCount / recordCount,
    totalRecoveryAmount,
    averageLatencyMs: latencyCount === 0 ? null : latencySum / latencyCount,
    totalInputCost,
    totalOutputCost,
    humanInterventionCount,
    manualReviewCount,
  };
}
