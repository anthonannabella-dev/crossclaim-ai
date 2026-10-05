/**
 * PHASE 5 U5 —— Controlled Adoption Review（REVIEW_ONLY）
 * 冻结门来源：MSG-20261005-81 NEXT。即使 APPROVED 也仅表示
 * APPROVED_FOR_CONTROLLED_ADOPTION_PLANNING：不得 APPLIED / PROMOTED / DEPLOYED，
 * apply / autoPromotion / productionRollout / Policy·Guard·Router·Action Runtime mutation 全 FORBIDDEN。
 */

import { createHash } from 'node:crypto';

import { isVerifiedCanaryShadowEvaluation, type CanaryShadowEvaluation } from './canary-shadow-evaluation';
import {
  isVerifiedControlledConfigProposal,
  type ControlledConfigProposal,
} from './controlled-config-proposal';
import { isVerifiedRollbackPlan, type RollbackPlan } from './rollback-plan';

export const CONTROLLED_ADOPTION_REVIEW_VERSION = 'controlled-adoption-review/v1';
export const CONTROLLED_ADOPTION_REVIEW_SCOPE = 'CONTROLLED_ADOPTION_REVIEW';
export const CONTROLLED_ADOPTION_REVIEW_ROLES = ['EXTERNAL_JUDGE', 'HUMAN_OPERATOR'] as const;
export const CONTROLLED_ADOPTION_OUTCOMES = ['APPROVED', 'REJECTED'] as const;

export const CONTROLLED_ADOPTION_REVIEW_BOUNDARY = {
  mode: 'REVIEW_ONLY',
  inputGate: 'verified canary (ELIGIBLE_FOR_CONTROLLED_ADOPTION_REVIEW, no triggers, insufficientEvidence=false) + verified proposal (digest match) + verified rollback plan (digest match, baseline identity identical)',
  forbiddenEntry: ['ROLLBACK_REQUIRED', 'INSUFFICIENT_EVIDENCE', 'provenance mismatch', 'proposal mismatch', 'rollback mismatch'],
  scope: CONTROLLED_ADOPTION_REVIEW_SCOPE,
  roles: CONTROLLED_ADOPTION_REVIEW_ROLES,
  approvalSemantics: 'APPROVED_FOR_CONTROLLED_ADOPTION_PLANNING',
  rejectedSemantics: 'REJECTED_NO_CONTROLLED_ADOPTION_PLAN',
  apply: 'FORBIDDEN',
  autoPromotion: 'FORBIDDEN',
  productionRollout: 'FORBIDDEN',
  policyMutation: 'FORBIDDEN',
  guardMutation: 'FORBIDDEN',
  routerMutation: 'FORBIDDEN',
  actionRuntimeMutation: 'FORBIDDEN',
  replayProtection: 'ONE_REVIEW_TICKET_TO_ONE_FINAL_VERDICT（digest-keyed）',
  expiry: 'ENFORCED',
  revocation: 'ENFORCED_ONE_WAY',
  binds: [
    'canaryEvaluationDigest',
    'proposalDigest',
    'candidateDigest',
    'verdictDigest',
    'rollbackPlanDigest',
    'baselineSnapshotDigest',
    'baselineConfigFingerprint',
    'cohortDigest',
    'baselineEvaluationDigest',
    'proposalEvaluationDigest',
    'requestedAt',
    'expiresAt',
    'nonce',
    'reviewerScope',
  ],
  ticketProvenance: 'PROVENANCE_REGISTERED + fingerprint + deep-freeze',
  verdictProvenance: 'PROVENANCE_REGISTERED + fingerprint + deep-freeze（clone / 手造 APPROVED 不可信）',
  productionWrite: 'HOLD',
} as const;

export interface ControlledAdoptionReviewTicket {
  kind: 'CONTROLLED_ADOPTION_REVIEW_TICKET';
  ticketId: string;
  ticketDigest: string;
  canaryEvaluationDigest: string;
  proposalDigest: string;
  candidateDigest: string;
  verdictDigest: string;
  rollbackPlanDigest: string;
  baselineSnapshotDigest: string;
  baselineConfigFingerprint: string;
  cohortDigest: string;
  baselineEvaluationDigest: string;
  proposalEvaluationDigest: string;
  requestedAt: string;
  expiresAt: string;
  nonce: string;
  reviewerScope: typeof CONTROLLED_ADOPTION_REVIEW_SCOPE;
}

export interface ControlledAdoptionReviewVerdict {
  kind: 'CONTROLLED_ADOPTION_REVIEW_VERDICT';
  verdictId: string;
  verdictDigest: string;
  ticketId: string;
  ticketDigest: string;
  outcome: 'APPROVED' | 'REJECTED';
  canaryEvaluationDigest: string;
  proposalDigest: string;
  rollbackPlanDigest: string;
  reviewerId: string;
  role: (typeof CONTROLLED_ADOPTION_REVIEW_ROLES)[number];
  scope: typeof CONTROLLED_ADOPTION_REVIEW_SCOPE;
  decidedAt: string;
  reason: string | null;
  semantics: 'APPROVED_FOR_CONTROLLED_ADOPTION_PLANNING' | 'REJECTED_NO_CONTROLLED_ADOPTION_PLAN';
  execution: {
    apply: 'FORBIDDEN';
    autoPromotion: 'FORBIDDEN';
    productionRollout: 'FORBIDDEN';
    mutation: { policy: 'FORBIDDEN'; guard: 'FORBIDDEN'; router: 'FORBIDDEN'; actionRuntime: 'FORBIDDEN' };
  };
}

const VERIFIED_CAT_TICKETS = new WeakSet<ControlledAdoptionReviewTicket>();
const VERIFIED_CAT_TICKET_FINGERPRINTS = new WeakMap<ControlledAdoptionReviewTicket, string>();
const VERIFIED_CAT_VERDICTS = new WeakSet<ControlledAdoptionReviewVerdict>();
const VERIFIED_CAT_VERDICT_FINGERPRINTS = new WeakMap<ControlledAdoptionReviewVerdict, string>();
const CAT_DECIDED_TICKET_DIGESTS = new Set<string>();
const CAT_REVOKED_TICKET_DIGESTS = new Set<string>();

const requireText = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : '');
const digest = (label: string, parts: readonly string[]): string =>
  label + ':' + createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
const isIso = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));

const ticketFingerprint = (t: ControlledAdoptionReviewTicket): string => JSON.stringify({ ...t });
const verdictFingerprint = (v: ControlledAdoptionReviewVerdict): string =>
  JSON.stringify({ ...v, execution: { ...v.execution, mutation: { ...v.execution.mutation } } });

export function isVerifiedControlledAdoptionReviewTicket(
  ticket: ControlledAdoptionReviewTicket | null | undefined,
): boolean {
  if (ticket === null || ticket === undefined) return false;
  if (!VERIFIED_CAT_TICKETS.has(ticket)) return false;
  const fingerprint = VERIFIED_CAT_TICKET_FINGERPRINTS.get(ticket);
  if (fingerprint === undefined) return false;
  try {
    return fingerprint === ticketFingerprint(ticket);
  } catch {
    return false;
  }
}

export function isVerifiedControlledAdoptionReviewVerdict(
  verdict: ControlledAdoptionReviewVerdict | null | undefined,
): boolean {
  if (verdict === null || verdict === undefined) return false;
  if (!VERIFIED_CAT_VERDICTS.has(verdict)) return false;
  const fingerprint = VERIFIED_CAT_VERDICT_FINGERPRINTS.get(verdict);
  if (fingerprint === undefined) return false;
  try {
    return fingerprint === verdictFingerprint(verdict);
  } catch {
    return false;
  }
}

const catFreeze = <T extends object>(value: T, nested: ReadonlyArray<object> = []): T => {
  nested.forEach((item) => Object.freeze(item));
  return Object.freeze(value);
};

/** 冻结门：只有 verified eligible canary + verified proposal + verified rollback plan 才能开 review ticket。 */
export function openControlledAdoptionReviewTicket(input: {
  canary: CanaryShadowEvaluation | null | undefined;
  proposal: ControlledConfigProposal | null | undefined;
  rollbackPlan: RollbackPlan | null | undefined;
  reviewerScope: string;
  requestedAt: string;
  expiresAt: string;
  nonce: string;
} | null | undefined): ControlledAdoptionReviewTicket {
  if (input === null || input === undefined) throw new Error('CAT_REVIEW_INPUT_REQUIRED');
  const canary = input.canary;
  if (!isVerifiedCanaryShadowEvaluation(canary)) throw new Error('CAT_REVIEW_CANARY_NOT_VERIFIED');
  const canaryResult = canary as CanaryShadowEvaluation;
  if (canaryResult.recommendation !== 'ELIGIBLE_FOR_CONTROLLED_ADOPTION_REVIEW') {
    throw new Error('CAT_REVIEW_CANARY_NOT_ELIGIBLE:' + canaryResult.recommendation);
  }
  if (canaryResult.insufficientEvidence !== false) throw new Error('CAT_REVIEW_INSUFFICIENT_EVIDENCE');
  if (canaryResult.triggers.length !== 0) throw new Error('CAT_REVIEW_TRIGGERS_PRESENT:' + canaryResult.triggers.join('+'));
  if (!isVerifiedControlledConfigProposal(input.proposal)) throw new Error('CAT_REVIEW_PROPOSAL_NOT_VERIFIED');
  const proposal = input.proposal as ControlledConfigProposal;
  if (proposal.proposalDigest !== canaryResult.proposalDigest) throw new Error('CAT_REVIEW_PROPOSAL_MISMATCH');
  if (!isVerifiedRollbackPlan(input.rollbackPlan)) throw new Error('CAT_REVIEW_ROLLBACK_PLAN_NOT_VERIFIED');
  const plan = input.rollbackPlan as RollbackPlan;
  if (plan.rollbackPlanDigest !== canaryResult.rollbackPlanDigest) throw new Error('CAT_REVIEW_ROLLBACK_MISMATCH');
  if (
    plan.baselineSnapshotDigest !== canaryResult.baselineSnapshotDigest ||
    plan.baselineConfigFingerprint !== canaryResult.baselineConfigFingerprint
  ) {
    throw new Error('CAT_REVIEW_BASELINE_IDENTITY_MISMATCH');
  }
  if (requireText(input.reviewerScope) !== CONTROLLED_ADOPTION_REVIEW_SCOPE) {
    throw new Error('CAT_REVIEW_SCOPE_NOT_ALLOWED:' + requireText(input.reviewerScope));
  }
  const nonce = requireText(input.nonce);
  if (nonce === '') throw new Error('CAT_REVIEW_NONCE_REQUIRED');
  if (!isIso(input.requestedAt) || !isIso(input.expiresAt)) throw new Error('CAT_REVIEW_SCHEDULE_INVALID');
  if (Date.parse(input.expiresAt) <= Date.parse(input.requestedAt)) throw new Error('CAT_REVIEW_EXPIRY_INVALID');

  const ticketDigest = digest('controlled-adoption-review-ticket', [
    CONTROLLED_ADOPTION_REVIEW_VERSION,
    canaryResult.evaluationDigest,
    proposal.proposalDigest,
    proposal.candidateDigest,
    proposal.verdictDigest,
    plan.rollbackPlanDigest,
    plan.baselineSnapshotDigest,
    plan.baselineConfigFingerprint,
    canaryResult.cohortDigest,
    canaryResult.baselineEvaluationDigest,
    canaryResult.proposalEvaluationDigest,
    input.requestedAt,
    input.expiresAt,
    nonce,
    CONTROLLED_ADOPTION_REVIEW_SCOPE,
  ]);
  const ticket: ControlledAdoptionReviewTicket = {
    kind: 'CONTROLLED_ADOPTION_REVIEW_TICKET',
    ticketId: 'controlled-adoption-review:' + ticketDigest,
    ticketDigest,
    canaryEvaluationDigest: canaryResult.evaluationDigest,
    proposalDigest: proposal.proposalDigest,
    candidateDigest: proposal.candidateDigest,
    verdictDigest: proposal.verdictDigest,
    rollbackPlanDigest: plan.rollbackPlanDigest,
    baselineSnapshotDigest: plan.baselineSnapshotDigest,
    baselineConfigFingerprint: plan.baselineConfigFingerprint,
    cohortDigest: canaryResult.cohortDigest,
    baselineEvaluationDigest: canaryResult.baselineEvaluationDigest,
    proposalEvaluationDigest: canaryResult.proposalEvaluationDigest,
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt,
    nonce,
    reviewerScope: CONTROLLED_ADOPTION_REVIEW_SCOPE,
  };
  catFreeze(ticket);
  VERIFIED_CAT_TICKETS.add(ticket);
  VERIFIED_CAT_TICKET_FINGERPRINTS.set(ticket, ticketFingerprint(ticket));
  return ticket;
}

export function isControlledAdoptionReviewDecided(ticket: ControlledAdoptionReviewTicket | null | undefined): boolean {
  return ticket !== null && ticket !== undefined && CAT_DECIDED_TICKET_DIGESTS.has(requireText(ticket.ticketDigest));
}

export function isControlledAdoptionReviewRevoked(ticket: ControlledAdoptionReviewTicket | null | undefined): boolean {
  return ticket !== null && ticket !== undefined && CAT_REVOKED_TICKET_DIGESTS.has(requireText(ticket.ticketDigest));
}

export function revokeControlledAdoptionReview(
  ticket: ControlledAdoptionReviewTicket | null | undefined,
  revocation: { revokedBy: string; revokedAt: string; reason?: string | null },
): { ticketDigest: string; revokedBy: string; revokedAt: string; reason: string | null } {
  if (!isVerifiedControlledAdoptionReviewTicket(ticket)) throw new Error('CAT_REVIEW_TICKET_NOT_VERIFIED');
  const verified = ticket as ControlledAdoptionReviewTicket;
  if (isControlledAdoptionReviewRevoked(verified)) throw new Error('CAT_REVIEW_TICKET_ALREADY_REVOKED');
  if (isControlledAdoptionReviewDecided(verified)) throw new Error('CAT_REVIEW_TICKET_ALREADY_DECIDED');
  const revokedBy = requireText(revocation?.revokedBy);
  if (revokedBy === '') throw new Error('CAT_REVIEW_REVOCATION_ACTOR_REQUIRED');
  if (!isIso(revocation?.revokedAt)) throw new Error('CAT_REVIEW_REVOCATION_TIME_INVALID');
  CAT_REVOKED_TICKET_DIGESTS.add(verified.ticketDigest);
  return { ticketDigest: verified.ticketDigest, revokedBy, revokedAt: revocation.revokedAt, reason: requireText(revocation?.reason) || null };
}

/** 判决：只产出 APPROVED / REJECTED（语义永远是 PLANNING），不执行任何配置变更。 */
export function decideControlledAdoptionReview(
  ticket: ControlledAdoptionReviewTicket | null | undefined,
  decision: {
    reviewerId: string;
    role: (typeof CONTROLLED_ADOPTION_REVIEW_ROLES)[number];
    outcome: 'APPROVED' | 'REJECTED';
    decidedAt: string;
    reason?: string | null;
  },
): ControlledAdoptionReviewVerdict {
  if (!isVerifiedControlledAdoptionReviewTicket(ticket)) throw new Error('CAT_REVIEW_TICKET_NOT_VERIFIED');
  const verified = ticket as ControlledAdoptionReviewTicket;
  if (isControlledAdoptionReviewRevoked(verified)) throw new Error('CAT_REVIEW_VERDICT_TICKET_REVOKED');
  if (isControlledAdoptionReviewDecided(verified)) throw new Error('CAT_REVIEW_VERDICT_REPLAY_BLOCKED');
  if (!CONTROLLED_ADOPTION_REVIEW_ROLES.includes(decision?.role)) throw new Error('CAT_REVIEW_ROLE_NOT_ALLOWED');
  if (!CONTROLLED_ADOPTION_OUTCOMES.includes(decision?.outcome)) throw new Error('CAT_REVIEW_OUTCOME_INVALID');
  const reviewerId = requireText(decision?.reviewerId);
  if (reviewerId === '') throw new Error('CAT_REVIEW_REVIEWER_REQUIRED');
  if (!isIso(decision?.decidedAt)) throw new Error('CAT_REVIEW_VERDICT_TIME_INVALID');
  const decidedMs = Date.parse(decision.decidedAt);
  if (decidedMs < Date.parse(verified.requestedAt)) throw new Error('CAT_REVIEW_VERDICT_DECIDED_BEFORE_REQUEST');
  if (decidedMs > Date.parse(verified.expiresAt)) throw new Error('CAT_REVIEW_VERDICT_TICKET_EXPIRED');

  const reason = requireText(decision?.reason) || null;
  const verdictDigest = digest('controlled-adoption-review-verdict', [
    CONTROLLED_ADOPTION_REVIEW_VERSION,
    verified.ticketDigest,
    verified.canaryEvaluationDigest,
    verified.proposalDigest,
    verified.rollbackPlanDigest,
    decision.outcome,
    reviewerId,
    decision.role,
    verified.reviewerScope,
    decision.decidedAt,
    reason ?? '',
  ]);
  const verdict: ControlledAdoptionReviewVerdict = {
    kind: 'CONTROLLED_ADOPTION_REVIEW_VERDICT',
    verdictId: 'controlled-adoption-review-verdict:' + verdictDigest,
    verdictDigest,
    ticketId: verified.ticketId,
    ticketDigest: verified.ticketDigest,
    outcome: decision.outcome,
    canaryEvaluationDigest: verified.canaryEvaluationDigest,
    proposalDigest: verified.proposalDigest,
    rollbackPlanDigest: verified.rollbackPlanDigest,
    reviewerId,
    role: decision.role,
    scope: verified.reviewerScope,
    decidedAt: decision.decidedAt,
    reason,
    semantics:
      decision.outcome === 'APPROVED'
        ? 'APPROVED_FOR_CONTROLLED_ADOPTION_PLANNING'
        : 'REJECTED_NO_CONTROLLED_ADOPTION_PLAN',
    execution: {
      apply: 'FORBIDDEN',
      autoPromotion: 'FORBIDDEN',
      productionRollout: 'FORBIDDEN',
      mutation: { policy: 'FORBIDDEN', guard: 'FORBIDDEN', router: 'FORBIDDEN', actionRuntime: 'FORBIDDEN' },
    },
  };
  catFreeze(verdict, [verdict.execution.mutation, verdict.execution]);
  VERIFIED_CAT_VERDICTS.add(verdict);
  VERIFIED_CAT_VERDICT_FINGERPRINTS.set(verdict, verdictFingerprint(verdict));
  CAT_DECIDED_TICKET_DIGESTS.add(verified.ticketDigest);
  return verdict;
}
