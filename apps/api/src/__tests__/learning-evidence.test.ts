/**
 * PHASE 4 U3 FINAL —— learning evidence 接线既有 RSI immutable evidence ledger
 * （append-only / EVIDENCE_IMMUTABLE 由既有 ledger 裁定；无裸 append callback）
 */

import { describe, expect, it } from 'vitest';

import type { RsiEvidenceRecord } from '../services/autonomy/rsi-evidence-ledger';
import {
  LEARNING_DATASET_VERSION,
  LEARNING_EVIDENCE_BOUNDARY,
  appendVerifiedLearningEvidence,
  buildLearningEvidenceEntry,
  buildVerifiedLearningProjection,
  createAppLearningEvidenceLedgerFromRsi,
  isAppLearningEvidenceLedger,
  type LearningEvidenceLedgerPort,
  type RsiEvidenceLedgerStorePort,
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

/** 既有 RSI evidence ledger store 的内存实现（模拟 server-owned composition 注入的持久化）。 */
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

describe('PHASE 4 U3 FINAL —— 接线既有 RSI immutable evidence ledger', () => {
  it('P4U3F_1 条目绑定四项且稳定；datasetVersion 空 → REJECT', () => {
    const a = buildLearningEvidenceEntry(record());
    expect(a.outcomeDigest).toBe(record().digest);
    expect(a.lineageRefs).toEqual({ actionRef: 'action:1', proposalRef: 'proposal:1', evidenceRef: 'evidence:1' });
    expect(a.datasetVersion).toBe(LEARNING_DATASET_VERSION);
    expect(a.evidenceDigest).toBe(buildLearningEvidenceEntry(record()).evidenceDigest);
    expect(buildLearningEvidenceEntry(record({ taskId: 'task-2' })).evidenceDigest).not.toBe(a.evidenceDigest);
    expect(() => buildLearningEvidenceEntry(record(), '')).toThrow(/LEARNING_EVIDENCE_DATASET_VERSION_REQUIRED/);
    expect(() => buildLearningEvidenceEntry(record(), '   ')).toThrow(/LEARNING_EVIDENCE_DATASET_VERSION_REQUIRED/);
  });

  it('P4U3F_2 正式 adapter 确实经既有 RSI ledger 追加（映射为 RsiEvidenceRecord）', async () => {
    const store = rsiStore();
    const ledger = createAppLearningEvidenceLedgerFromRsi(store.port);
    expect(isAppLearningEvidenceLedger(ledger)).toBe(true);
    const entry = buildLearningEvidenceEntry(record());
    const written = await ledger.append(entry);
    expect(written.evidenceRef).toBe(entry.evidenceDigest);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]?.evidenceId).toBe(entry.evidenceDigest);
    expect(store.records[0]?.kind).toBe('METRIC_RESULT');
    expect(store.records[0]?.subjectRef).toBe('outcome:' + entry.outcomeDigest);
    expect(store.records[0]?.producedBy).toBe('outcome-learning');
    expect(store.records[0]?.supersedesId).toBe(null);
  });

  it('P4U3F_3 重复写同 evidenceDigest → 既有 ledger 以 EVIDENCE_IMMUTABLE 拒绝（不产生第二条）', async () => {
    const store = rsiStore();
    const ledger = createAppLearningEvidenceLedgerFromRsi(store.port);
    const entry = buildLearningEvidenceEntry(record());
    await ledger.append(entry);
    await expect(ledger.append(entry)).rejects.toThrow(/LEARNING_EVIDENCE_LEDGER_REJECTED:EVIDENCE_IMMUTABLE/);
    expect(store.records).toHaveLength(1);
  });

  it('P4U3F_4 不同 outcome → 可追加新 evidence，且原记录不被覆盖/删除', async () => {
    const store = rsiStore();
    const ledger = createAppLearningEvidenceLedgerFromRsi(store.port);
    const first = buildLearningEvidenceEntry(record());
    const second = buildLearningEvidenceEntry(record({ recoveryAmount: 20 }));
    await ledger.append(first);
    const before = JSON.stringify(store.records[0]);
    await ledger.append(second);
    expect(store.records).toHaveLength(2);
    expect(JSON.stringify(store.records[0])).toBe(before);
    expect(store.records[0]?.evidenceId).toBe(first.evidenceDigest);
    expect(store.records[1]?.evidenceId).toBe(second.evidenceDigest);
  });

  it('P4U3F_5 caller 自写 fake ledger / 裸 append callback 无法被洗白', async () => {
    const fake: LearningEvidenceLedgerPort = {
      async append() {
        return { evidenceRef: 'fake' };
      },
    };
    expect(isAppLearningEvidenceLedger(fake)).toBe(false);
    await expect(appendVerifiedLearningEvidence(trustedLineage(), fake, [record()])).rejects.toThrow(
      /LEARNING_EVIDENCE_LEDGER_NOT_TRUSTED/,
    );
    await expect(appendVerifiedLearningEvidence(trustedLineage(), null, [record()])).rejects.toThrow(
      /APP_LEARNING_EVIDENCE_LEDGER_REQUIRED/,
    );
    expect(() => createAppLearningEvidenceLedgerFromRsi({} as never)).toThrow(
      /APP_LEARNING_EVIDENCE_MISSING_RSI_STORE/,
    );
  });

  it('P4U3F_6 datasetVersion 空 → 整批 REJECT（零写入）', async () => {
    const store = rsiStore();
    const ledger = createAppLearningEvidenceLedgerFromRsi(store.port);
    await expect(appendVerifiedLearningEvidence(trustedLineage(), ledger, [record()], '  ')).rejects.toThrow(
      /LEARNING_EVIDENCE_DATASET_VERSION_REQUIRED/,
    );
    expect(store.records).toHaveLength(0);
  });

  it('P4U3F_7 unverified lineage → 零 evidence 写入（skipped 显式记录）', async () => {
    const store = rsiStore();
    const ledger = createAppLearningEvidenceLedgerFromRsi(store.port);
    const bad = record({ taskId: 'task-x', actionRef: 'action:x', proposalRef: 'proposal:x', evidenceRef: 'evidence:x' });
    const result = await appendVerifiedLearningEvidence(trustedLineage(), ledger, [bad]);
    expect(result.appended).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('OUTCOME_LINEAGE_TASK_MISMATCH');
    expect(store.records).toHaveLength(0);
  });

  it('P4U3F_8 verified 投影 + verified-only append 正常路径（原 6/6 语义保持）', async () => {
    const store = rsiStore();
    const ledger = createAppLearningEvidenceLedgerFromRsi(store.port);
    const good = record();
    const bad = record({ taskId: 'task-x', actionRef: 'action:x', proposalRef: 'proposal:x', evidenceRef: 'evidence:x' });
    const projection = await buildVerifiedLearningProjection(trustedLineage(), [good, bad]);
    expect(projection.projection.recordCount).toBe(1);
    expect(projection.excluded).toHaveLength(1);
    const appended = await appendVerifiedLearningEvidence(trustedLineage(), ledger, [good, bad]);
    expect(appended.appended).toHaveLength(1);
    expect(appended.skipped).toHaveLength(1);
    expect(store.records).toHaveLength(1);
    expect(LEARNING_EVIDENCE_BOUNDARY.store).toBe('REUSE_EXISTING_RSI_EVIDENCE_LEDGER');
    expect(LEARNING_EVIDENCE_BOUNDARY.bareAppendCallback).toBe('FORBIDDEN');
    expect(LEARNING_EVIDENCE_BOUNDARY.secondMetaEvidenceStore).toBe('FORBIDDEN');
    expect(LEARNING_EVIDENCE_BOUNDARY.verifiedOnly).toBe(true);
    expect(LEARNING_EVIDENCE_BOUNDARY.autoPromotion).toBe('OFF');
  });
});
