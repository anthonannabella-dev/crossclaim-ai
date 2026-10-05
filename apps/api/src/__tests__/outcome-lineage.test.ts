/**
 * PHASE 4 U2 FINAL2 —— server-owned lineage composition（fake source 不得进入 verified 路径）
 */

import { describe, expect, it } from 'vitest';

import {
  OUTCOME_LINEAGE_BOUNDARY,
  createAppOutcomeLineageSource,
  isAppOutcomeLineageSource,
  projectVerifiedLearningRecords,
  resolveTrustedOutcomeLineage,
  verifyLearningRecord,
  type AppOutcomeLineageDeps,
  type LineageActionFact,
  type LineageEvidenceFact,
  type LineageProposalFact,
  type OutcomeLineageLedgerPort,
  type OutcomeLineageSourcePort,
} from '../services/outcome-learning/outcome-lineage';
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

const ledger = (over: {
  action?: LineageActionFact | null;
  proposal?: LineageProposalFact | null;
  evidence?: LineageEvidenceFact | null;
} = {}): OutcomeLineageLedgerPort => ({
  async loadAction() {
    return over.action === undefined ? { organizationId: 'org-1', taskId: 'task-1' } : over.action;
  },
  async loadProposal() {
    return over.proposal === undefined
      ? { organizationId: 'org-1', taskId: 'task-1', actionRef: 'action:1', evidenceRef: 'evidence:1' }
      : over.proposal;
  },
  async loadEvidence() {
    return over.evidence === undefined ? { organizationId: 'org-1', taskId: 'task-1' } : over.evidence;
  },
});

const deps = (over: Parameters<typeof ledger>[0] = {}): AppOutcomeLineageDeps => ({ ledger: ledger(over) });

describe('PHASE 4 U2 FINAL2 —— server-owned lineage composition', () => {
  it('P4U2G_1 caller 手写 fake source（恒返回匹配 fact）→ verified 路径 REJECT', async () => {
    const fake: OutcomeLineageSourcePort = {
      async resolve() {
        return {
          organizationId: 'org-1',
          taskId: 'task-1',
          actionRef: 'action:1',
          proposalRef: 'proposal:1',
          evidenceRef: 'evidence:1',
          proposalLinked: true,
        };
      },
    };
    expect(isAppOutcomeLineageSource(fake)).toBe(false);
    const res = await resolveTrustedOutcomeLineage(fake, record());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('OUTCOME_LINEAGE_SOURCE_NOT_TRUSTED');
  });

  it('P4U2G_2 正式 factory source → provenance PASS；全链真实匹配 → verified PASS', async () => {
    const source = createAppOutcomeLineageSource(deps());
    expect(isAppOutcomeLineageSource(source)).toBe(true);
    const res = await resolveTrustedOutcomeLineage(source, record());
    expect(res.ok).toBe(true);
    expect((await verifyLearningRecord(deps(), record())).verified).toBe(true);
  });

  it('P4U2G_3 正式 source 从 ledger 读不到 refs → REJECT', async () => {
    const res = await resolveTrustedOutcomeLineage(createAppOutcomeLineageSource(deps({ action: null })), record());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('OUTCOME_LINEAGE_NOT_FOUND');
  });

  it('P4U2G_4 ledger refs 存在但不同 task / org → REJECT', async () => {
    const task = await resolveTrustedOutcomeLineage(
      createAppOutcomeLineageSource(deps({ evidence: { organizationId: 'org-1', taskId: 'task-9' } })),
      record(),
    );
    expect(task.ok).toBe(false);
    if (!task.ok) expect(task.reason).toBe('OUTCOME_LINEAGE_TASK_MISMATCH');

    const org = await resolveTrustedOutcomeLineage(
      createAppOutcomeLineageSource(deps({ proposal: { organizationId: 'org-2', taskId: 'task-1', actionRef: 'action:1', evidenceRef: 'evidence:1' } })),
      record(),
    );
    expect(org.ok).toBe(false);
    if (!org.ok) expect(org.reason).toBe('OUTCOME_LINEAGE_ORG_MISMATCH');
  });

  it('P4U2G_5 proposal 与 action/evidence 未真实关联 → REJECT（adapter 计算，不采信上游 boolean）', async () => {
    const notLinked = await resolveTrustedOutcomeLineage(
      createAppOutcomeLineageSource(
        deps({ proposal: { organizationId: 'org-1', taskId: 'task-1', actionRef: 'action:OTHER', evidenceRef: 'evidence:1' } }),
      ),
      record(),
    );
    expect(notLinked.ok).toBe(false);
    if (!notLinked.ok) expect(notLinked.reason).toBe('OUTCOME_LINEAGE_PROPOSAL_NOT_LINKED');
  });

  it('P4U2G_6 verified 路径：deps 缺失 / ledger 缺失 → fail-closed', async () => {
    const noDeps = await verifyLearningRecord(null, record());
    expect(noDeps.verified).toBe(false);
    if (!noDeps.verified) expect(noDeps.reason).toBe('APP_OUTCOME_LINEAGE_DEPS_REQUIRED');
    const noLedger = await verifyLearningRecord({ ledger: undefined as never }, record());
    expect(noLedger.verified).toBe(false);
    if (!noLedger.verified) expect(noLedger.reason).toBe('APP_OUTCOME_LINEAGE_MISSING_LEDGER');
  });

  it('P4U2G_7 未验证记录被显式排除，不得进入 U3 immutable learning evidence', async () => {
    const good = record();
    const bad = record({ taskId: 'task-x', actionRef: 'action:x', proposalRef: 'proposal:x', evidenceRef: 'evidence:x' });
    const projection = await projectVerifiedLearningRecords(deps(), [good, bad]);
    expect(projection.verifiedRecords.map((r) => r.taskId)).toEqual(['task-1']);
    expect(projection.excluded).toHaveLength(1);
    expect(projection.excluded[0]?.digest).toBe(bad.digest);
    expect(OUTCOME_LINEAGE_BOUNDARY.callerSuppliedPort).toBe('FORBIDDEN_FOR_VERIFIED_PATH');
    expect(OUTCOME_LINEAGE_BOUNDARY.proposalLinked).toContain('COMPUTED_BY_ADAPTER');
    expect(OUTCOME_LINEAGE_BOUNDARY.unverifiedPath).toBe('FORBIDDEN_FOR_LEARNING_EVIDENCE');
    expect(OUTCOME_LINEAGE_BOUNDARY.secondEvidenceStore).toBe('FORBIDDEN');
  });
});
