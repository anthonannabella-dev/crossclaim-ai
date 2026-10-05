/**
 * PHASE 5 U1 —— Candidate Review + Approval Verdict Contract
 * verified evidence → verified evaluation → PROPOSAL_ONLY candidate → external judge / human approval（只判决，不执行）
 */

import { describe, expect, it } from 'vitest';

import type { RsiEvidenceRecord } from '../services/autonomy/rsi-evidence-ledger';
import {
  APPROVER_ROLES,
  CANDIDATE_APPROVAL_BOUNDARY,
  VERDICT_OUTCOMES,
  decideCandidateReview,
  isDecidedTicket,
  isRevokedTicket,
  openCandidateReviewTicket,
  revokeCandidateReview,
  type ApproverIdentity,
} from '../services/outcome-learning/candidate-approval';
import {
  appendVerifiedLearningEvidence,
  createAppLearningEvidenceLedgerFromRsi,
  type RsiEvidenceLedgerStorePort,
} from '../services/outcome-learning/learning-evidence';
import { proposeMetaImprovementCandidates } from '../services/outcome-learning/meta-improvement-candidate';
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

const troubledRecords = (): OutcomeRecord[] => [
  record({ finalOutcome: 'SUCCESS' }),
  record({ finalOutcome: 'FAILURE', evidenceQuality: 'WEAK', rejectionReason: 'provider_declined' }),
  record({ finalOutcome: 'FAILURE', rejectionReason: 'provider_declined_2' }),
  record({ finalOutcome: 'UNKNOWN', humanIntervention: null }),
  record({ finalOutcome: 'UNKNOWN', humanIntervention: null, taskType: 'recovery-b' }),
  record({ finalOutcome: 'PARTIAL', humanIntervention: null }),
];

const makeCandidate = async () => {
  const records = troubledRecords();
  const evaluation = await evaluateVerifiedLearningRecords(trustedLineage(), records, { datasetVersion: DATASET });
  const store = rsiStore();
  const ledger = createAppLearningEvidenceLedgerFromRsi(store.port);
  const appended = await appendVerifiedLearningEvidence(trustedLineage(), ledger, records, DATASET);
  const result = proposeMetaImprovementCandidates({ evaluation, evidenceSet: appended.evidenceSet });
  const candidate = result.candidates[0];
  if (!candidate) throw new Error('expected at least one candidate');
  return candidate;
};

const approver = (over: Partial<ApproverIdentity> = {}): ApproverIdentity => ({
  approverId: 'judge-1',
  role: 'EXTERNAL_JUDGE',
  scope: ['META_IMPROVEMENT_PROPOSAL_ONLY'],
  ...over,
});

const schedule = (over: Partial<{ requestedAt: string; expiresAt: string; nonce: string }> = {}) => ({
  requestedAt: '2026-10-05T20:00:00.000Z',
  expiresAt: '2026-10-06T20:00:00.000Z',
  nonce: 'nonce-1',
  ...over,
});

describe('PHASE 5 U1 —— candidate review + approval verdict contract', () => {
  it('P5U1_1 ticket 绑定 candidate / evaluation / evidenceSet 摘要，PENDING 且确定性（同输入同 ticketDigest）', async () => {
    const candidate = await makeCandidate();
    const ticket = openCandidateReviewTicket(candidate, approver(), schedule());
    expect(ticket.kind).toBe('CANDIDATE_REVIEW_TICKET');
    expect(ticket.status).toBe('PENDING');
    expect(ticket.candidateDigest).toBe(candidate.candidateDigest);
    expect(ticket.evaluationDigest).toBe(candidate.evaluationDigest);
    expect(ticket.evidenceSetDigest).toBe(candidate.evidenceSetDigest);
    expect(ticket.approverId).toBe('judge-1');
    expect(ticket.role).toBe('EXTERNAL_JUDGE');
    expect(ticket.scope).toEqual(['META_IMPROVEMENT_PROPOSAL_ONLY']);
    expect(ticket.nonce).toBe('nonce-1');
    expect(ticket.ticketId).toBe('candidate-review:' + ticket.ticketDigest);
    expect(isDecidedTicket(ticket)).toBe(false);
    expect(isRevokedTicket(ticket)).toBe(false);
    const again = openCandidateReviewTicket(await makeCandidate(), approver(), schedule());
    expect(again.ticketDigest).toBe(ticket.ticketDigest);
  });

  it('P5U1_2 fail-closed：candidate 缺失 / 非 PROPOSAL_ONLY / mutation 未全 FORBIDDEN / 绑定缺失 → REJECT', async () => {
    const candidate = await makeCandidate();
    expect(() => openCandidateReviewTicket(null, approver(), schedule())).toThrow(/APPROVAL_TICKET_CANDIDATE_REQUIRED/);
    expect(() =>
      openCandidateReviewTicket({ ...candidate, candidateStatus: 'APPLIED' } as never, approver(), schedule()),
    ).toThrow(/APPROVAL_TICKET_CANDIDATE_NOT_PROPOSAL_ONLY/);
    expect(() =>
      openCandidateReviewTicket(
        { ...candidate, mutation: { ...candidate.mutation, policy: 'ALLOWED' } } as never,
        approver(),
        schedule(),
      ),
    ).toThrow(/APPROVAL_TICKET_CANDIDATE_MUTATION_FORBIDDEN/);
    expect(() =>
      openCandidateReviewTicket({ ...candidate, candidateDigest: '' } as never, approver(), schedule()),
    ).toThrow(/APPROVAL_TICKET_CANDIDATE_BINDING_REQUIRED/);
  });

  it('P5U1_3 fail-closed：approver 缺失 / 自动化角色越权 / scope 空 / nonce 空 / 过期时间非法 → REJECT', async () => {
    const candidate = await makeCandidate();
    expect(() => openCandidateReviewTicket(candidate, null, schedule())).toThrow(/APPROVAL_TICKET_APPROVER_REQUIRED/);
    expect(() =>
      openCandidateReviewTicket(candidate, approver({ role: 'AUTOMATION' as never }), schedule()),
    ).toThrow(/APPROVAL_TICKET_APPROVER_ROLE_FORBIDDEN/);
    expect(() => openCandidateReviewTicket(candidate, approver({ scope: [] }), schedule())).toThrow(
      /APPROVAL_TICKET_SCOPE_REQUIRED/,
    );
    expect(() => openCandidateReviewTicket(candidate, approver(), schedule({ nonce: '  ' }))).toThrow(
      /APPROVAL_TICKET_NONCE_REQUIRED/,
    );
    expect(() =>
      openCandidateReviewTicket(candidate, approver(), schedule({ expiresAt: '2026-10-05T19:00:00.000Z' })),
    ).toThrow(/APPROVAL_TICKET_EXPIRY_INVALID/);
    expect(() => openCandidateReviewTicket(candidate, approver(), schedule({ requestedAt: 'not-a-date' }))).toThrow(
      /APPROVAL_TICKET_SCHEDULE_INVALID/,
    );
    expect(APPROVER_ROLES).toEqual(['EXTERNAL_JUDGE', 'HUMAN_OPERATOR']);
  });

  it('P5U1_4 APPROVED 判决：绑定 ticket/candidate/evaluation/evidenceSet + execution 全 FORBIDDEN + 需 controlled adoption proposal', async () => {
    const candidate = await makeCandidate();
    const ticket = openCandidateReviewTicket(candidate, approver(), schedule());
    const verdict = decideCandidateReview(ticket, {
      approverId: 'judge-1',
      role: 'EXTERNAL_JUDGE',
      outcome: 'APPROVED',
      decidedAt: '2026-10-05T21:00:00.000Z',
      reason: 'evidence chain verified',
    });
    expect(verdict.kind).toBe('APPROVAL_VERDICT');
    expect(verdict.outcome).toBe('APPROVED');
    expect(verdict.verdictId).toBe('approval-verdict:' + verdict.verdictDigest);
    expect(verdict.ticketDigest).toBe(ticket.ticketDigest);
    expect(verdict.candidateDigest).toBe(candidate.candidateDigest);
    expect(verdict.evaluationDigest).toBe(candidate.evaluationDigest);
    expect(verdict.evidenceSetDigest).toBe(candidate.evidenceSetDigest);
    expect(verdict.nonce).toBe('nonce-1');
    expect(verdict.reason).toBe('evidence chain verified');
    expect(verdict.execution.autoApply).toBe(false);
    expect(verdict.execution.promotion).toBe('OFF');
    expect(verdict.execution.productionRollout).toBe('FORBIDDEN');
    expect(verdict.execution.adoption).toBe('CONTROLLED_ADOPTION_PROPOSAL_REQUIRED');
    expect(verdict.execution.mutation).toEqual({
      policy: 'FORBIDDEN',
      guard: 'FORBIDDEN',
      router: 'FORBIDDEN',
      actionRuntime: 'FORBIDDEN',
    });
    expect(isDecidedTicket(ticket)).toBe(true);
  });

  it('P5U1_5 REJECTED 判决：可记原因，且不产生任何执行语义', async () => {
    const candidate = await makeCandidate();
    const ticket = openCandidateReviewTicket(candidate, approver({ role: 'HUMAN_OPERATOR' }), schedule());
    const verdict = decideCandidateReview(ticket, {
      approverId: 'judge-1',
      role: 'HUMAN_OPERATOR',
      outcome: 'REJECTED',
      decidedAt: '2026-10-05T22:00:00.000Z',
      reason: 'insufficient sample size',
    });
    expect(verdict.outcome).toBe('REJECTED');
    expect(verdict.reason).toBe('insufficient sample size');
    expect(verdict.execution.autoApply).toBe(false);
    expect(VERDICT_OUTCOMES).toEqual(['APPROVED', 'REJECTED']);
  });

  it('P5U1_6 single-use / 防 replay：同一 ticket 第二次判决 → REJECT', async () => {
    const candidate = await makeCandidate();
    const ticket = openCandidateReviewTicket(candidate, approver(), schedule());
    decideCandidateReview(ticket, {
      approverId: 'judge-1',
      role: 'EXTERNAL_JUDGE',
      outcome: 'APPROVED',
      decidedAt: '2026-10-05T21:00:00.000Z',
    });
    expect(() =>
      decideCandidateReview(ticket, {
        approverId: 'judge-1',
        role: 'EXTERNAL_JUDGE',
        outcome: 'REJECTED',
        decidedAt: '2026-10-05T21:30:00.000Z',
      }),
    ).toThrow(/APPROVAL_VERDICT_REPLAY_BLOCKED/);
    expect(CANDIDATE_APPROVAL_BOUNDARY.replayProtection).toBe('ONE_VERDICT_PER_TICKET');
    expect(CANDIDATE_APPROVAL_BOUNDARY.singleUse).toBe(true);
  });

  it('P5U1_7 过期与时间序：过期后判决 / 早于请求时间判决 → REJECT', async () => {
    const candidate = await makeCandidate();
    const expired = openCandidateReviewTicket(candidate, approver(), schedule());
    expect(() =>
      decideCandidateReview(expired, {
        approverId: 'judge-1',
        role: 'EXTERNAL_JUDGE',
        outcome: 'APPROVED',
        decidedAt: '2026-10-07T00:00:00.000Z',
      }),
    ).toThrow(/APPROVAL_VERDICT_TICKET_EXPIRED/);

    const early = openCandidateReviewTicket(candidate, approver(), schedule());
    expect(() =>
      decideCandidateReview(early, {
        approverId: 'judge-1',
        role: 'EXTERNAL_JUDGE',
        outcome: 'APPROVED',
        decidedAt: '2026-10-05T19:00:00.000Z',
      }),
    ).toThrow(/APPROVAL_VERDICT_DECIDED_BEFORE_REQUEST/);
    expect(() =>
      decideCandidateReview(openCandidateReviewTicket(candidate, approver(), schedule()), {
        approverId: 'judge-1',
        role: 'EXTERNAL_JUDGE',
        outcome: 'MAYBE' as never,
        decidedAt: '2026-10-05T21:00:00.000Z',
      }),
    ).toThrow(/APPROVAL_VERDICT_OUTCOME_INVALID/);
  });

  it('P5U1_8 approver 不匹配：不同 approverId 或不同角色 → REJECT', async () => {
    const candidate = await makeCandidate();
    const ticket = openCandidateReviewTicket(candidate, approver(), schedule());
    expect(() =>
      decideCandidateReview(ticket, {
        approverId: 'someone-else',
        role: 'EXTERNAL_JUDGE',
        outcome: 'APPROVED',
        decidedAt: '2026-10-05T21:00:00.000Z',
      }),
    ).toThrow(/APPROVAL_VERDICT_APPROVER_MISMATCH/);
    expect(() =>
      decideCandidateReview(ticket, {
        approverId: 'judge-1',
        role: 'HUMAN_OPERATOR',
        outcome: 'APPROVED',
        decidedAt: '2026-10-05T21:00:00.000Z',
      }),
    ).toThrow(/APPROVAL_VERDICT_APPROVER_MISMATCH/);
    expect(isDecidedTicket(ticket)).toBe(false);
  });

  it('P5U1_9 撤销单向不可逆：撤销后不得判决；重复撤销 / 判决后撤销 → REJECT', async () => {
    const candidate = await makeCandidate();
    const ticket = openCandidateReviewTicket(candidate, approver(), schedule());
    const revocation = revokeCandidateReview(ticket, {
      revokedBy: 'host-operator',
      revokedAt: '2026-10-05T20:30:00.000Z',
      reason: 'evidence revoked upstream',
    });
    expect(revocation.kind).toBe('CANDIDATE_REVIEW_REVOCATION');
    expect(isRevokedTicket(ticket)).toBe(true);
    expect(() =>
      decideCandidateReview(ticket, {
        approverId: 'judge-1',
        role: 'EXTERNAL_JUDGE',
        outcome: 'APPROVED',
        decidedAt: '2026-10-05T21:00:00.000Z',
      }),
    ).toThrow(/APPROVAL_VERDICT_TICKET_REVOKED/);
    expect(() =>
      revokeCandidateReview(ticket, { revokedBy: 'host-operator', revokedAt: '2026-10-05T20:40:00.000Z' }),
    ).toThrow(/APPROVAL_TICKET_ALREADY_REVOKED/);

    const decided = openCandidateReviewTicket(candidate, approver(), schedule({ nonce: 'nonce-2' }));
    decideCandidateReview(decided, {
      approverId: 'judge-1',
      role: 'EXTERNAL_JUDGE',
      outcome: 'APPROVED',
      decidedAt: '2026-10-05T21:00:00.000Z',
    });
    expect(() =>
      revokeCandidateReview(decided, { revokedBy: 'host-operator', revokedAt: '2026-10-05T21:10:00.000Z' }),
    ).toThrow(/APPROVAL_TICKET_ALREADY_DECIDED/);
  });

  it('P5U1_10 边界：无 apply / promote / rollout 入口；四类 mutation FORBIDDEN；无外部 Judge / 人工批准不得采用', async () => {
    const mod = (await import('../services/outcome-learning/candidate-approval')) as unknown as Record<string, unknown>;
    for (const key of [
      'applyVerdict',
      'applyCandidate',
      'promoteCandidate',
      'executeCandidate',
      'rolloutCandidate',
      'mutatePolicy',
      'adoptCandidate',
    ]) {
      expect(mod[key]).toBeUndefined();
    }
    expect(CANDIDATE_APPROVAL_BOUNDARY.mode).toBe('REVIEW_AND_VERDICT_ONLY');
    expect(CANDIDATE_APPROVAL_BOUNDARY.autoApply).toBe(false);
    expect(CANDIDATE_APPROVAL_BOUNDARY.autoPromotion).toBe('OFF');
    expect(CANDIDATE_APPROVAL_BOUNDARY.policyMutation).toBe('FORBIDDEN');
    expect(CANDIDATE_APPROVAL_BOUNDARY.guardMutation).toBe('FORBIDDEN');
    expect(CANDIDATE_APPROVAL_BOUNDARY.routerMutation).toBe('FORBIDDEN');
    expect(CANDIDATE_APPROVAL_BOUNDARY.actionRuntimeMutation).toBe('FORBIDDEN');
    expect(CANDIDATE_APPROVAL_BOUNDARY.productionRollout).toBe('FORBIDDEN');
    expect(CANDIDATE_APPROVAL_BOUNDARY.bypassExternalJudgeOrHuman).toBe('FORBIDDEN');
    expect(CANDIDATE_APPROVAL_BOUNDARY.adoption).toBe('CONTROLLED_ADOPTION_PROPOSAL_REQUIRED');
    expect(CANDIDATE_APPROVAL_BOUNDARY.binds).toContain('candidateDigest');
    expect(CANDIDATE_APPROVAL_BOUNDARY.binds).toContain('verdictDigest');
  });
});
