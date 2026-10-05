/**
 * PHASE 4 U4 —— Offline Evaluation（显式 resolved denominator）
 * 口径：resolved = SUCCESS + FAILURE + REJECTED；PARTIAL / MANUAL_REVIEW / UNKNOWN 单独报告，不入分母。
 */

import { describe, expect, it } from 'vitest';

import {
  OFFLINE_EVALUATION_BOUNDARY,
  OFFLINE_EVALUATION_VERSION,
  OFFLINE_FORBIDDEN_METRIC_KEYS,
  OFFLINE_METRIC_DEFINITIONS,
  RESOLVED_OUTCOMES,
  UNRESOLVED_OUTCOMES,
  evaluateOfflineOutcomes,
  evaluateVerifiedLearningRecords,
} from '../services/outcome-learning/offline-evaluation';
import { createAppOutcomeLineageLedger, type OutcomeLineageLedgerPort } from '../services/outcome-learning/outcome-lineage';
import { buildOutcomeRecord, type OutcomeRecord } from '../services/outcome-learning/outcome-record';

const record = (over: Record<string, unknown> = {}): OutcomeRecord => {
  const res = buildOutcomeRecord({
    organizationId: 'org-1',
    taskId: 'task-1',
    taskType: 'recovery',
    domain: 'PLATFORM',
    provider: 'amazon',
    latencyMs: 1200,
    evidenceQuality: 'STRONG',
    recoveryAmount: 10,
    humanIntervention: false,
    retryReconcile: 'NONE',
    finalOutcome: 'SUCCESS',
    actionRef: 'action:1',
    proposalRef: 'proposal:1',
    evidenceRef: 'evidence:1',
    ...over,
  });
  if (!res.ok) throw new Error('unexpected reject: ' + res.reason);
  return res.record;
};

const trustedLineage = () =>
  createAppOutcomeLineageLedger({
    actions: {
      async findRef() {
        return { organizationId: 'org-1', taskId: 'task-1' };
      },
    },
    proposals: {
      async findRef() {
        return { organizationId: 'org-1', taskId: 'task-1', actionRef: 'action:1', evidenceRef: 'evidence:1' };
      },
    },
    evidence: {
      async findRef() {
        return { organizationId: 'org-1', taskId: 'task-1' };
      },
    },
  });

/** 3 SUCCESS + 1 FAILURE + 2 REJECTED + 1 PARTIAL + 1 MANUAL_REVIEW + 1 UNKNOWN = 9 条，resolved = 6。 */
const mixedDataset = (): OutcomeRecord[] => [
  record({ taskType: 'recovery-a' }),
  record({ taskType: 'recovery-b' }),
  record({ taskType: 'recovery-c' }),
  record({ finalOutcome: 'FAILURE', rejectionReason: 'provider_declined' }),
  record({ finalOutcome: 'REJECTED', rejectionReason: 'policy_rejected' }),
  record({ finalOutcome: 'REJECTED', rejectionReason: 'guard_rejected' }),
  record({ finalOutcome: 'PARTIAL', humanIntervention: null }),
  record({ finalOutcome: 'MANUAL_REVIEW', humanIntervention: true }),
  record({ finalOutcome: 'UNKNOWN', humanIntervention: null }),
];

describe('PHASE 4 U4 —— Offline Evaluation（显式 resolved denominator）', () => {
  it('P4U4_1 口径：resolved = SUCCESS + FAILURE + REJECTED，成功率为 successCount / resolved（不是 / 全部记录）', () => {
    const result = evaluateOfflineOutcomes(mixedDataset());
    expect(result.resolved.denominatorKind).toBe('RESOLVED');
    expect(result.resolved.denominator).toBe(6);
    expect(result.resolved.byOutcome).toEqual({ SUCCESS: 3, FAILURE: 1, REJECTED: 2 });
    expect(result.resolved.successRate).toBeCloseTo(3 / 6, 10);
    expect(result.resolved.failureRate).toBeCloseTo(3 / 6, 10);
    expect(result.resolved.rejectedRate).toBeCloseTo(2 / 6, 10);
    expect(result.totalRecords).toBe(9);
    // 旧口径（successCount / allRecords）必须与正式指标不同，证明它没有被用作分母
    expect(result.resolved.successRate).not.toBeCloseTo(3 / 9, 10);
    expect(OFFLINE_EVALUATION_BOUNDARY.resolvedDenominator).toBe('SUCCESS + FAILURE + REJECTED');
  });

  it('P4U4_2 PARTIAL / MANUAL_REVIEW / UNKNOWN 单独报告，且明确排除在 success-rate 分母之外', () => {
    const result = evaluateOfflineOutcomes(mixedDataset());
    expect(result.unresolved.excludedFromSuccessRate).toBe(true);
    expect(result.unresolved.count).toBe(3);
    expect(result.unresolved.byOutcome).toEqual({ PARTIAL: 1, MANUAL_REVIEW: 1, UNKNOWN: 1 });
    expect(result.unresolvedShareOfAllRecords).toBeCloseTo(3 / 9, 10);
    // 分母只由 resolved 构成：把未判定记录混进总分母会得到 3/9，这里必须是 3/6
    expect(result.resolved.denominator).toBe(9 - result.unresolved.count);
    expect(RESOLVED_OUTCOMES).toEqual(['SUCCESS', 'FAILURE', 'REJECTED']);
    expect(UNRESOLVED_OUTCOMES).toEqual(['PARTIAL', 'MANUAL_REVIEW', 'UNKNOWN']);
    expect(OFFLINE_EVALUATION_BOUNDARY.unresolvedInSuccessRateDenominator).toBe('FORBIDDEN');
  });

  it('P4U4_3 分母为 0 → successRate = null（不伪造成 0），insufficientData = true', () => {
    const onlyUnresolved = [record({ finalOutcome: 'UNKNOWN' }), record({ finalOutcome: 'MANUAL_REVIEW' })];
    const result = evaluateOfflineOutcomes(onlyUnresolved);
    expect(result.resolved.denominator).toBe(0);
    expect(result.resolved.defined).toBe(false);
    expect(result.resolved.successRate).toBe(null);
    expect(result.resolved.failureRate).toBe(null);
    expect(result.resolved.rejectedRate).toBe(null);
    expect(result.insufficientData).toBe(true);
    expect(OFFLINE_EVALUATION_BOUNDARY.zeroDenominator).toContain('NULL_NOT_ZERO');
  });

  it('P4U4_4 空数据集 → totalRecords 0、分母 0、unresolvedShare = null、insufficientData = true', () => {
    const result = evaluateOfflineOutcomes([]);
    expect(result.totalRecords).toBe(0);
    expect(result.resolved.denominator).toBe(0);
    expect(result.resolved.successRate).toBe(null);
    expect(result.unresolvedShareOfAllRecords).toBe(null);
    expect(result.insufficientData).toBe(true);
  });

  it('P4U4_5 fail-closed：非数组输入 / 未知 finalOutcome / datasetVersion 空白 → REJECT', () => {
    expect(() => evaluateOfflineOutcomes(null)).toThrow(/OFFLINE_EVALUATION_RECORDS_REQUIRED/);
    expect(() => evaluateOfflineOutcomes(undefined)).toThrow(/OFFLINE_EVALUATION_RECORDS_REQUIRED/);
    const bogus = { ...record(), finalOutcome: 'SOMETHING_ELSE' } as unknown as OutcomeRecord;
    expect(() => evaluateOfflineOutcomes([bogus])).toThrow(/OFFLINE_EVALUATION_UNKNOWN_FINAL_OUTCOME:SOMETHING_ELSE/);
    expect(() => evaluateOfflineOutcomes([], { datasetVersion: '' })).toThrow(
      /OFFLINE_EVALUATION_DATASET_VERSION_REQUIRED/,
    );
    expect(() => evaluateOfflineOutcomes([], { datasetVersion: '   ' })).toThrow(
      /OFFLINE_EVALUATION_DATASET_VERSION_REQUIRED/,
    );
  });

  it('P4U4_6 datasetVersion 绑定进结果；evaluationDigest 稳定且随输入变化', () => {
    const a = evaluateOfflineOutcomes(mixedDataset(), { datasetVersion: 'learning-dataset/v1' });
    const b = evaluateOfflineOutcomes(mixedDataset(), { datasetVersion: 'learning-dataset/v1' });
    const c = evaluateOfflineOutcomes(mixedDataset(), { datasetVersion: 'learning-dataset/v2' });
    const d = evaluateOfflineOutcomes([record({ finalOutcome: 'FAILURE' })], { datasetVersion: 'learning-dataset/v1' });
    expect(a.datasetVersion).toBe('learning-dataset/v1');
    expect(a.evaluationVersion).toBe(OFFLINE_EVALUATION_VERSION);
    expect(a.evaluationDigest).toBe(b.evaluationDigest);
    expect(a.evaluationDigest).not.toBe(c.evaluationDigest);
    expect(a.evaluationDigest).not.toBe(d.evaluationDigest);
  });

  it('P4U4_7 verified-only：未通过 trusted lineage binding 的记录不进入评估，且不改写输入', async () => {
    const good = record();
    const bad = record({
      taskId: 'task-x',
      actionRef: 'action:x',
      proposalRef: 'proposal:x',
      evidenceRef: 'evidence:x',
      finalOutcome: 'FAILURE',
    });
    const before = JSON.stringify([good, bad]);
    const result = await evaluateVerifiedLearningRecords(trustedLineage(), [good, bad]);
    expect(result.totalRecords).toBe(1);
    expect(result.resolved.denominator).toBe(1);
    expect(result.resolved.successRate).toBe(1);
    expect(result.excludedCount).toBe(1);
    expect(result.excluded[0]?.reason).toBe('OUTCOME_LINEAGE_TASK_MISMATCH');
    expect(JSON.stringify([good, bad])).toBe(before);
    expect(OFFLINE_EVALUATION_BOUNDARY.verifiedOnly).toBe(true);
  });

  it('P4U4_8 verified 入口 fail-closed：ledger 缺失 / caller 自写 ledger → REJECT（不返回 0 分母结果）', async () => {
    const fake: OutcomeLineageLedgerPort = {
      async loadAction() {
        return { organizationId: 'org-1', taskId: 'task-1' };
      },
      async loadProposal() {
        return { organizationId: 'org-1', taskId: 'task-1', actionRef: 'action:1', evidenceRef: 'evidence:1' };
      },
      async loadEvidence() {
        return { organizationId: 'org-1', taskId: 'task-1' };
      },
    };
    await expect(evaluateVerifiedLearningRecords(null, [record()])).rejects.toThrow(
      /OFFLINE_EVALUATION_LINEAGE_LEDGER_REQUIRED/,
    );
    await expect(evaluateVerifiedLearningRecords(fake, [record()])).rejects.toThrow(
      /OFFLINE_EVALUATION_LINEAGE_LEDGER_NOT_TRUSTED/,
    );
  });

  it('P4U4_9 指标契约：禁止 all-records 成功率；离线/无网络/无自动晋升；humanIntervention 只计明确 true', () => {
    const result = evaluateOfflineOutcomes(mixedDataset());
    for (const key of OFFLINE_FORBIDDEN_METRIC_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(result, key)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(result.resolved, key)).toBe(false);
    }
    const successRateDefinition = OFFLINE_METRIC_DEFINITIONS.find((m) => m.key === 'successRate');
    expect(successRateDefinition?.definition).toBe('successCount / resolvedDenominator');
    expect(successRateDefinition?.denominator).toContain('RESOLVED');
    expect(OFFLINE_EVALUATION_BOUNDARY.forbiddenMetric).toContain('allRecords');
    expect(OFFLINE_EVALUATION_BOUNDARY.offline).toBe(true);
    expect(OFFLINE_EVALUATION_BOUNDARY.network).toBe('FORBIDDEN');
    expect(OFFLINE_EVALUATION_BOUNDARY.realModelCalls).toBe('FORBIDDEN');
    expect(OFFLINE_EVALUATION_BOUNDARY.autoPromotion).toBe('OFF');
    expect(OFFLINE_EVALUATION_BOUNDARY.autoPolicyMutation).toBe('FORBIDDEN');
    expect(OFFLINE_EVALUATION_BOUNDARY.secondMetaEvidenceStore).toBe('FORBIDDEN');
    // humanIntervention 只统计明确 true：PARTIAL/UNKNOWN 的 null 不计入
    expect(result.context.humanInterventionCount).toBe(1);
    expect(result.context.byEvidenceQuality['STRONG']).toBe(9);
    expect(result.context.byDomain['PLATFORM']).toBe(9);
  });
});
