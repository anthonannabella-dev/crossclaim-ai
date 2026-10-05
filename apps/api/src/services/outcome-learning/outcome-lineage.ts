/**
 * PHASE 4 U2(FINAL) —— trusted lineage resolver：把 lineage 从“自洽”升级为“被可信事实证明”
 * ---------------------------------------------------------------
 * 裁决依据：MSG-20261005-56 —— verifyOutcomeLineage() 只比较两组 caller 提供的字符串，
 * 只能记 LINEAGE_SELF_CONSISTENCY = PASS；真正的 LINEAGE_BINDING 必须由既有 action / proposal /
 * evidence ledger（可信源）解析后判定。
 *
 * 硬约束：
 *   - 端口缺失 / 解析失败 / 任何不一致 → fail-closed（拒绝），绝不由 caller 自报“它们属于同链”。
 *   - 未通过 trusted binding 的记录**不得**进入 learning evidence / dataset 的 verified 路径。
 *   - 本模块只读：不修改 Policy / Guard / Router / Action Runtime；不建第二证据存储。
 */

import type { OutcomeRecord } from './outcome-record';

export const OUTCOME_LINEAGE_BOUNDARY = {
  trustedSource: 'PORT_REQUIRED（既有 action/proposal/evidence ledger）',
  selfConsistencyOnly: 'NOT_SUFFICIENT_FOR_BINDING',
  unverifiedPath: 'FORBIDDEN_FOR_LEARNING_EVIDENCE',
  secondEvidenceStore: 'FORBIDDEN',
  observationOnly: true,
  autoPolicyMutation: 'FORBIDDEN',
} as const;

/** 由可信源返回的 lineage 事实（不是 caller 输入）。 */
export interface OutcomeLineageFact {
  organizationId: string;
  taskId: string;
  actionRef: string;
  proposalRef: string;
  evidenceRef: string;
  /** proposal → action / evidence 的关联是否成立（由可信源判定） */
  proposalLinked: boolean;
}

export interface OutcomeLineageQuery {
  organizationId: string;
  taskId: string;
  actionRef: string;
  proposalRef: string;
  evidenceRef: string;
}

/** 可信 lineage 端口：由既有 ledger 实现；本模块只依赖该契约。 */
export interface OutcomeLineageSourcePort {
  resolve(query: OutcomeLineageQuery): Promise<OutcomeLineageFact | null>;
}

export type LineageResolution =
  | { ok: true; fact: OutcomeLineageFact }
  | { ok: false; reason: string };

export type LearningRecordVerification = { verified: true } | { verified: false; reason: string };

/**
 * 通过可信端口解析并校验 lineage binding（fail-closed）。
 * 覆盖裁决要求的 5 类负例：ledger 中不存在 / 跨 task / 跨 organization / ref 不属于同链 / proposal 未关联。
 */
export async function resolveTrustedOutcomeLineage(
  port: OutcomeLineageSourcePort | null | undefined,
  record: OutcomeRecord,
): Promise<LineageResolution> {
  if (port === null || port === undefined || typeof port.resolve !== 'function') {
    return { ok: false, reason: 'OUTCOME_LINEAGE_PORT_NOT_CONFIGURED' };
  }
  let fact: OutcomeLineageFact | null;
  try {
    fact = await port.resolve({
      organizationId: record.organizationId,
      taskId: record.taskId,
      actionRef: record.actionRef,
      proposalRef: record.proposalRef,
      evidenceRef: record.evidenceRef,
    });
  } catch {
    return { ok: false, reason: 'OUTCOME_LINEAGE_SOURCE_ERROR' };
  }
  if (fact === null || typeof fact !== 'object') {
    return { ok: false, reason: 'OUTCOME_LINEAGE_NOT_FOUND' };
  }
  if (fact.organizationId !== record.organizationId) {
    return { ok: false, reason: 'OUTCOME_LINEAGE_ORG_MISMATCH' };
  }
  if (fact.taskId !== record.taskId) {
    return { ok: false, reason: 'OUTCOME_LINEAGE_TASK_MISMATCH' };
  }
  const refChecks: Array<[string, string, string]> = [
    ['actionRef', fact.actionRef, record.actionRef],
    ['proposalRef', fact.proposalRef, record.proposalRef],
    ['evidenceRef', fact.evidenceRef, record.evidenceRef],
  ];
  for (const [field, fromFact, onRecord] of refChecks) {
    if (fromFact !== onRecord) return { ok: false, reason: 'OUTCOME_LINEAGE_REF_MISMATCH:' + field };
  }
  if (fact.proposalLinked !== true) {
    return { ok: false, reason: 'OUTCOME_LINEAGE_PROPOSAL_NOT_LINKED' };
  }
  return { ok: true, fact };
}

/** 学习记录是否可进入 verified 路径（必须通过 trusted binding）。 */
export async function verifyLearningRecord(
  port: OutcomeLineageSourcePort | null | undefined,
  record: OutcomeRecord,
): Promise<LearningRecordVerification> {
  const resolved = await resolveTrustedOutcomeLineage(port, record);
  return resolved.ok ? { verified: true } : { verified: false, reason: resolved.reason };
}

export interface VerifiedDatasetProjection {
  verifiedRecords: readonly OutcomeRecord[];
  excluded: ReadonlyArray<{ digest: string; reason: string }>;
}

/**
 * verified 路径：只有通过 trusted binding 的记录才可进入学习证据/数据集。
 * 未通过者一律排除并记录原因（不得静默纳入）。
 */
export async function projectVerifiedLearningRecords(
  port: OutcomeLineageSourcePort | null | undefined,
  records: readonly OutcomeRecord[],
): Promise<VerifiedDatasetProjection> {
  const verifiedRecords: OutcomeRecord[] = [];
  const excluded: Array<{ digest: string; reason: string }> = [];
  for (const record of records) {
    const check = await verifyLearningRecord(port, record);
    if (check.verified) verifiedRecords.push(record);
    else excluded.push({ digest: record.digest, reason: check.reason });
  }
  return { verifiedRecords, excluded };
}
