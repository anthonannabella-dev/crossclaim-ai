/**
 * PHASE 4 U1 —— canonical outcome 记录契约 + 只读学习数据集投影
 * 边界：只观察不改策略；不携带凭据 / 原始 payload；无生产写入。
 */

import { describe, expect, it } from 'vitest';

import {
  OUTCOME_DIMENSIONS,
  OUTCOME_LEARNING_BOUNDARY,
  buildOutcomeRecord,
  projectLearningDataset,
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

describe('PHASE 4 U1 —— canonical outcome 记录契约', () => {
  it('P4U1_1 十六个维度齐备，记录结构化且带稳定 digest', () => {
    const record = built();
    for (const dim of OUTCOME_DIMENSIONS) expect(Object.keys(record)).toContain(dim);
    expect(record.finalOutcome).toBe('SUCCESS');
    expect(record.evidenceQuality).toBe('STRONG');
    expect(record.success).toBe(true);
    expect(record.digest.startsWith('outcome:')).toBe(true);
    expect(built().digest).toBe(record.digest);
  });

  it('P4U1_2 身份字段缺失 → 拒绝（fail-closed，不静默清洗）', () => {
    for (const bad of [{ organizationId: '  ' }, { taskId: '' }, { taskType: '' }, { domain: '' }]) {
      const res = buildOutcomeRecord(input(bad));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('OUTCOME_RECORD_IDENTITY_REQUIRED');
    }
    expect(buildOutcomeRecord(null).ok).toBe(false);
  });

  it('P4U1_3 原始 payload / provider 响应键 → 拒绝', () => {
    for (const key of ['payload', 'response', 'raw', 'body']) {
      const res = buildOutcomeRecord({ ...input(), [key]: 'x' } as never);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('OUTCOME_RECORD_RAW_PAYLOAD_FORBIDDEN');
    }
  });

  it('P4U1_4 携带凭据字段 → 拒绝', () => {
    const res = buildOutcomeRecord({ ...input(), apiKey: 'sk-x' } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason.startsWith('OUTCOME_RECORD_CREDENTIAL_FIELDS_FORBIDDEN')).toBe(true);
  });

  it('P4U1_5 lineage 必须齐全（只引用不复制）', () => {
    for (const bad of [{ actionRef: '' }, { proposalRef: null }, { evidenceRef: '   ' }]) {
      const res = buildOutcomeRecord(input(bad));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('OUTCOME_RECORD_LINEAGE_REQUIRED');
    }
  });

  it('P4U1_6 数值必须有限非负；布尔与枚举非法 → 拒绝', () => {
    for (const bad of [{ latencyMs: -1 }, { inputCost: Number.POSITIVE_INFINITY }, { recoveryAmount: 'abc' }]) {
      const res = buildOutcomeRecord(input(bad));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('OUTCOME_RECORD_NUMERIC_FIELD_INVALID');
    }
    const badBool = buildOutcomeRecord(input({ success: 'yes' as never }));
    expect(badBool.ok).toBe(false);
    if (!badBool.ok) expect(badBool.reason).toBe('OUTCOME_RECORD_BOOLEAN_FIELD_INVALID');
    const badEnum = buildOutcomeRecord(input({ finalOutcome: 'DONE' as never }));
    expect(badEnum.ok).toBe(false);
    if (!badEnum.ok) expect(badEnum.reason).toBe('OUTCOME_RECORD_ENUM_INVALID');
  });

  it('P4U1_7 缺省枚举回落 UNKNOWN / NONE，缺省数值为 null', () => {
    const record = built({ evidenceQuality: undefined, retryReconcile: undefined, finalOutcome: undefined, latencyMs: undefined });
    expect(record.evidenceQuality).toBe('UNKNOWN');
    expect(record.retryReconcile).toBe('NONE');
    expect(record.finalOutcome).toBe('UNKNOWN');
    expect(record.latencyMs).toBe(null);
  });
});

describe('PHASE 4 U1 —— 只读学习数据集投影', () => {
  it('P4U1_8 聚合确定且不修改入参', () => {
    const records = [
      built(),
      built({ taskId: 'task-2', provider: 'tiktok', finalOutcome: 'FAILURE', success: false, recoveryAmount: 0 }),
      built({ taskId: 'task-3', domain: 'CUSTOMS', provider: null, finalOutcome: 'MANUAL_REVIEW', humanIntervention: true }),
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
    // record 1 与 record 3 都继承基础 recoveryAmount=42.5，record 2 覆写为 0
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
  });
});
