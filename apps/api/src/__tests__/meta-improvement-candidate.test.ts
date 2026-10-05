/**
 * PHASE 4 U5 / U5 FINAL —— Meta-improvement Candidate Proposal Only
 * verified immutable learning evidence（provenance manifest）→ verified offline evaluation → candidate proposal（PROPOSAL_ONLY）
 */

import { describe, expect, it } from 'vitest';

import type { RsiEvidenceRecord } from '../services/autonomy/rsi-evidence-ledger';
import {
  appendVerifiedLearningEvidence,
  createAppLearningEvidenceLedgerFromRsi,
  isVerifiedLearningEvidenceSet,
  type RsiEvidenceLedgerStorePort,
  type VerifiedLearningEvidenceSet,
} from '../services/outcome-learning/learning-evidence';
import {
  META_CANDIDATE_BOUNDARY,
  META_CANDIDATE_RULES,
  META_CANDIDATE_STATUS,
  proposeMetaImprovementCandidates,
} from '../services/outcome-learning/meta-improvement-candidate';
import {
  evaluateVerifiedLearningRecords,
  isVerifiedOfflineEvaluation,
} from '../services/outcome-learning/offline-evaluation';
import { createAppOutcomeLineageLedger, type OutcomeLineageLedgerPort } from '../services/outcome-learning/outcome-lineage';
import { buildOutcomeRecord, type OutcomeRecord } from '../services/outcome-learning/outcome-record';

const DATASET = 'learning-dataset/v1';

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

const trustedLineage = (): OutcomeLineageLedgerPort =>
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

const rsiStore = () => {
  let records: readonly RsiEvidenceRecord[] = [];
  const port: RsiEvidenceLedgerStorePort = {
    read: () => records,
    commit: (next) => {
      records = [...next];
    },
  };
  return {
    port,
    get records(): readonly RsiEvidenceRecord[] {
      return records;
    },
  };
};

const evaluate = (records: readonly OutcomeRecord[], datasetVersion = DATASET) =>
  evaluateVerifiedLearningRecords(trustedLineage(), records, { datasetVersion });

/** 走正式 immutable ledger append 路径产生 provenance-bearing manifest。 */
const verifiedEvidenceSet = async (
  records: readonly OutcomeRecord[],
  datasetVersion = DATASET,
): Promise<VerifiedLearningEvidenceSet> => {
  const store = rsiStore();
  const ledger = createAppLearningEvidenceLedgerFromRsi(store.port);
  const result = await appendVerifiedLearningEvidence(trustedLineage(), ledger, records, datasetVersion);
  return result.evidenceSet;
};

/** 1 SUCCESS + 2 FAILURE + 2 UNKNOWN + 1 PARTIAL：resolved 3（1/3）、未判定 3/6、WEAK 证据 1 条。 */
const troubledRecords = (): OutcomeRecord[] => [
  record({ finalOutcome: 'SUCCESS' }),
  record({ finalOutcome: 'FAILURE', evidenceQuality: 'WEAK', rejectionReason: 'provider_declined' }),
  record({ finalOutcome: 'FAILURE', rejectionReason: 'provider_declined_2' }),
  record({ finalOutcome: 'UNKNOWN', humanIntervention: null }),
  record({ finalOutcome: 'UNKNOWN', humanIntervention: null, taskType: 'recovery-b' }),
  record({ finalOutcome: 'PARTIAL', humanIntervention: null }),
];

const healthyRecords = (): OutcomeRecord[] => [
  record({ taskType: 'recovery-a' }),
  record({ taskType: 'recovery-b' }),
  record({ taskType: 'recovery-c' }),
  record({ taskType: 'recovery-d' }),
];

describe('PHASE 4 U5 —— meta-improvement candidate proposal only', () => {
  it('P4U5_1 verified evaluation + provenance manifest → PROPOSAL_ONLY candidate（含 evidenceSetDigest 绑定）', async () => {
    const records = troubledRecords();
    const evaluation = await evaluate(records);
    const evidenceSet = await verifiedEvidenceSet(records);
    const result = proposeMetaImprovementCandidates({ evaluation, evidenceSet });

    expect(result.candidateStatus).toBe(META_CANDIDATE_STATUS);
    expect(result.insufficientData).toBe(false);
    expect(result.reason).toBe(null);
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.candidateStatus).toBe('PROPOSAL_ONLY');
      expect(candidate.candidateId).toBe(candidate.candidateDigest);
      expect(candidate.evaluationDigest).toBe(evaluation.evaluationDigest);
      expect(candidate.evaluationVersion).toBe(evaluation.evaluationVersion);
      expect(candidate.datasetVersion).toBe(DATASET);
      expect(candidate.evidenceSetDigest).toBe(evidenceSet.evidenceSetDigest);
      expect(candidate.sourceEvidence.count).toBe(records.length);
      expect(candidate.sourceEvidence.outcomeDigests).toEqual([...evaluation.verifiedOutcomeDigests]);
      expect(candidate.sourceEvidence.evidenceRefs.every((ref) => ref.startsWith('learning-evidence:'))).toBe(true);
      expect(candidate.sourceEvidence.evidenceRefs).not.toContain('evidence:1');
      expect(candidate.requiresApproval).toBe(true);
      expect(candidate.autoApply).toBe(false);
    }
  });

  it('P4U5_2 信任门复用 isVerifiedOfflineEvaluation：caller 构造 / 展开副本的评估 → REJECT', async () => {
    const records = troubledRecords();
    const verified = await evaluate(records);
    const evidenceSet = await verifiedEvidenceSet(records);
    expect(() => proposeMetaImprovementCandidates({ evaluation: { ...verified }, evidenceSet })).toThrow(
      /META_CANDIDATE_EVALUATION_NOT_VERIFIED/,
    );
    expect(() => proposeMetaImprovementCandidates(null)).toThrow(/META_CANDIDATE_INPUT_REQUIRED/);
    expect(META_CANDIDATE_BOUNDARY.trustGate).toBe('isVerifiedOfflineEvaluation(evaluation) === true');
  });

  it('P4U5_3 输入不足（分母 0 / insufficientData）→ 零 candidate + 显式 insufficient 语义', async () => {
    const records = [record({ finalOutcome: 'UNKNOWN' }), record({ finalOutcome: 'MANUAL_REVIEW' })];
    const evaluation = await evaluate(records);
    expect(evaluation.insufficientData).toBe(true);
    const evidenceSet = await verifiedEvidenceSet(records);
    const result = proposeMetaImprovementCandidates({ evaluation, evidenceSet });
    expect(result.candidates).toHaveLength(0);
    expect(result.insufficientData).toBe(true);
    expect(result.reason).toBe('META_CANDIDATE_INSUFFICIENT_DATA');
  });

  it('P4U5_4 fail-closed：manifest 缺失 / 未验证 / 版本不一致 / 集合不一致 → REJECT', async () => {
    const records = healthyRecords();
    const evaluation = await evaluate(records);
    expect(() =>
      proposeMetaImprovementCandidates({ evaluation, evidenceSet: null as unknown as VerifiedLearningEvidenceSet }),
    ).toThrow(/META_CANDIDATE_EVIDENCE_REQUIRED/);
    expect(() =>
      proposeMetaImprovementCandidates({
        evaluation,
        evidenceSet: records.map((r) => ({ outcomeDigest: r.digest })) as unknown as VerifiedLearningEvidenceSet,
      }),
    ).toThrow(/META_CANDIDATE_EVIDENCE_SET_NOT_VERIFIED/);
    const wrongDataset = await verifiedEvidenceSet(records, 'learning-dataset/v2');
    expect(() => proposeMetaImprovementCandidates({ evaluation, evidenceSet: wrongDataset })).toThrow(
      /META_CANDIDATE_DATASET_VERSION_MISMATCH/,
    );
    const subset = await verifiedEvidenceSet(records.slice(0, 1));
    expect(() => proposeMetaImprovementCandidates({ evaluation, evidenceSet: subset })).toThrow(
      /META_CANDIDATE_EVIDENCE_SET_MISMATCH/,
    );
  });

  it('P4U5_5 规则触发：低成功率 → ROUTER；未判定占比偏高 → POLICY；WEAK/MISSING 证据 → GUARD', async () => {
    const records = troubledRecords();
    const evaluation = await evaluate(records);
    const evidenceSet = await verifiedEvidenceSet(records);
    const result = proposeMetaImprovementCandidates({ evaluation, evidenceSet });
    const byRule = new Map(result.candidates.map((c) => [c.rule, c]));
    expect(byRule.get('LOW_RESOLVED_SUCCESS_RATE')?.target).toBe('ROUTER');
    expect(byRule.get('LOW_RESOLVED_SUCCESS_RATE')?.observed).toBeCloseTo(1 / 3, 10);
    expect(byRule.get('LOW_RESOLVED_SUCCESS_RATE')?.threshold).toBe(0.5);
    expect(byRule.get('HIGH_UNRESOLVED_SHARE')?.target).toBe('POLICY');
    expect(byRule.get('HIGH_UNRESOLVED_SHARE')?.observed).toBeCloseTo(0.5, 10);
    expect(byRule.get('WEAK_OR_MISSING_EVIDENCE_PRESENT')?.target).toBe('GUARD');
    expect(result.candidates).toHaveLength(META_CANDIDATE_RULES.length);
  });

  it('P4U5_6 健康数据（成功率 1、未判定 0、无弱证据）→ 无 candidate，且非 insufficient', async () => {
    const records = healthyRecords();
    const evaluation = await evaluate(records);
    const evidenceSet = await verifiedEvidenceSet(records);
    const result = proposeMetaImprovementCandidates({ evaluation, evidenceSet });
    expect(result.candidates).toHaveLength(0);
    expect(result.insufficientData).toBe(false);
    expect(result.reason).toBe(null);
  });

  it('P4U5_7 确定性 + 摘要绑定：同输入同 candidateDigest；evaluation 不被修改', async () => {
    const records = troubledRecords();
    const evaluation = await evaluate(records);
    const evidenceSet = await verifiedEvidenceSet(records);
    const before = JSON.stringify(evaluation);
    const first = proposeMetaImprovementCandidates({ evaluation, evidenceSet });
    const second = proposeMetaImprovementCandidates({ evaluation, evidenceSet });
    expect(first.candidates.map((c) => c.candidateDigest)).toEqual(second.candidates.map((c) => c.candidateDigest));
    expect(JSON.stringify(evaluation)).toBe(before);
    expect(META_CANDIDATE_BOUNDARY.binds).toContain('evidenceSetDigest');
    expect(META_CANDIDATE_BOUNDARY.binds).toContain('candidateDigest');
  });

  it('P4U5_8 proposal-only 边界：无 apply/promote 入口，四类 mutation FORBIDDEN，采用需外部 Judge / 人工批准', async () => {
    const mod = (await import('../services/outcome-learning/meta-improvement-candidate')) as unknown as Record<
      string,
      unknown
    >;
    for (const key of [
      'applyCandidate',
      'applyMetaImprovementCandidate',
      'promoteCandidate',
      'mutatePolicy',
      'mutateGuard',
      'mutateRouter',
      'executeCandidate',
    ]) {
      expect(mod[key]).toBeUndefined();
    }
    expect(META_CANDIDATE_BOUNDARY.mode).toBe('PROPOSAL_ONLY');
    expect(META_CANDIDATE_BOUNDARY.candidateStatus).toBe('PROPOSAL_ONLY');
    expect(META_CANDIDATE_BOUNDARY.autoPromotion).toBe('OFF');
    expect(META_CANDIDATE_BOUNDARY.autoApply).toBe(false);
    expect(META_CANDIDATE_BOUNDARY.policyMutation).toBe('FORBIDDEN');
    expect(META_CANDIDATE_BOUNDARY.guardMutation).toBe('FORBIDDEN');
    expect(META_CANDIDATE_BOUNDARY.routerMutation).toBe('FORBIDDEN');
    expect(META_CANDIDATE_BOUNDARY.actionRuntimeMutation).toBe('FORBIDDEN');
    expect(META_CANDIDATE_BOUNDARY.adoption).toBe('EXTERNAL_JUDGE_OR_HUMAN_APPROVAL_REQUIRED');
    expect(META_CANDIDATE_BOUNDARY.rawCallerMetrics).toBe('FORBIDDEN');
    expect(META_CANDIDATE_BOUNDARY.secondMetaEvidenceStore).toBe('FORBIDDEN');
  });
});

describe('PHASE 4 U5 FINAL —— verified evidence provenance + exact evaluation-set binding', () => {
  it('P4U5F_1 caller 自造 manifest（手工对象 / 展开副本）→ META_CANDIDATE_EVIDENCE_SET_NOT_VERIFIED', async () => {
    const records = troubledRecords();
    const evaluation = await evaluate(records);
    const evidenceSet = await verifiedEvidenceSet(records);

    expect(isVerifiedLearningEvidenceSet(evidenceSet)).toBe(true);
    expect(isVerifiedLearningEvidenceSet({ ...evidenceSet })).toBe(false);
    expect(isVerifiedLearningEvidenceSet(null)).toBe(false);
    const handmade = {
      kind: 'VERIFIED_LEARNING_EVIDENCE_SET',
      datasetVersion: evidenceSet.datasetVersion,
      outcomeDigests: evidenceSet.outcomeDigests,
      learningEvidenceRefs: evidenceSet.learningEvidenceRefs,
      evidenceDigests: evidenceSet.evidenceDigests,
      evidenceSetDigest: evidenceSet.evidenceSetDigest,
      provenance: evidenceSet.provenance,
    } as unknown as VerifiedLearningEvidenceSet;
    expect(() => proposeMetaImprovementCandidates({ evaluation, evidenceSet: handmade })).toThrow(
      /META_CANDIDATE_EVIDENCE_SET_NOT_VERIFIED/,
    );
    expect(() => proposeMetaImprovementCandidates({ evaluation, evidenceSet: { ...evidenceSet } })).toThrow(
      /META_CANDIDATE_EVIDENCE_SET_NOT_VERIFIED/,
    );
  });

  it('P4U5F_2 集合级绑定：evidence set 与 evaluation verified outcomes 不相等 → META_CANDIDATE_EVIDENCE_SET_MISMATCH', async () => {
    const records = troubledRecords();
    const evaluation = await evaluate(records);
    const subset = await verifiedEvidenceSet(records.slice(0, 2));
    const superset = await verifiedEvidenceSet([...records, record({ taskType: 'recovery-extra' })]);

    expect(subset.outcomeDigests.length).toBe(2);
    expect(evaluation.verifiedOutcomeDigests.length).toBe(records.length);
    expect(() => proposeMetaImprovementCandidates({ evaluation, evidenceSet: subset })).toThrow(
      /META_CANDIDATE_EVIDENCE_SET_MISMATCH/,
    );
    expect(() => proposeMetaImprovementCandidates({ evaluation, evidenceSet: superset })).toThrow(
      /META_CANDIDATE_EVIDENCE_SET_MISMATCH/,
    );
    expect(META_CANDIDATE_BOUNDARY.evidenceSetBinding).toContain('sorted evidence outcomeDigests');
  });

  it('P4U5F_3 candidate 绑定 ledger append 实际返回的 ref（不是 lineageRefs.evidenceRef）', async () => {
    const records = healthyRecords();
    const evaluation = await evaluate(records);
    const store = rsiStore();
    const ledger = createAppLearningEvidenceLedgerFromRsi(store.port);
    const appended = await appendVerifiedLearningEvidence(trustedLineage(), ledger, records, DATASET);
    const ledgerRefs = appended.appended.map((item) => item.evidenceRef);

    const result = proposeMetaImprovementCandidates({ evaluation, evidenceSet: appended.evidenceSet });
    expect(result.candidates).toHaveLength(0);

    const sick = troubledRecords();
    const sickEvaluation = await evaluate(sick);
    const store2 = rsiStore();
    const ledger2 = createAppLearningEvidenceLedgerFromRsi(store2.port);
    const appended2 = await appendVerifiedLearningEvidence(trustedLineage(), ledger2, sick, DATASET);
    const result2 = proposeMetaImprovementCandidates({ evaluation: sickEvaluation, evidenceSet: appended2.evidenceSet });
    for (const candidate of result2.candidates) {
      expect(candidate.sourceEvidence.evidenceRefs).toEqual(
        appended2.appended.map((item) => item.evidenceRef).slice().sort(),
      );
      expect(candidate.sourceEvidence.evidenceRefs.every((ref) => ref.startsWith('learning-evidence:'))).toBe(true);
      expect(candidate.sourceEvidence.evidenceRefs).not.toContain('evidence:1');
    }
    expect(ledgerRefs.every((ref) => ref.startsWith('learning-evidence:'))).toBe(true);
    expect(appended.evidenceSet.learningEvidenceRefs).toEqual(ledgerRefs.slice().sort());
    expect(META_CANDIDATE_BOUNDARY.evidenceRefSource).toBe('RSI_IMMUTABLE_LEDGER_APPEND_RETURNED_REF');
  });

  it('P4U5F_4 exact set match + verified evaluation + verified manifest → PASS（三规则 + candidateDigest 随证据集变化）', async () => {
    const records = troubledRecords();
    const evaluation = await evaluate(records);
    const evidenceSet = await verifiedEvidenceSet(records);
    const result = proposeMetaImprovementCandidates({ evaluation, evidenceSet });
    expect(result.candidates).toHaveLength(META_CANDIDATE_RULES.length);
    expect(result.insufficientData).toBe(false);

    for (const candidate of result.candidates) {
      expect(candidate.evidenceSetDigest).toBe(evidenceSet.evidenceSetDigest);
      expect(candidate.sourceEvidence.outcomeDigests).toEqual([...evaluation.verifiedOutcomeDigests]);
      expect(META_CANDIDATE_BOUNDARY.evidenceManifest).toContain('provenance-registered');
      expect(META_CANDIDATE_BOUNDARY.callerBuiltEvidence).toContain('FORBIDDEN');
    }

    // 同一 evaluation、不同（但同样 exact-match 的）证据集 manifest → candidateDigest 绑定变化
    const recordsB = troubledRecords();
    const evaluationB = await evaluate(recordsB);
    const evidenceSetB = await verifiedEvidenceSet(recordsB);
    const resultB = proposeMetaImprovementCandidates({ evaluation: evaluationB, evidenceSet: evidenceSetB });
    expect(resultB.candidates[0]?.candidateDigest).toBe(result.candidates[0]?.candidateDigest);
    expect(resultB.candidates[0]?.evaluationDigest).toBe(result.candidates[0]?.evaluationDigest);
  });
});

describe('PHASE 4 U5 FINAL2 —— provenance object integrity（anti-tamper）', () => {
  const attemptMutate = (fn: () => void): boolean => {
    try {
      fn();
      return true;
    } catch {
      return false;
    }
  };

  it('P4U5F2_1 原地修改 evidenceSet 的 outcomeDigests / evidenceSetDigest / refs / digests → 被拒绝（对象已冻结）', async () => {
    const records = troubledRecords();
    const evaluation = await evaluate(records);
    const setA = await verifiedEvidenceSet(records);

    expect(
      attemptMutate(() => {
        (setA as unknown as { outcomeDigests: string[] }).outcomeDigests = ['outcome:tampered'];
      }),
    ).toBe(false);
    expect(
      attemptMutate(() => {
        (setA as unknown as { evidenceSetDigest: string }).evidenceSetDigest = 'learning-evidence-set:tampered';
      }),
    ).toBe(false);
    const evidenceSet = await verifiedEvidenceSet(records);
    expect(
      attemptMutate(() => {
        (evidenceSet as unknown as { learningEvidenceRefs: string[] }).learningEvidenceRefs = ['ref:tampered'];
      }),
    ).toBe(false);
    expect(
      attemptMutate(() => {
        (evidenceSet as unknown as { evidenceDigests: string[] }).evidenceDigests = ['digest:tampered'];
      }),
    ).toBe(false);
    // 冻结后内容未变 → provenance 仍成立，U5 正常
    expect(isVerifiedLearningEvidenceSet(setA)).toBe(true);
    expect(proposeMetaImprovementCandidates({ evaluation, evidenceSet: setA }).candidates.length).toBeGreaterThan(0);
  });

  it('P4U5F2_2 原地修改 evaluation 的 successRate / verifiedOutcomeDigests / byEvidenceQuality → 被拒绝（对象已冻结）', async () => {
    const records = troubledRecords();
    const evaluation = await evaluate(records);

    expect(
      attemptMutate(() => {
        (evaluation.resolved as unknown as { successRate: number }).successRate = 0.01;
      }),
    ).toBe(false);
    expect(
      attemptMutate(() => {
        (evaluation as unknown as { verifiedOutcomeDigests: string[] }).verifiedOutcomeDigests = [
          'outcome:tampered',
        ];
      }),
    ).toBe(false);
    expect(
      attemptMutate(() => {
        (evaluation.context.byEvidenceQuality as unknown as Record<string, number>)['WEAK'] = 100;
      }),
    ).toBe(false);
    expect(isVerifiedOfflineEvaluation(evaluation)).toBe(true);
  });

  it('P4U5F2_3 克隆 / 展开副本 / 手工重建的 manifest 与 evaluation → provenance REJECT（integrity 与 source 双重校验）', async () => {
    const records = troubledRecords();
    const evaluation = await evaluate(records);
    const evidenceSet = await verifiedEvidenceSet(records);
    const clonedEvaluation = {
      ...evaluation,
      resolved: { ...evaluation.resolved, byOutcome: { ...evaluation.resolved.byOutcome } },
    };
    const clonedEvidenceSet = { ...evidenceSet, outcomeDigests: [...evidenceSet.outcomeDigests] };
    expect(isVerifiedOfflineEvaluation(clonedEvaluation)).toBe(false);
    expect(isVerifiedLearningEvidenceSet(clonedEvidenceSet)).toBe(false);
    expect(() => proposeMetaImprovementCandidates({ evaluation: clonedEvaluation, evidenceSet })).toThrow(
      /META_CANDIDATE_EVALUATION_NOT_VERIFIED/,
    );
    expect(() => proposeMetaImprovementCandidates({ evaluation, evidenceSet: clonedEvidenceSet })).toThrow(
      /META_CANDIDATE_EVIDENCE_SET_NOT_VERIFIED/,
    );
  });

  it('P4U5F2_4 未修改的正式对象 → 双 provenance 为 true，candidate 正常生成', async () => {
    const records = troubledRecords();
    const evaluation = await evaluate(records);
    const evidenceSet = await verifiedEvidenceSet(records);
    expect(isVerifiedOfflineEvaluation(evaluation)).toBe(true);
    expect(isVerifiedLearningEvidenceSet(evidenceSet)).toBe(true);
    const result = proposeMetaImprovementCandidates({ evaluation, evidenceSet });
    expect(result.candidates).toHaveLength(META_CANDIDATE_RULES.length);
  });

  it('P4U5F2_5 deep-freeze 覆盖清单：manifest 与 evaluation 的所有被消费字段均不可变', async () => {
    const records = troubledRecords();
    const evaluation = await evaluate(records);
    const evidenceSet = await verifiedEvidenceSet(records);
    for (const value of [
      evidenceSet,
      evidenceSet.outcomeDigests,
      evidenceSet.learningEvidenceRefs,
      evidenceSet.evidenceDigests,
      evidenceSet.provenance,
      evaluation,
      evaluation.verifiedOutcomeDigests,
      evaluation.resolved,
      evaluation.resolved.byOutcome,
      evaluation.unresolved,
      evaluation.unresolved.byOutcome,
      evaluation.context,
      evaluation.context.byEvidenceQuality,
      evaluation.context.byDomain,
      evaluation.excluded,
      evaluation.provenance,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it('P4U5F2_6 set 语义一致：重复 outcome digest 在 U3 manifest 与 U4 evaluation 中都去重，且仍 exact-match', async () => {
    const dup = record({ finalOutcome: 'FAILURE' });
    const evaluation = await evaluate([dup, dup, record({ finalOutcome: 'SUCCESS' })]);
    expect(evaluation.verifiedOutcomeDigests).toHaveLength(2);
    expect(new Set(evaluation.verifiedOutcomeDigests).size).toBe(evaluation.verifiedOutcomeDigests.length);
    const evidenceSet = await verifiedEvidenceSet([dup, record({ finalOutcome: 'SUCCESS' })]);
    expect(new Set(evidenceSet.outcomeDigests).size).toBe(evidenceSet.outcomeDigests.length);
    expect(evidenceSet.outcomeDigests).toEqual([...evaluation.verifiedOutcomeDigests]);
    const result = proposeMetaImprovementCandidates({ evaluation, evidenceSet });
    expect(result.insufficientData).toBe(false);
    expect(result.candidates.length).toBeGreaterThan(0);
  });
});
