/**
 * PHASE 4 U2 FINAL3 —— trusted ledger provenance（fake ledger 不得经 factory 洗白）
 */

import { describe, expect, it } from 'vitest';

import {
  OUTCOME_LINEAGE_BOUNDARY,
  createAppOutcomeLineageLedger,
  createAppOutcomeLineageSource,
  isAppOutcomeLineageLedger,
  isAppOutcomeLineageSource,
  projectVerifiedLearningRecords,
  resolveTrustedOutcomeLineage,
  verifyLearningRecord,
  type LineageActionFact,
  type LineageEvidenceFact,
  type LineageProposalFact,
  type OutcomeLineageLedgerPort,
  type OutcomeLineageRepositoryDeps,
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

const repos = (over: {
  action?: LineageActionFact | null;
  proposal?: LineageProposalFact | null;
  evidence?: LineageEvidenceFact | null;
} = {}): OutcomeLineageRepositoryDeps => ({
  actions: {
    async findRef() {
      return over.action === undefined ? { organizationId: 'org-1', taskId: 'task-1' } : over.action;
    },
  },
  proposals: {
    async findRef() {
      return over.proposal === undefined
        ? { organizationId: 'org-1', taskId: 'task-1', actionRef: 'action:1', evidenceRef: 'evidence:1' }
        : over.proposal;
    },
  },
  evidence: {
    async findRef() {
      return over.evidence === undefined ? { organizationId: 'org-1', taskId: 'task-1' } : over.evidence;
    },
  },
});

/** caller 手写 fake ledger（返回全匹配数据）—— 应当无法进入 verified 路径。 */
const fakeLedger = (): OutcomeLineageLedgerPort => ({
  async loadAction() {
    return { organizationId: 'org-1', taskId: 'task-1' };
  },
  async loadProposal() {
    return { organizationId: 'org-1', taskId: 'task-1', actionRef: 'action:1', evidenceRef: 'evidence:1' };
  },
  async loadEvidence() {
    return { organizationId: 'org-1', taskId: 'task-1' };
  },
});

describe('PHASE 4 U2 FINAL3 —— trusted ledger provenance', () => {
  it('P4U2H_1 caller 自写 fake ledger（全匹配）→ verified 路径 REJECT', async () => {
    const fake = fakeLedger();
    expect(isAppOutcomeLineageLedger(fake)).toBe(false);
    const check = await verifyLearningRecord(fake, record());
    expect(check.verified).toBe(false);
    if (!check.verified) expect(check.reason).toBe('OUTCOME_LINEAGE_LEDGER_NOT_TRUSTED');
  });

  it('P4U2H_2 fake ledger 不能经 factory 洗白（createAppOutcomeLineageSource 拒绝）', () => {
    expect(() => createAppOutcomeLineageSource({ ledger: fakeLedger() })).toThrow(
      /APP_OUTCOME_LINEAGE_LEDGER_NOT_TRUSTED/,
    );
    const trusted = createAppOutcomeLineageLedger(repos());
    expect(isAppOutcomeLineageLedger(trusted)).toBe(true);
    const source = createAppOutcomeLineageSource({ ledger: trusted });
    expect(isAppOutcomeLineageSource(source)).toBe(true);
  });

  it('P4U2H_3 正式 ledger + refs 不存在 → REJECT', async () => {
    const res = await resolveTrustedOutcomeLineage(
      createAppOutcomeLineageSource({ ledger: createAppOutcomeLineageLedger(repos({ action: null })) }),
      record(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('OUTCOME_LINEAGE_NOT_FOUND');
  });

  it('P4U2H_4 正式 ledger + 跨 task / 跨 org → REJECT', async () => {
    const task = await resolveTrustedOutcomeLineage(
      createAppOutcomeLineageSource({
        ledger: createAppOutcomeLineageLedger(repos({ evidence: { organizationId: 'org-1', taskId: 'task-9' } })),
      }),
      record(),
    );
    expect(task.ok).toBe(false);
    if (!task.ok) expect(task.reason).toBe('OUTCOME_LINEAGE_TASK_MISMATCH');

    const org = await resolveTrustedOutcomeLineage(
      createAppOutcomeLineageSource({
        ledger: createAppOutcomeLineageLedger(
          repos({ proposal: { organizationId: 'org-2', taskId: 'task-1', actionRef: 'action:1', evidenceRef: 'evidence:1' } }),
        ),
      }),
      record(),
    );
    expect(org.ok).toBe(false);
    if (!org.ok) expect(org.reason).toBe('OUTCOME_LINEAGE_ORG_MISMATCH');
  });

  it('P4U2H_5 正式 ledger + proposal linkage 不成立 → REJECT', async () => {
    const res = await resolveTrustedOutcomeLineage(
      createAppOutcomeLineageSource({
        ledger: createAppOutcomeLineageLedger(
          repos({ proposal: { organizationId: 'org-1', taskId: 'task-1', actionRef: 'action:OTHER', evidenceRef: 'evidence:1' } }),
        ),
      }),
      record(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('OUTCOME_LINEAGE_PROPOSAL_NOT_LINKED');
  });

  it('P4U2H_6 完整真实同链 → verified PASS', async () => {
    const trusted = createAppOutcomeLineageLedger(repos());
    expect((await verifyLearningRecord(trusted, record())).verified).toBe(true);
  });

  it('P4U2H_7 未验证记录被显式排除；ledger 缺失 / 非 trusted 均 fail-closed', async () => {
    const good = record();
    const bad = record({ taskId: 'task-x', actionRef: 'action:x', proposalRef: 'proposal:x', evidenceRef: 'evidence:x' });
    const projection = await projectVerifiedLearningRecords(createAppOutcomeLineageLedger(repos()), [good, bad]);
    expect(projection.verifiedRecords.map((r) => r.taskId)).toEqual(['task-1']);
    expect(projection.excluded).toHaveLength(1);
    expect(projection.excluded[0]?.digest).toBe(bad.digest);

    const noLedger = await verifyLearningRecord(null, record());
    expect(noLedger.verified).toBe(false);
    if (!noLedger.verified) expect(noLedger.reason).toBe('APP_OUTCOME_LINEAGE_LEDGER_REQUIRED');

    expect(OUTCOME_LINEAGE_BOUNDARY.callerSuppliedLedger).toContain('FORBIDDEN');
    expect(OUTCOME_LINEAGE_BOUNDARY.trustedLedger).toContain('WeakSet');
    expect(OUTCOME_LINEAGE_BOUNDARY.callerSuppliedPort).toBe('FORBIDDEN_FOR_VERIFIED_PATH');
    expect(OUTCOME_LINEAGE_BOUNDARY.proposalLinked).toContain('COMPUTED_BY_ADAPTER');
    expect(OUTCOME_LINEAGE_BOUNDARY.unverifiedPath).toBe('FORBIDDEN_FOR_LEARNING_EVIDENCE');
    expect(OUTCOME_LINEAGE_BOUNDARY.secondEvidenceStore).toBe('FORBIDDEN');
  });
});
