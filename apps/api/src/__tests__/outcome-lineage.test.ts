/**
 * PHASE 4 U2(FINAL) —— trusted lineage resolver（binding 由可信端口判定，非 caller 自报）
 * 边界：只读；未过 binding 不得进入 verified 路径；不建第二证据存储。
 */

import { describe, expect, it } from 'vitest';

import { OUTCOME_LINEAGE_BOUNDARY, projectVerifiedLearningRecords, resolveTrustedOutcomeLineage, verifyLearningRecord, type OutcomeLineageFact, type OutcomeLineageSourcePort } from '../services/outcome-learning/outcome-lineage';
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

const fact = (over: Partial<OutcomeLineageFact> = {}): OutcomeLineageFact => ({
  organizationId: 'org-1',
  taskId: 'task-1',
  actionRef: 'action:1',
  proposalRef: 'proposal:1',
  evidenceRef: 'evidence:1',
  proposalLinked: true,
  ...over,
});

const port = (result: OutcomeLineageFact | null | 'THROW'): OutcomeLineageSourcePort => ({
  async resolve() {
    if (result === 'THROW') throw new Error('ledger down');
    return result;
  },
});

describe('PHASE 4 U2 FINAL —— trusted lineage binding（端口事实判定）', () => {
  it('P4U2F_1 ledger 无该记录 → REJECT（自洽不算 binding）', async () => {
    const res = await resolveTrustedOutcomeLineage(port(null), record());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('OUTCOME_LINEAGE_NOT_FOUND');
  });

  it('P4U2F_2 未配置端口 / ledger 异常 → fail-closed', async () => {
    const missing = await resolveTrustedOutcomeLineage(null, record());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('OUTCOME_LINEAGE_PORT_NOT_CONFIGURED');
    const down = await resolveTrustedOutcomeLineage(port('THROW'), record());
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.reason).toBe('OUTCOME_LINEAGE_SOURCE_ERROR');
  });

  it('P4U2F_3 跨 organization / 跨 task → REJECT', async () => {
    const org = await resolveTrustedOutcomeLineage(port(fact({ organizationId: 'org-2' })), record());
    expect(org.ok).toBe(false);
    if (!org.ok) expect(org.reason).toBe('OUTCOME_LINEAGE_ORG_MISMATCH');
    const task = await resolveTrustedOutcomeLineage(port(fact({ taskId: 'task-9' })), record());
    expect(task.ok).toBe(false);
    if (!task.ok) expect(task.reason).toBe('OUTCOME_LINEAGE_TASK_MISMATCH');
  });

  it('P4U2F_4 ref 不属于同链（action/proposal/evidence）→ REJECT', async () => {
    for (const field of ['actionRef', 'proposalRef', 'evidenceRef'] as const) {
      const res = await resolveTrustedOutcomeLineage(port(fact({ [field]: 'other' } as never)), record());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('OUTCOME_LINEAGE_REF_MISMATCH:' + field);
    }
  });

  it('P4U2F_5 proposal 与 action/evidence 未关联 → REJECT', async () => {
    const res = await resolveTrustedOutcomeLineage(port(fact({ proposalLinked: false })), record());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('OUTCOME_LINEAGE_PROPOSAL_NOT_LINKED');
  });

  it('P4U2F_6 可信端口返回完整同链 → PASS（verified）', async () => {
    const res = await resolveTrustedOutcomeLineage(port(fact()), record());
    expect(res.ok).toBe(true);
    const check = await verifyLearningRecord(port(fact()), record());
    expect(check.verified).toBe(true);
  });

  it('P4U2F_7 verified 路径：未过 binding 的记录被排除，不得静默纳入', async () => {
    const good = record();
    const bad = record({ taskId: 'task-x', actionRef: 'action:x', proposalRef: 'proposal:x', evidenceRef: 'evidence:x' });
    const ok = await projectVerifiedLearningRecords(port(fact()), [good, bad]);
    expect(ok.verifiedRecords.map((r) => r.taskId)).toEqual(['task-1']);
    expect(ok.excluded).toHaveLength(1);
    expect(ok.excluded[0]?.reason).toBe('OUTCOME_LINEAGE_TASK_MISMATCH');
    expect(ok.excluded[0]?.digest).toBe(bad.digest);
    expect(OUTCOME_LINEAGE_BOUNDARY.selfConsistencyOnly).toBe('NOT_SUFFICIENT_FOR_BINDING');
    expect(OUTCOME_LINEAGE_BOUNDARY.unverifiedPath).toBe('FORBIDDEN_FOR_LEARNING_EVIDENCE');
    expect(OUTCOME_LINEAGE_BOUNDARY.secondEvidenceStore).toBe('FORBIDDEN');
  });
});
