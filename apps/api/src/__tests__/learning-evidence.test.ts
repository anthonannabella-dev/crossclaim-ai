/**
 * PHASE 4 U3 —— learning projection + immutable learning evidence（verified-only / append-only / 复用既有 ledger）
 */

import { describe, expect, it } from 'vitest';

import {
  LEARNING_DATASET_VERSION,
  LEARNING_EVIDENCE_BOUNDARY,
  appendVerifiedLearningEvidence,
  buildLearningEvidenceEntry,
  buildVerifiedLearningProjection,
  createAppLearningEvidenceLedger,
  isAppLearningEvidenceLedger,
  type LearningEvidenceEntry,
  type LearningEvidenceLedgerPort,
} from '../services/outcome-learning/learning-evidence';
import { createAppOutcomeLineageLedger } from '../services/outcome-learning/outcome-lineage';
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

const collecting = () => {
  const entries: LearningEvidenceEntry[] = [];
  const ledger = createAppLearningEvidenceLedger({
    async append(entry) {
      entries.push(entry);
      return { evidenceRef: 'learning-evidence-ref:' + entries.length };
    },
  });
  return { entries, ledger };
};

describe('PHASE 4 U3 —— immutable learning evidence（verified-only / append-only）', () => {
  it('P4U3_1 条目绑定 outcomeDigest + lineage refs + datasetVersion + evidenceDigest（稳定且随输入变化）', () => {
    const a = buildLearningEvidenceEntry(record());
    const b = buildLearningEvidenceEntry(record());
    expect(a.outcomeDigest).toBe(record().digest);
    expect(a.lineageRefs).toEqual({ actionRef: 'action:1', proposalRef: 'proposal:1', evidenceRef: 'evidence:1' });
    expect(a.datasetVersion).toBe(LEARNING_DATASET_VERSION);
    expect(a.evidenceDigest).toBe(b.evidenceDigest);
    const different = buildLearningEvidenceEntry(record({ taskId: 'task-2' }));
    expect(different.evidenceDigest).not.toBe(a.evidenceDigest);
    const otherVersion = buildLearningEvidenceEntry(record(), 'learning-dataset/v2');
    expect(otherVersion.evidenceDigest).not.toBe(a.evidenceDigest);
  });

  it('P4U3_2 fake evidence ledger / 缺失 ledger → fail-closed（零写入）', async () => {
    const fake: LearningEvidenceLedgerPort = {
      async append() {
        return { evidenceRef: 'x' };
      },
    };
    expect(isAppLearningEvidenceLedger(fake)).toBe(false);
    await expect(appendVerifiedLearningEvidence(trustedLineage(), fake, [record()])).rejects.toThrow(
      /LEARNING_EVIDENCE_LEDGER_NOT_TRUSTED/,
    );
    await expect(appendVerifiedLearningEvidence(trustedLineage(), null, [record()])).rejects.toThrow(
      /APP_LEARNING_EVIDENCE_LEDGER_REQUIRED/,
    );
  });

  it('P4U3_3 未过 trusted lineage binding 的记录绝不写入（skipped 而非静默纳入）', async () => {
    const { entries, ledger } = collecting();
    const bad = record({ taskId: 'task-x', actionRef: 'action:x', proposalRef: 'proposal:x', evidenceRef: 'evidence:x' });
    const result = await appendVerifiedLearningEvidence(trustedLineage(), ledger, [record(), bad]);
    expect(result.appended).toHaveLength(1);
    expect(result.appended[0]?.outcomeDigest).toBe(record().digest);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.digest).toBe(bad.digest);
    expect(result.skipped[0]?.reason).toBe('OUTCOME_LINEAGE_TASK_MISMATCH');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcomeDigest).toBe(record().digest);
  });

  it('P4U3_4 verified 记录逐条 append（append-only，不覆盖；同链不同 outcome 各写一条）', async () => {
    const { entries, ledger } = collecting();
    const result = await appendVerifiedLearningEvidence(trustedLineage(), ledger, [
      record(),
      record({ recoveryAmount: 20 }),
    ]);
    expect(result.appended.map((a) => a.evidenceRef)).toEqual(['learning-evidence-ref:1', 'learning-evidence-ref:2']);
    expect(result.skipped).toHaveLength(0);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.outcomeDigest).not.toBe(entries[1]?.outcomeDigest);
  });

  it('P4U3_5 verified 学习投影：只投影通过 binding 的记录，并列出被排除项', async () => {
    const bad = record({ taskId: 'task-x', actionRef: 'action:x', proposalRef: 'proposal:x', evidenceRef: 'evidence:x' });
    const res = await buildVerifiedLearningProjection(trustedLineage(), [record(), bad]);
    expect(res.projection.recordCount).toBe(1);
    expect(res.verifiedRecords.map((r) => r.taskId)).toEqual(['task-1']);
    expect(res.excluded).toHaveLength(1);
  });

  it('P4U3_6 边界声明：复用既有 ledger、禁止第二证据存储、append-only、AUTO_PROMOTION = OFF', () => {
    expect(LEARNING_EVIDENCE_BOUNDARY.store).toBe('REUSE_EXISTING_EVIDENCE_LEDGER');
    expect(LEARNING_EVIDENCE_BOUNDARY.secondMetaEvidenceStore).toBe('FORBIDDEN');
    expect(LEARNING_EVIDENCE_BOUNDARY.appendOnly).toBe(true);
    expect(LEARNING_EVIDENCE_BOUNDARY.verifiedOnly).toBe(true);
    expect(LEARNING_EVIDENCE_BOUNDARY.binds).toEqual([
      'outcomeDigest',
      'lineageRefs',
      'datasetVersion',
      'evidenceDigest',
    ]);
    expect(LEARNING_EVIDENCE_BOUNDARY.autoPolicyMutation).toBe('FORBIDDEN');
    expect(LEARNING_EVIDENCE_BOUNDARY.autoPromotion).toBe('OFF');
  });
});
