/**
 * PHASE 4 U1+U2 —— OUTCOME / LEARNING DATA PIPELINE：canonical outcome 契约 + lineage binding
 * ---------------------------------------------------------------
 * 定位：**只做观察**。本模块不修改 Policy / Guard / Router / Action Runtime，
 * 也不产生任何生产写入（REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT /
 * TRANSPORT / PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT 全部 HOLD）。
 *
 * 硬约束（含 FINAL 收口）：
 *   - 只允许**结构化字段 + 引用**：不得携带凭据，不得携带原始 payload / provider 响应（**递归**扫描）。
 *   - **严格类型**：数值字段只接受真正的 number；布尔字段只接受真正的 boolean；字符串形式一律拒绝（不静默清洗）。
 *   - `finalOutcome` 是成功语义的 **SSOT**：`success` 由它派生；caller 传入矛盾值即拒绝。
 *   - `humanIntervention` 缺失 → `null`（UNKNOWN），**不得**降级为 `false`。
 *   - lineage（actionRef / proposalRef / evidenceRef）必填；若给出 lineage 声明，必须与记录同链（U2 binding）。
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
  rawPayload: 'FORBIDDEN（递归扫描，含嵌套 metadata.payload）',
  credentialFields: 'FORBIDDEN',
  strictTypes: 'ENFORCED（number/boolean 不做字符串强转）',
  lineage: 'REQUIRED（actionRef / proposalRef / evidenceRef 只引用，不复制）',
  lineageBinding: 'ENFORCED（organization/task/action/proposal/evidence 必须同链）',
  successSemantics: 'finalOutcome 为 SSOT，success 由它派生',
  secondMetaEvidenceStore: 'FORBIDDEN（复用既有 rsi-evidence-ledger）',
  productionWrite: 'HOLD',
} as const;

/** 原始载荷/响应键：递归出现即拒绝（防止把原始事实抄进学习数据）。 */
const RAW_PAYLOAD_KEY = /^(payload|payloads|response|responses|body|raw|rawpayload|raw_payload)$/i;

/** 递归扫描禁止键（与 credential scan 同级 fail-closed）。 */
export function scanRawPayloadKeys(candidate: unknown, depth = 0): readonly string[] {
  const found: string[] = [];
  if (depth > 4 || candidate === null || typeof candidate !== 'object') return found;
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (RAW_PAYLOAD_KEY.test(key)) found.push(key);
    found.push(...scanRawPayloadKeys(value, depth + 1));
  }
  return found;
}

export interface OutcomeLineage {
  organizationId: string;
  taskId: string;
  actionRef: string;
  proposalRef: string;
  evidenceRef: string;
}

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
  /** U2：若给出，必须与本记录的 organization/task/refs 同链 */
  lineage?: OutcomeLineage | null;
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
  /** finalOutcome 派生：SUCCESS → true；FAILURE/REJECTED → false；其余（含 PARTIAL）→ null */
  success: boolean | null;
  /** UNKNOWN 用 null 表示，绝不降级为 false */
  humanIntervention: boolean | null;
  retryReconcile: RetryReconcileState;
  finalOutcome: FinalOutcome;
  actionRef: string;
  proposalRef: string;
  evidenceRef: string;
  digest: string;
}

export type OutcomeBuildResult = { ok: true; record: OutcomeRecord } | { ok: false; reason: string };
export type LineageBindingResult = { ok: true } | { ok: false; reason: string };

const required = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');

const optionalText = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** 严格：只接受真正的有限非负 number；字符串一律 INVALID（不做 Number() 强转）。 */
const nonNegativeNumber = (v: unknown): number | null | 'INVALID' => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 'INVALID';
  return v;
};

/** 严格：只接受真正的 boolean；字符串一律 INVALID（不做 "true"/"false" 强转）。 */
const optionalBoolean = (v: unknown): boolean | null | 'INVALID' => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v;
  return 'INVALID';
};

const enumOr = <T extends readonly string[]>(allowed: T, v: unknown, fallback: T[number]): T[number] | 'INVALID' => {
  if (v === undefined || v === null || v === '') return fallback;
  const s = typeof v === 'string' ? v : 'INVALID_VALUE';
  return (allowed as readonly string[]).includes(s) ? (s as T[number]) : 'INVALID';
};

/** finalOutcome 为 SSOT：派生 success 期望值。 */
const deriveSuccess = (finalOutcome: FinalOutcome): boolean | null => {
  if (finalOutcome === 'SUCCESS') return true;
  if (finalOutcome === 'FAILURE' || finalOutcome === 'REJECTED') return false;
  return null; // PARTIAL / MANUAL_REVIEW / UNKNOWN
};

/**
 * U2：校验 lineage 声明与 canonical 记录属于**同一条执行链**。
 * 仅证明引用存在是不够的，必须 organization/task/action/proposal/evidence 全部一致。
 */
export function verifyOutcomeLineage(record: OutcomeRecord, lineage: OutcomeLineage | null | undefined): LineageBindingResult {
  if (lineage === null || lineage === undefined || typeof lineage !== 'object') {
    return { ok: false, reason: 'OUTCOME_LINEAGE_DECLARATION_REQUIRED' };
  }
  const checks: Array<[string, string, string]> = [
    ['organizationId', required(lineage.organizationId), record.organizationId],
    ['taskId', required(lineage.taskId), record.taskId],
    ['actionRef', required(lineage.actionRef), record.actionRef],
    ['proposalRef', required(lineage.proposalRef), record.proposalRef],
    ['evidenceRef', required(lineage.evidenceRef), record.evidenceRef],
  ];
  for (const [field, declared, actual] of checks) {
    if (declared === '') return { ok: false, reason: 'OUTCOME_LINEAGE_DECLARATION_REQUIRED:' + field };
    if (declared !== actual) return { ok: false, reason: 'OUTCOME_LINEAGE_BINDING_MISMATCH:' + field };
  }
  return { ok: true };
}

/** 构建 canonical outcome 记录（fail-closed：任何违规都拒绝，不静默清洗、不做类型强转）。 */
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

  const rawPayloadKeys = scanRawPayloadKeys(raw);
  if (rawPayloadKeys.length > 0) {
    return { ok: false, reason: 'OUTCOME_RECORD_RAW_PAYLOAD_FORBIDDEN:' + rawPayloadKeys.join(',') };
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

  const humanIntervention = optionalBoolean(input.humanIntervention);
  const callerSuccess = optionalBoolean(input.success);
  if (humanIntervention === 'INVALID' || callerSuccess === 'INVALID') {
    return { ok: false, reason: 'OUTCOME_RECORD_BOOLEAN_FIELD_INVALID' };
  }

  const evidenceQuality = enumOr(EVIDENCE_QUALITIES, input.evidenceQuality, 'UNKNOWN');
  const retryReconcile = enumOr(RETRY_RECONCILE_STATES, input.retryReconcile, 'NONE');
  const finalOutcome = enumOr(FINAL_OUTCOMES, input.finalOutcome, 'UNKNOWN');
  if (evidenceQuality === 'INVALID' || retryReconcile === 'INVALID' || finalOutcome === 'INVALID') {
    return { ok: false, reason: 'OUTCOME_RECORD_ENUM_INVALID' };
  }

  // finalOutcome 为 SSOT：caller 传入的 success 必须与派生值一致（缺省则由 finalOutcome 派生）。
  const success = deriveSuccess(finalOutcome);
  if (callerSuccess !== null && callerSuccess !== success) {
    return { ok: false, reason: 'OUTCOME_RECORD_SUCCESS_CONFLICT' };
  }

  const record: Omit<OutcomeRecord, 'digest'> = {
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
    humanIntervention,
    retryReconcile,
    finalOutcome,
    actionRef,
    proposalRef,
    evidenceRef,
  };

  // U2：若给出 lineage 声明，必须与记录同链（binding，而非仅存在性）。
  if (input.lineage !== undefined && input.lineage !== null) {
    const binding = verifyOutcomeLineage({ ...record, digest: '' } as OutcomeRecord, input.lineage);
    if (!binding.ok) return { ok: false, reason: binding.reason };
  }

  const digest = 'outcome:' + createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 16);
  return { ok: true, record: { ...record, digest } };
}

export interface LearningDatasetProjection {
  recordCount: number;
  byDomain: Record<string, number>;
  byProvider: Record<string, number>;
  byFinalOutcome: Record<string, number>;
  successCount: number;
  failureCount: number;
  /** 分母 = 全部记录；U4 必须定义“未结论样本”口径后再用于评估 */
  successRate: number | null;
  totalRecoveryAmount: number;
  averageLatencyMs: number | null;
  totalInputCost: number;
  totalOutputCost: number;
  /** 只统计**明确 true**；null（UNKNOWN）不计入 */
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
    if (record.humanIntervention === true) humanInterventionCount += 1;
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
