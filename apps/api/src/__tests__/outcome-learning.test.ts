/**
 * PHASE 4 U1(FINAL) + U2 —— canonical outcome 契约（严格类型 / success SSOT / 递归 raw-payload 扫描）
 * + lineage binding + 只读学习数据集投影
 * 边界：只观察不改策略；不携带凭据 / 原始 payload；无生产写入。
 */

import { describe, expect, it } from 'vitest';

import {
  OUTCOME_DIMENSIONS,
  OUTCOME_LEARNING_BOUNDARY,
  buildOutcomeRecord,
  projectLearningDataset,
  scanRawPayloadKeys,
  verifyOutcomeLineage,
  type OutcomeLineage,
  type OutcomeRecord,
  type OutcomeRecordInput,
} from '../services/outcome-learning/outcome-record';

const input = (over: Partial<OutcomeRecordInput> = {}): OutcomeRecordInput => ({
  organizationId: 'org-1',
  taskId: 'task-1',
  taskType: 'recovery',
  domain: 'PLATFORM',
  provider: 'amazon',
  strategy: 'claim.submit',
  modelTier: 'cheap',
  inputCost: 0.01,
  outputCost: 0.02,
  latencyMs: 1200,
  evidenceQuality: 'STRONG',
  actionResult: 'SUBMITTED',
  rejectionReason: null,
  recoveryAmount: 42.5,
  success: true,
  humanIntervention: false,
  retryReconcile: 'NONE',
  finalOutcome: 'SUCCESS',
  actionRef: 'action:1',
  proposalRef: 'proposal:1',
  evidenceRef: 'action-evidence:1',
  ...over,
});

const built = (over: Partial<OutcomeRecordInput> = {}): OutcomeRecord => {
  const res = buildOutcomeRecord(input(over));
  if (!res.ok) throw new Error('unexpected reject: ' + res.reason);
  return res.record;
};

const rejected = (over: Partial<OutcomeRecordInput>): string => {
  const res = buildOutcomeRecord(input(over));
  if (res.ok) throw new Error('expected reject but accepted');
  return res.reason;
};

describe('PHASE 4 U1 —— canonical outcome 记录契约', () => {
  it('P4U1_1 十六个维度齐备，记录结构化且带稳定 digest', () => {
    const record = built();
    for (const dim of OUTCOME_DIMENSIONS) expect(Object.keys(record)).toContain(dim);
    expect(record.finalOutcome).toBe('SUCCESS');
    expect(record.success).toBe(true);
    expect(record.digest.startsWith('outcome:')).toBe(true);
    expect(built().digest).toBe(record.digest);
  });

  it('P4U1_2 身份字段缺失 → 拒绝（fail-closed，不静默清洗）', () => {
    for (const bad of [{ organizationId: '  ' }, { taskId: '' }, { taskType: '' }, { domain: '' }]) {
      expect(rejected(bad)).toBe('OUTCOME_RECORD_IDENTITY_REQUIRED');
    }
    expect(buildOutcomeRecord(null).ok).toBe(false);
  });

  it('P4U1_3 顶层原始 payload / provider 响应键 → 拒绝', () => {
    for (const key of ['payload', 'response', 'raw', 'body']) {
      expect(rejected({ [key]: 'x' } as never).startsWith('OUTCOME_RECORD_RAW_PAYLOAD_FORBIDDEN')).toBe(true);
    }
  });

  it('P4U1_14 嵌套（metadata.payload）原始载荷 → 递归扫描拒绝', () => {
    const nested = rejected({ metadata: { payload: 'x' } } as never);
    expect(nested.startsWith('OUTCOME_RECORD_RAW_PAYLOAD_FORBIDDEN')).toBe(true);
    expect(scanRawPayloadKeys({ a: { b: { c: { response: 'x' } } } })).toEqual(['response']);
    expect(scanRawPayloadKeys({ a: 1, b: 'x' })).toEqual([]);
  });

  it('P4U1_4 携带凭据字段 → 拒绝', () => {
    expect(rejected({ apiKey: 'sk-x' } as never).startsWith('OUTCOME_RECORD_CREDENTIAL_FIELDS_FORBIDDEN')).toBe(true);
  });

  it('P4U1_5 lineage 必须齐全（只引用不复制）', () => {
    for (const bad of [{ actionRef: '' }, { proposalRef: null }, { evidenceRef: '   ' }]) {
      expect(rejected(bad)).toBe('OUTCOME_RECORD_LINEAGE_REQUIRED');
    }
  });

  it('P4U1_6 数值必须有限非负；布尔与枚举非法 → 拒绝', () => {
    for (const bad of [{ latencyMs: -1 }, { inputCost: Number.POSITIVE_INFINITY }, { recoveryAmount: 'abc' }]) {
      expect(rejected(bad)).toBe('OUTCOME_RECORD_NUMERIC_FIELD_INVALID');
    }
    expect(rejected({ success: 'yes' as never })).toBe('OUTCOME_RECORD_BOOLEAN_FIELD_INVALID');
    expect(rejected({ finalOutcome: 'DONE' as never })).toBe('OUTCOME_RECORD_ENUM_INVALID');
  });

  it('P4U1_10 数值字符串不做强转（"1.23" → REJECT）', () => {
    for (const bad of [{ latencyMs: '1200' }, { inputCost: '1.23' }, { recoveryAmount: '42.5' }]) {
      expect(rejected(bad)).toBe('OUTCOME_RECORD_NUMERIC_FIELD_INVALID');
    }
  });

  it('P4U1_11 布尔字符串不做强转（"true"/"false" → REJECT）', () => {
    expect(rejected({ success: 'true' as never })).toBe('OUTCOME_RECORD_BOOLEAN_FIELD_INVALID');
    expect(rejected({ humanIntervention: 'false' as never })).toBe('OUTCOME_RECORD_BOOLEAN_FIELD_INVALID');
  });

  it('P4U1_12 humanIntervention 缺失 → null（UNKNOWN），不得降级为 false', () => {
    const record = built({ humanIntervention: undefined });
    expect(record.humanIntervention).toBe(null);
    expect(record.humanIntervention).not.toBe(false);
    const projection = projectLearningDataset([built({ humanIntervention: undefined }), built({ humanIntervention: true, taskId: 't2' })]);
    expect(projection.humanInterventionCount).toBe(1);
  });

  it('P4U1_13 success 与 finalOutcome 矛盾 → 拒绝（finalOutcome 为 SSOT）', () => {
    expect(rejected({ finalOutcome: 'FAILURE', success: true })).toBe('OUTCOME_RECORD_SUCCESS_CONFLICT');
    expect(rejected({ finalOutcome: 'REJECTED', success: true })).toBe('OUTCOME_RECORD_SUCCESS_CONFLICT');
    expect(rejected({ finalOutcome: 'SUCCESS', success: false })).toBe('OUTCOME_RECORD_SUCCESS_CONFLICT');
    expect(rejected({ finalOutcome: 'UNKNOWN', success: true })).toBe('OUTCOME_RECORD_SUCCESS_CONFLICT');
    expect(rejected({ finalOutcome: 'MANUAL_REVIEW', success: false })).toBe('OUTCOME_RECORD_SUCCESS_CONFLICT');
    expect(rejected({ finalOutcome: 'PARTIAL', success: true })).toBe('OUTCOME_RECORD_SUCCESS_CONFLICT');
  });

  it('P4U1_15 success 由 finalOutcome 派生（SUCCESS→true / FAILURE→false / PARTIAL→null）', () => {
    expect(built({ finalOutcome: 'SUCCESS', success: undefined }).success).toBe(true);
    expect(built({ finalOutcome: 'FAILURE', success: undefined }).success).toBe(false);
    expect(built({ finalOutcome: 'REJECTED', success: undefined }).success).toBe(false);
    expect(built({ finalOutcome: 'PARTIAL', success: undefined }).success).toBe(null);
    expect(built({ finalOutcome: 'MANUAL_REVIEW', success: null }).success).toBe(null);
    expect(built({ finalOutcome: 'UNKNOWN', success: undefined }).success).toBe(null);
  });

  it('P4U1_7 缺省枚举回落 UNKNOWN / NONE，缺省数值为 null', () => {
    const record = built({
      evidenceQuality: undefined,
      retryReconcile: undefined,
      finalOutcome: undefined,
      success: undefined,
      latencyMs: undefined,
    });
    expect(record.evidenceQuality).toBe('UNKNOWN');
    expect(record.retryReconcile).toBe('NONE');
    expect(record.finalOutcome).toBe('UNKNOWN');
    expect(record.success).toBe(null);
    expect(record.latencyMs).toBe(null);
  });
});

describe('PHASE 4 U2 —— lineage binding（同链证明）', () => {
  const lineage = (over: Partial<OutcomeLineage> = {}): OutcomeLineage => ({
    organizationId: 'org-1',
    taskId: 'task-1',
    actionRef: 'action:1',
    proposalRef: 'proposal:1',
    evidenceRef: 'action-evidence:1',
    ...over,
  });

  it('P4U2_1 声明与记录同链 → 通过；任一字段不一致 → REJECT', () => {
    const record = built({ lineage: lineage() });
    expect(verifyOutcomeLineage(record, lineage()).ok).toBe(true);

    for (const bad of ['taskId', 'evidenceRef', 'proposalRef', 'actionRef'] as const) {
      const mismatched = verifyOutcomeLineage(record, lineage({ [bad]: 'other' } as never));
      expect(mismatched.ok).toBe(false);
      if (!mismatched.ok) expect(mismatched.reason).toBe('OUTCOME_LINEAGE_BINDING_MISMATCH:' + bad);
    }
    const orgMismatch = verifyOutcomeLineage(record, lineage({ organizationId: 'org-2' }));
    expect(orgMismatch.ok).toBe(false);
    if (!orgMismatch.ok) expect(orgMismatch.reason).toBe('OUTCOME_LINEAGE_BINDING_MISMATCH:organizationId');
  });

  it('P4U2_2 构建时声明不同链 → REJECT；缺声明 → verify 拒绝', () => {
    expect(rejected({ lineage: { ...lineage(), taskId: 'task-x' } })).toBe('OUTCOME_LINEAGE_BINDING_MISMATCH:taskId');
    const missing = verifyOutcomeLineage(built(), null);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('OUTCOME_LINEAGE_DECLARATION_REQUIRED');
  });
});

describe('PHASE 4 U1 —— 只读学习数据集投影', () => {
  it('P4U1_8 聚合确定且不修改入参', () => {
    const records = [
      built(),
      built({ taskId: 'task-2', provider: 'tiktok', finalOutcome: 'FAILURE', success: false, recoveryAmount: 0 }),
      built({ taskId: 'task-3', domain: 'CUSTOMS', provider: null, finalOutcome: 'MANUAL_REVIEW', success: null, humanIntervention: true }),
    ];
    const snapshot = JSON.stringify(records);
    const projection = projectLearningDataset(records);
    expect(projection.recordCount).toBe(3);
    expect(projection.byDomain).toEqual({ PLATFORM: 2, CUSTOMS: 1 });
    expect(projection.byProvider).toEqual({ amazon: 1, tiktok: 1, UNKNOWN: 1 });
    expect(projection.successCount).toBe(1);
    expect(projection.failureCount).toBe(1);
    expect(projection.manualReviewCount).toBe(1);
    expect(projection.humanInterventionCount).toBe(1);
    expect(projection.totalRecoveryAmount).toBeCloseTo(85, 6);
    expect(projection.averageLatencyMs).toBe(1200);
    expect(projection.successRate).toBeCloseTo(1 / 3, 6);
    expect(JSON.stringify(records)).toBe(snapshot);
    expect(projectLearningDataset([])).toMatchObject({ recordCount: 0, successRate: null, averageLatencyMs: null });
  });

  it('P4U1_9 边界声明：只观察、不得自动改策略、AUTO_PROMOTION = OFF', () => {
    expect(OUTCOME_LEARNING_BOUNDARY.observationOnly).toBe(true);
    expect(OUTCOME_LEARNING_BOUNDARY.autoPolicyMutation).toBe('FORBIDDEN');
    expect(OUTCOME_LEARNING_BOUNDARY.autoPromotion).toBe('OFF');
    expect(OUTCOME_LEARNING_BOUNDARY.productionWrite).toBe('HOLD');
    expect(OUTCOME_LEARNING_BOUNDARY.secondMetaEvidenceStore).toContain('FORBIDDEN');
    expect(OUTCOME_LEARNING_BOUNDARY.strictTypes).toContain('ENFORCED');
    expect(OUTCOME_LEARNING_BOUNDARY.lineageBinding).toContain('ENFORCED');
  });
});
