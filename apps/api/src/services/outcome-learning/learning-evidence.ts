/**
 * PHASE 4 U3 FINAL —— Learning Dataset + Immutable Learning Evidence（接线既有 RSI evidence ledger）
 * ---------------------------------------------------------------
 * 链路（裁决 MSG-20261005-59/60）：canonical outcome → trusted lineage verified → learning projection
 *   → **既有 immutable evidence ledger**（`services/autonomy/rsi-evidence-ledger.ts::appendRsiEvidence`）。
 *
 * 硬约束：
 *   - **不再接受裸 append callback**：learning evidence 只能经正式 adapter 走既有
 *     `appendRsiEvidence()`，其 EVIDENCE_IMMUTABLE / supersedes / append-only 语义是唯一权威。
 *   - 只复用既有 evidence ledger；**禁止**建立 SECOND_META_EVIDENCE_STORE。
 *   - 只有通过 trusted lineage binding 的记录才可写入（未验证记录显式跳过）。
 *   - immutable evidence 至少绑定：outcomeDigest + lineage refs + dataset version + evidence digest。
 *   - 只观察：不修改 Policy / Guard / Router / Action Runtime；AUTO_PROMOTION = OFF。
 */

import { createHash } from 'node:crypto';

import { appendRsiEvidence, type RsiEvidenceRecord } from '../autonomy/rsi-evidence-ledger';
import { verifyLearningRecord, type OutcomeLineageLedgerPort } from './outcome-lineage';
import { projectLearningDataset, type LearningDatasetProjection, type OutcomeRecord } from './outcome-record';

export const LEARNING_DATASET_VERSION = 'learning-dataset/v1';

export const LEARNING_EVIDENCE_BOUNDARY = {
  store: 'REUSE_EXISTING_RSI_EVIDENCE_LEDGER',
  ledgerOwner: 'services/autonomy/rsi-evidence-ledger.ts::appendRsiEvidence',
  bareAppendCallback: 'FORBIDDEN',
  secondMetaEvidenceStore: 'FORBIDDEN',
  appendOnly: true,
  verifiedOnly: true,
  binds: ['outcomeDigest', 'lineageRefs', 'datasetVersion', 'evidenceDigest'],
  autoPolicyMutation: 'FORBIDDEN',
  autoPromotion: 'OFF',
  observationOnly: true,
} as const;

/** immutable learning evidence 条目（只引用，不复制原始事实）。 */
export interface LearningEvidenceEntry {
  organizationId: string;
  taskId: string;
  outcomeDigest: string;
  lineageRefs: { actionRef: string; proposalRef: string; evidenceRef: string };
  datasetVersion: string;
  evidenceDigest: string;
}

/** 既有 evidence ledger 的 append-only 端口（由正式 composition 注入）。 */
export interface LearningEvidenceLedgerPort {
  append(entry: LearningEvidenceEntry): Promise<{ evidenceRef: string }>;
}

/** 既有 RSI evidence ledger 的读/提交适配端口（server-owned composition 注入）。 */
export interface RsiEvidenceLedgerStorePort {
  read(): readonly RsiEvidenceRecord[];
  commit(records: readonly RsiEvidenceRecord[]): void;
}

const APP_LEARNING_EVIDENCE_LEDGERS = new WeakSet<LearningEvidenceLedgerPort>();
const APP_VERIFIED_LEARNING_EVIDENCE_SETS = new WeakSet<VerifiedLearningEvidenceSet>();
const APP_VERIFIED_LEARNING_EVIDENCE_FINGERPRINTS = new WeakMap<VerifiedLearningEvidenceSet, string>();

/** 对象完整性：冻结所有被 U5 消费的字段（仅冻结顶层不够）。 */
const freezeEvidenceSet = (set: VerifiedLearningEvidenceSet): void => {
  Object.freeze(set.outcomeDigests);
  Object.freeze(set.learningEvidenceRefs);
  Object.freeze(set.evidenceDigests);
  Object.freeze(set.provenance);
  Object.freeze(set);
};

/** canonical fingerprint：覆盖 U5 实际消费的所有字段（U5 FINAL2 anti-tamper）。 */
const evidenceSetFingerprint = (set: VerifiedLearningEvidenceSet): string =>
  JSON.stringify({
    kind: set.kind,
    datasetVersion: set.datasetVersion,
    outcomeDigests: [...set.outcomeDigests],
    learningEvidenceRefs: [...set.learningEvidenceRefs],
    evidenceDigests: [...set.evidenceDigests],
    evidenceSetDigest: set.evidenceSetDigest,
    provenanceKind: set.provenance && set.provenance.kind,
    ledgerOwner: set.provenance && set.provenance.ledgerOwner,
    verifiedOnly: set.provenance && set.provenance.verifiedOnly,
  });

const sortedUnique = (values: readonly string[]): string[] =>
  Array.from(new Set(values)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** 只读 provenance：只有正式 adapter 产出的 evidence ledger 才可信。 */
export function isAppLearningEvidenceLedger(ledger: LearningEvidenceLedgerPort): boolean {
  return APP_LEARNING_EVIDENCE_LEDGERS.has(ledger);
}

/**
 * U5 FINAL：provenance-bearing verified learning evidence manifest。
 * 只能由 appendVerifiedLearningEvidence() 在**成功经既有 immutable ledger 落账**后登记产生；
 * caller 自造对象 / 展开副本一律不具备 provenance。
 */
export interface VerifiedLearningEvidenceSet {
  kind: 'VERIFIED_LEARNING_EVIDENCE_SET';
  datasetVersion: string;
  /** sorted + 去重 */
  outcomeDigests: readonly string[];
  /** sorted：**immutable ledger append 实际返回的 ref**（不是 lineageRefs.evidenceRef） */
  learningEvidenceRefs: readonly string[];
  evidenceDigests: readonly string[];
  evidenceSetDigest: string;
  provenance: {
    kind: 'RSI_IMMUTABLE_LEDGER_APPEND';
    ledgerOwner: 'services/autonomy/rsi-evidence-ledger.ts::appendRsiEvidence';
    verifiedOnly: true;
  };
}

/** 只读 provenance：只有成功落账路径产生的 manifest 才为 true。 */
export function isVerifiedLearningEvidenceSet(
  set: VerifiedLearningEvidenceSet | null | undefined,
): boolean {
  if (set === null || set === undefined) return false;
  if (!APP_VERIFIED_LEARNING_EVIDENCE_SETS.has(set)) return false;
  const fingerprint = APP_VERIFIED_LEARNING_EVIDENCE_FINGERPRINTS.get(set);
  if (fingerprint === undefined) return false;
  try {
    // 不仅查 identity：重算 canonical fingerprint，原地篡改（即便内容被手工改成匹配）一律失败
    return fingerprint === evidenceSetFingerprint(set);
  } catch {
    return false;
  }
}

/**
 * 正式 adapter：把 learning evidence 映射为既有 RSI evidence record，
 * 并经**既有** `appendRsiEvidence()` 追加 —— 重复 evidenceId 由既有 ledger 拒绝（EVIDENCE_IMMUTABLE）。
 */
export function createAppLearningEvidenceLedgerFromRsi(
  store: RsiEvidenceLedgerStorePort,
): LearningEvidenceLedgerPort {
  if (!store || typeof store.read !== 'function' || typeof store.commit !== 'function') {
    throw new Error('APP_LEARNING_EVIDENCE_MISSING_RSI_STORE');
  }
  const ledger: LearningEvidenceLedgerPort = {
    async append(entry: LearningEvidenceEntry) {
      const next: RsiEvidenceRecord = {
        evidenceId: entry.evidenceDigest,
        kind: 'METRIC_RESULT',
        subjectRef: 'outcome:' + entry.outcomeDigest,
        digest: entry.evidenceDigest,
        recordedAt: new Date().toISOString(),
        producedBy: 'outcome-learning',
        supersedesId: null,
      };
      const result = appendRsiEvidence(store.read(), next);
      if (!result.ok) {
        throw new Error('LEARNING_EVIDENCE_LEDGER_REJECTED:' + result.reason);
      }
      store.commit(result.records);
      return { evidenceRef: next.evidenceId };
    },
  };
  APP_LEARNING_EVIDENCE_LEDGERS.add(ledger);
  return ledger;
}

/**
 * 构建 immutable learning evidence 条目：绑定 outcomeDigest + lineage refs + datasetVersion + evidenceDigest。
 * datasetVersion 必须 non-empty / non-whitespace。
 */
export function buildLearningEvidenceEntry(
  record: OutcomeRecord,
  datasetVersion: string = LEARNING_DATASET_VERSION,
): LearningEvidenceEntry {
  if (typeof datasetVersion !== 'string' || datasetVersion.trim() === '') {
    throw new Error('LEARNING_EVIDENCE_DATASET_VERSION_REQUIRED');
  }
  const lineageRefs = {
    actionRef: record.actionRef,
    proposalRef: record.proposalRef,
    evidenceRef: record.evidenceRef,
  };
  const preimage = [
    record.organizationId,
    record.taskId,
    record.digest,
    lineageRefs.actionRef,
    lineageRefs.proposalRef,
    lineageRefs.evidenceRef,
    datasetVersion,
  ].join('|');
  return {
    organizationId: record.organizationId,
    taskId: record.taskId,
    outcomeDigest: record.digest,
    lineageRefs,
    datasetVersion,
    // 长期持久化建议保留完整 SHA-256；架构阶段截 16 hex（见裁决 RISKS）
    evidenceDigest: 'learning-evidence:' + createHash('sha256').update(preimage).digest('hex').slice(0, 16),
  };
}

export interface LearningProjectionResult {
  projection: LearningDatasetProjection;
  verifiedRecords: readonly OutcomeRecord[];
  excluded: ReadonlyArray<{ digest: string; reason: string }>;
}

/** verified 学习投影：先做 trusted lineage binding，再做只读投影。 */
export async function buildVerifiedLearningProjection(
  lineageLedger: OutcomeLineageLedgerPort | null | undefined,
  records: readonly OutcomeRecord[],
): Promise<LearningProjectionResult> {
  const verifiedRecords: OutcomeRecord[] = [];
  const excluded: Array<{ digest: string; reason: string }> = [];
  for (const record of records) {
    const check = await verifyLearningRecord(lineageLedger, record);
    if (check.verified) verifiedRecords.push(record);
    else excluded.push({ digest: record.digest, reason: check.reason });
  }
  return { projection: projectLearningDataset(verifiedRecords), verifiedRecords, excluded };
}

export interface AppendVerifiedEvidenceResult {
  appended: ReadonlyArray<{ outcomeDigest: string; evidenceRef: string; evidenceDigest: string }>;
  skipped: ReadonlyArray<{ digest: string; reason: string }>;
  /** U5 FINAL：由 immutable ledger append 成功路径产生的 provenance-bearing evidence set。 */
  evidenceSet: VerifiedLearningEvidenceSet;
}

/**
 * verified-only append：未过 binding 的记录绝不写入 evidence ledger。
 * evidence ledger 缺失 / 非 trusted → fail-closed（零写入）。
 */
export async function appendVerifiedLearningEvidence(
  lineageLedger: OutcomeLineageLedgerPort | null | undefined,
  evidenceLedger: LearningEvidenceLedgerPort | null | undefined,
  records: readonly OutcomeRecord[],
  datasetVersion: string = LEARNING_DATASET_VERSION,
): Promise<AppendVerifiedEvidenceResult> {
  if (typeof datasetVersion !== 'string' || datasetVersion.trim() === '') {
    throw new Error('LEARNING_EVIDENCE_DATASET_VERSION_REQUIRED');
  }
  if (evidenceLedger === null || evidenceLedger === undefined) {
    throw new Error('APP_LEARNING_EVIDENCE_LEDGER_REQUIRED');
  }
  if (!isAppLearningEvidenceLedger(evidenceLedger)) {
    throw new Error('LEARNING_EVIDENCE_LEDGER_NOT_TRUSTED');
  }
  const appended: Array<{ outcomeDigest: string; evidenceRef: string; evidenceDigest: string }> = [];
  const skipped: Array<{ digest: string; reason: string }> = [];
  for (const record of records) {
    const check = await verifyLearningRecord(lineageLedger, record);
    if (!check.verified) {
      skipped.push({ digest: record.digest, reason: check.reason });
      continue;
    }
    const entry = buildLearningEvidenceEntry(record, datasetVersion);
    const written = await evidenceLedger.append(entry);
    appended.push({
      outcomeDigest: entry.outcomeDigest,
      evidenceRef: written.evidenceRef,
      evidenceDigest: entry.evidenceDigest,
    });
  }
  const evidenceSet: VerifiedLearningEvidenceSet = {
    kind: 'VERIFIED_LEARNING_EVIDENCE_SET',
    datasetVersion,
    outcomeDigests: sortedUnique(appended.map((item) => item.outcomeDigest)),
    learningEvidenceRefs: sortedUnique(appended.map((item) => item.evidenceRef)),
    evidenceDigests: sortedUnique(appended.map((item) => item.evidenceDigest)),
    evidenceSetDigest: '',
    provenance: {
      kind: 'RSI_IMMUTABLE_LEDGER_APPEND',
      ledgerOwner: 'services/autonomy/rsi-evidence-ledger.ts::appendRsiEvidence',
      verifiedOnly: true,
    },
  };
  evidenceSet.evidenceSetDigest =
    'learning-evidence-set:' +
    createHash('sha256')
      .update(
        [
          datasetVersion,
          ...evidenceSet.outcomeDigests,
          ...evidenceSet.learningEvidenceRefs,
          ...evidenceSet.evidenceDigests,
        ].join('|'),
      )
      .digest('hex')
      .slice(0, 16);
  freezeEvidenceSet(evidenceSet);
  APP_VERIFIED_LEARNING_EVIDENCE_SETS.add(evidenceSet);
  APP_VERIFIED_LEARNING_EVIDENCE_FINGERPRINTS.set(evidenceSet, evidenceSetFingerprint(evidenceSet));
  return { appended, skipped, evidenceSet };
}
