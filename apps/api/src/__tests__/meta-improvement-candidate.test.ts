/**
 * PHASE 4 U5 —— Meta-improvement Candidate Proposal Only
 * verified learning evidence → verified offline evaluation → candidate proposal（PROPOSAL_ONLY）
 */

import { describe, expect, it } from 'vitest';

import { buildLearningEvidenceEntry, type LearningEvidenceEntry } from '../services/outcome-learning/learning-evidence';
import {
  META_CANDIDATE_BOUNDARY,
  META_CANDIDATE_RULES,
  META_CANDIDATE_STATUS,
  proposeMetaImprovementCandidates,
} from '../services/outcome-learning/meta-improvement-candidate';
import { evaluateVerifiedLearningRecords } from '../services/outcome-learning/offline-evaluation';
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

const evaluate = (records: readonly OutcomeRecord[], datasetVersion = DATASET) =>
  evaluateVerifiedLearningRecords(trustedLineage(), records, { datasetVersion });

const evidenceFor = (records: readonly OutcomeRecord[], datasetVersion = DATASET): LearningEvidenceEntry[] =>
  records.map((r) => buildLearningEvidenceEntry(r, datasetVersion));

/** 1 SUCCESS + 2 FAILURE + 2 UNKNOWN + 1 PARTIAL：resolved 3（成功率 1/3）、未判定 3/6、WEAK 证据 1 条。 */
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
  it('P4U5_1 verified evaluation + learning evidence → PROPOSAL_ONLY candidate（绑定 evaluationDigest / version / datasetVersion / evidence refs+digests / candidateDigest）', async () => {
    const records = troubledRecords();
    const evaluation = await evaluate(records);
    const result = proposeMetaImprovementCandidates({ evaluation, learningEvidence: evidenceFor(records.slice(1, 3)) });

    expect(result.candidateStatus).toBe(META_CANDIDATE_STATUS);
    expect(result.insufficientData).toBe(false);
    expect(result.reason).toBe(null);
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.candidateStatus).toBe('PROPOSAL_ONLY');
      expect(candidate.candidateId).toBe(candidate.candidateDigest);
      expect(candidate.candidateDigest.startsWith('meta-candidate:')).toBe(true);
      expect(candidate.evaluationDigest).toBe(evaluation.evaluationDigest);
      expect(candidate.evaluationVersion).toBe(evaluation.evaluationVersion);
      expect(candidate.datasetVersion).toBe(DATASET);
      expect(candidate.sourceEvidence.count).toBe(2);
      expect(candidate.sourceEvidence.evidenceDigests).toHaveLength(2);
      expect(candidate.sourceEvidence.outcomeDigests).toHaveLength(2);
      expect(candidate.sourceEvidence.evidenceRefs).toEqual(['evidence:1', 'evidence:1']);
      expect(candidate.metricsSnapshot.resolvedDenominator).toBe(evaluation.resolved.denominator);
      expect(candidate.requiresApproval).toBe(true);
      expect(candidate.autoApply).toBe(false);
    }
  });

  it('P4U5_2 信任门复用 isVerifiedOfflineEvaluation：caller 构造 / 展开副本的评估 → REJECT', async () => {
    const records = troubledRecords();
    const verified = await evaluate(records);
    const clone = { ...verified };
    const evidence = evidenceFor(records.slice(1, 2));

    expect(() => proposeMetaImprovementCandidates({ evaluation: clone, learningEvidence: evidence })).toThrow(
      /META_CANDIDATE_EVALUATION_NOT_VERIFIED/,
    );
    expect(() => proposeMetaImprovementCandidates(null)).toThrow(/META_CANDIDATE_INPUT_REQUIRED/);
    expect(META_CANDIDATE_BOUNDARY.trustGate).toBe('isVerifiedOfflineEvaluation(evaluation) === true');
  });

  it('P4U5_3 输入不足（分母 0 / insufficientData）→ 零 candidate + 显式 insufficient 语义', async () => {
    const records = [record({ finalOutcome: 'UNKNOWN' }), record({ finalOutcome: 'MANUAL_REVIEW' })];
    const evaluation = await evaluate(records);
    expect(evaluation.insufficientData).toBe(true);
    const result = proposeMetaImprovementCandidates({ evaluation, learningEvidence: evidenceFor(records.slice(0, 1)) });
    expect(result.candidates).toHaveLength(0);
    expect(result.insufficientData).toBe(true);
    expect(result.reason).toBe('META_CANDIDATE_INSUFFICIENT_DATA');
    expect(META_CANDIDATE_BOUNDARY.insufficientData).toContain('NO_CANDIDATE');
  });

  it('P4U5_4 fail-closed：证据缺失 / 畸形 / datasetVersion 不一致 / 证据数超过评估记录数 → REJECT', async () => {
    const records = healthyRecords();
    const evaluation = await evaluate(records);

    expect(() => proposeMetaImprovementCandidates({ evaluation, learningEvidence: [] })).toThrow(
      /META_CANDIDATE_EVIDENCE_REQUIRED/,
    );
    const malformed = [{ ...evidenceFor(records.slice(0, 1))[0], evidenceDigest: '  ' }] as LearningEvidenceEntry[];
    expect(() => proposeMetaImprovementCandidates({ evaluation, learningEvidence: malformed })).toThrow(
      /META_CANDIDATE_EVIDENCE_MALFORMED/,
    );
    const wrongDataset = evidenceFor(records.slice(0, 1), 'learning-dataset/v2');
    expect(() => proposeMetaImprovementCandidates({ evaluation, learningEvidence: wrongDataset })).toThrow(
      /META_CANDIDATE_DATASET_VERSION_MISMATCH/,
    );
    const tooMany = evidenceFor(records.concat(record({ taskType: 'recovery-e' })));
    expect(() => proposeMetaImprovementCandidates({ evaluation, learningEvidence: tooMany })).toThrow(
      /META_CANDIDATE_EVIDENCE_EXCEEDS_EVALUATION/,
    );
  });

  it('P4U5_5 规则触发：低成功率 → ROUTER；未判定占比偏高 → POLICY；WEAK/MISSING 证据 → GUARD', async () => {
    const records = troubledRecords();
    const evaluation = await evaluate(records);
    const result = proposeMetaImprovementCandidates({ evaluation, learningEvidence: evidenceFor(records.slice(1, 3)) });
    const byRule = new Map(result.candidates.map((c) => [c.rule, c]));

    expect(byRule.get('LOW_RESOLVED_SUCCESS_RATE')?.target).toBe('ROUTER');
    expect(byRule.get('LOW_RESOLVED_SUCCESS_RATE')?.observed).toBeCloseTo(1 / 3, 10);
    expect(byRule.get('LOW_RESOLVED_SUCCESS_RATE')?.threshold).toBe(0.5);
    expect(byRule.get('HIGH_UNRESOLVED_SHARE')?.target).toBe('POLICY');
    expect(byRule.get('HIGH_UNRESOLVED_SHARE')?.observed).toBeCloseTo(0.5, 10);
    expect(byRule.get('WEAK_OR_MISSING_EVIDENCE_PRESENT')?.target).toBe('GUARD');
    expect(byRule.get('WEAK_OR_MISSING_EVIDENCE_PRESENT')?.observed).toBe(1);
    expect(result.candidates).toHaveLength(META_CANDIDATE_RULES.length);
  });

  it('P4U5_6 健康数据（成功率 1、未判定 0、无弱证据）→ 无 candidate，且非 insufficient', async () => {
    const records = healthyRecords();
    const evaluation = await evaluate(records);
    const result = proposeMetaImprovementCandidates({ evaluation, learningEvidence: evidenceFor(records.slice(0, 1)) });
    expect(result.candidates).toHaveLength(0);
    expect(result.insufficientData).toBe(false);
    expect(result.reason).toBe(null);
  });

  it('P4U5_7 确定性 + 摘要绑定：同输入同 candidateDigest；证据集变化 → candidateDigest 变化；evaluation 不被修改', async () => {
    const records = troubledRecords();
    const evaluation = await evaluate(records);
    const before = JSON.stringify(evaluation);
    const oneEvidence = proposeMetaImprovementCandidates({ evaluation, learningEvidence: evidenceFor(records.slice(1, 2)) });
    const oneEvidenceAgain = proposeMetaImprovementCandidates({
      evaluation,
      learningEvidence: evidenceFor(records.slice(1, 2)),
    });
    const twoEvidence = proposeMetaImprovementCandidates({ evaluation, learningEvidence: evidenceFor(records.slice(1, 3)) });
    expect(oneEvidence.candidates.map((c) => c.candidateDigest)).toEqual(
      oneEvidenceAgain.candidates.map((c) => c.candidateDigest),
    );
    expect(oneEvidence.candidates[0]?.candidateDigest).not.toBe(twoEvidence.candidates[0]?.candidateDigest);
    expect(JSON.stringify(evaluation)).toBe(before);
    expect(META_CANDIDATE_BOUNDARY.binds).toContain('sourceEvidenceDigests');
    expect(META_CANDIDATE_BOUNDARY.binds).toContain('candidateDigest');
  });

  it('P4U5_8 proposal-only 边界：无 apply/promote 入口，四类 mutation 全部 FORBIDDEN，采用需外部 Judge / 人工批准', async () => {
    const mod = (await import('../services/outcome-learning/meta-improvement-candidate')) as unknown as Record<
      string,
      unknown
    >;
    for (const key of ['applyCandidate', 'applyMetaImprovementCandidate', 'promoteCandidate', 'mutatePolicy', 'mutateGuard', 'mutateRouter', 'executeCandidate']) {
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

    const records = troubledRecords();
    const evaluation = await evaluate(records);
    const result = proposeMetaImprovementCandidates({ evaluation, learningEvidence: evidenceFor(records.slice(1, 2)) });
    for (const candidate of result.candidates) {
      expect(candidate.mutation).toEqual({
        policy: 'FORBIDDEN',
        guard: 'FORBIDDEN',
        router: 'FORBIDDEN',
        actionRuntime: 'FORBIDDEN',
      });
      expect(candidate.adoption).toBe('EXTERNAL_JUDGE_OR_HUMAN_APPROVAL_REQUIRED');
    }
  });
});
