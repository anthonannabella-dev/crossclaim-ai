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

/** 只读 provenance：只有正式 adapter 产出的 evidence ledger 才可信。 */
export function isAppLearningEvidenceLedger(ledger: LearningEvidenceLedgerPort): boolean {
  return APP_LEARNING_EVIDENCE_LEDGERS.has(ledger);
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
  appended: ReadonlyArray<{ outcomeDigest: string; evidenceRef: string }>;
  skipped: ReadonlyArray<{ digest: string; reason: string }>;
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
  const appended: Array<{ outcomeDigest: string; evidenceRef: string }> = [];
  const skipped: Array<{ digest: string; reason: string }> = [];
  for (const record of records) {
    const check = await verifyLearningRecord(lineageLedger, record);
    if (!check.verified) {
      skipped.push({ digest: record.digest, reason: check.reason });
      continue;
    }
    const entry = buildLearningEvidenceEntry(record, datasetVersion);
    const written = await evidenceLedger.append(entry);
    appended.push({ outcomeDigest: entry.outcomeDigest, evidenceRef: written.evidenceRef });
  }
  return { appended, skipped };
}
