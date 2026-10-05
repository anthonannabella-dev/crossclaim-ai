/**
 * PHASE 4 U2 FINAL2 —— trusted lineage：从 caller 可注入 port 改为 **server-owned composition**
 * ---------------------------------------------------------------
 * 裁决依据：MSG-20261005-57 —— 之前只把 caller“自报字符串”升级成“自报可信端口”，
 * 结构型 port 仍可被伪造（fakePort 恒返回匹配 fact + proposalLinked=true → verified）。
 * 本版：
 *   - lineage source 只能由 `createAppOutcomeLineageSource(deps)` 产出，并登记进模块私有 WeakSet；
 *   - verified learning path **只接受 AppOutcomeLineageDeps**，内部自行构造正式 source；
 *   - `proposalLinked` 由正式 adapter 依据既有 ledger 的 action/proposal/evidence 关系**计算**，不采信上游 boolean。
 * 只读：不修改 Policy / Guard / Router / Action Runtime；不建第二证据存储。
 */

import type { OutcomeRecord } from './outcome-record';

export const OUTCOME_LINEAGE_BOUNDARY = {
  trustedSource: 'SERVER_OWNED_COMPOSITION（createAppOutcomeLineageSource + 私有 WeakSet provenance）',
  callerSuppliedPort: 'FORBIDDEN_FOR_VERIFIED_PATH',
  selfConsistencyOnly: 'NOT_SUFFICIENT_FOR_BINDING',
  proposalLinked: 'COMPUTED_BY_ADAPTER（不采信上游 boolean）',
  unverifiedPath: 'FORBIDDEN_FOR_LEARNING_EVIDENCE',
  secondEvidenceStore: 'FORBIDDEN',
  observationOnly: true,
  autoPolicyMutation: 'FORBIDDEN',
} as const;

/** 既有 action / proposal / evidence ledger 的最小只读事实。 */
export interface LineageActionFact {
  organizationId: string;
  taskId: string;
}
export interface LineageProposalFact {
  organizationId: string;
  taskId: string;
  actionRef: string;
  evidenceRef: string;
}
export interface LineageEvidenceFact {
  organizationId: string;
  taskId: string;
}

/** 由正式 composition 注入的 ledger 只读端口。 */
export interface OutcomeLineageLedgerPort {
  loadAction(actionRef: string): Promise<LineageActionFact | null>;
  loadProposal(proposalRef: string): Promise<LineageProposalFact | null>;
  loadEvidence(evidenceRef: string): Promise<LineageEvidenceFact | null>;
}

export interface AppOutcomeLineageDeps {
  ledger: OutcomeLineageLedgerPort;
}

export interface OutcomeLineageFact {
  organizationId: string;
  taskId: string;
  actionRef: string;
  proposalRef: string;
  evidenceRef: string;
  /** 由 adapter 计算：三者在 ledger 中同 org / 同 task，且 proposal 确实关联 action+evidence */
  proposalLinked: boolean;
}

export interface OutcomeLineageQuery {
  organizationId: string;
  taskId: string;
  actionRef: string;
  proposalRef: string;
  evidenceRef: string;
}

export interface OutcomeLineageSourcePort {
  resolve(query: OutcomeLineageQuery): Promise<OutcomeLineageFact | null>;
}

export type LineageResolution = { ok: true; fact: OutcomeLineageFact } | { ok: false; reason: string };
export type LearningRecordVerification = { verified: true } | { verified: false; reason: string };

/** 正式 composition 产出的 source（模块私有 provenance）。 */
const APP_OUTCOME_LINEAGE_SOURCES = new WeakSet<OutcomeLineageSourcePort>();

/** 只读 provenance：只有 factory 产出的 source 才可信。 */
export function isAppOutcomeLineageSource(source: OutcomeLineageSourcePort): boolean {
  return APP_OUTCOME_LINEAGE_SOURCES.has(source);
}

const MISMATCH = 'MISMATCH';

/**
 * 正式 composition：接既有 action/proposal/evidence ledger，计算同链事实。
 * caller 不能自造 source；`proposalLinked` 由本 adapter 计算，不接受上游 boolean。
 */
export function createAppOutcomeLineageSource(deps: AppOutcomeLineageDeps): OutcomeLineageSourcePort {
  if (!deps || !deps.ledger) throw new Error('APP_OUTCOME_LINEAGE_MISSING_LEDGER');
  const { ledger } = deps;

  const source: OutcomeLineageSourcePort = {
    async resolve(query: OutcomeLineageQuery): Promise<OutcomeLineageFact | null> {
      const [action, proposal, evidence] = await Promise.all([
        ledger.loadAction(query.actionRef),
        ledger.loadProposal(query.proposalRef),
        ledger.loadEvidence(query.evidenceRef),
      ]);
      if (!action || !proposal || !evidence) return null;

      const sameOrg =
        action.organizationId === proposal.organizationId && action.organizationId === evidence.organizationId;
      const sameTask = action.taskId === proposal.taskId && action.taskId === evidence.taskId;
      const linked = proposal.actionRef === query.actionRef && proposal.evidenceRef === query.evidenceRef;

      return {
        organizationId: sameOrg ? action.organizationId : MISMATCH,
        taskId: sameTask ? action.taskId : MISMATCH,
        actionRef: query.actionRef,
        proposalRef: query.proposalRef,
        evidenceRef: query.evidenceRef,
        proposalLinked: linked && sameOrg && sameTask,
      };
    },
  };
  APP_OUTCOME_LINEAGE_SOURCES.add(source);
  return source;
}

/**
 * 通过**可信 source** 解析并校验 lineage binding（fail-closed）。
 * 非 factory 产出的 source 一律拒绝 —— 这是 U2 FINAL2 关闭的注入漏洞。
 */
export async function resolveTrustedOutcomeLineage(
  source: OutcomeLineageSourcePort | null | undefined,
  record: OutcomeRecord,
): Promise<LineageResolution> {
  if (source === null || source === undefined || typeof source.resolve !== 'function') {
    return { ok: false, reason: 'OUTCOME_LINEAGE_PORT_NOT_CONFIGURED' };
  }
  if (!isAppOutcomeLineageSource(source)) {
    return { ok: false, reason: 'OUTCOME_LINEAGE_SOURCE_NOT_TRUSTED' };
  }
  let fact: OutcomeLineageFact | null;
  try {
    fact = await source.resolve({
      organizationId: record.organizationId,
      taskId: record.taskId,
      actionRef: record.actionRef,
      proposalRef: record.proposalRef,
      evidenceRef: record.evidenceRef,
    });
  } catch {
    return { ok: false, reason: 'OUTCOME_LINEAGE_SOURCE_ERROR' };
  }
  if (fact === null || typeof fact !== 'object') return { ok: false, reason: 'OUTCOME_LINEAGE_NOT_FOUND' };
  if (fact.organizationId !== record.organizationId) return { ok: false, reason: 'OUTCOME_LINEAGE_ORG_MISMATCH' };
  if (fact.taskId !== record.taskId) return { ok: false, reason: 'OUTCOME_LINEAGE_TASK_MISMATCH' };
  const refChecks: Array<[string, string, string]> = [
    ['actionRef', fact.actionRef, record.actionRef],
    ['proposalRef', fact.proposalRef, record.proposalRef],
    ['evidenceRef', fact.evidenceRef, record.evidenceRef],
  ];
  for (const [field, fromFact, onRecord] of refChecks) {
    if (fromFact !== onRecord) return { ok: false, reason: 'OUTCOME_LINEAGE_REF_MISMATCH:' + field };
  }
  if (fact.proposalLinked !== true) return { ok: false, reason: 'OUTCOME_LINEAGE_PROPOSAL_NOT_LINKED' };
  return { ok: true, fact };
}

/**
 * verified 路径：只接受 **AppOutcomeLineageDeps**（server-owned），内部构造正式 source。
 * 不接受 caller 传入的 port 实例。
 */
export async function verifyLearningRecord(
  deps: AppOutcomeLineageDeps | null | undefined,
  record: OutcomeRecord,
): Promise<LearningRecordVerification> {
  if (deps === null || deps === undefined) return { verified: false, reason: 'APP_OUTCOME_LINEAGE_DEPS_REQUIRED' };
  let source: OutcomeLineageSourcePort;
  try {
    source = createAppOutcomeLineageSource(deps);
  } catch {
    return { verified: false, reason: 'APP_OUTCOME_LINEAGE_MISSING_LEDGER' };
  }
  const resolved = await resolveTrustedOutcomeLineage(source, record);
  return resolved.ok ? { verified: true } : { verified: false, reason: resolved.reason };
}

export interface VerifiedDatasetProjection {
  verifiedRecords: readonly OutcomeRecord[];
  excluded: ReadonlyArray<{ digest: string; reason: string }>;
}

/** verified 路径：只有通过 trusted binding 的记录才可进入学习证据/数据集。 */
export async function projectVerifiedLearningRecords(
  deps: AppOutcomeLineageDeps | null | undefined,
  records: readonly OutcomeRecord[],
): Promise<VerifiedDatasetProjection> {
  const verifiedRecords: OutcomeRecord[] = [];
  const excluded: Array<{ digest: string; reason: string }> = [];
  for (const record of records) {
    const check = await verifyLearningRecord(deps, record);
    if (check.verified) verifiedRecords.push(record);
    else excluded.push({ digest: record.digest, reason: check.reason });
  }
  return { verifiedRecords, excluded };
}
