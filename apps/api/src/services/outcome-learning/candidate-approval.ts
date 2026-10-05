/**
 * PHASE 5 U1 —— Candidate Review + Approval Verdict Contract
 * ---------------------------------------------------------------
 * PHASE 5 进入条件（MSG-20261005-67 冻结）：
 *   Verified Immutable Evidence → Verified Offline Evaluation → PROPOSAL_ONLY Candidate
 *   → **External Judge / Human Approval** → Controlled Adoption Proposal。
 *
 * 本单元只实现“评审 + 判决”契约：
 *   - 谁能批准（approver 身份 + 角色 + scope）；
 *   - 批准绑定什么（candidateDigest + evaluationDigest + evidenceSetDigest + ticketDigest/verdictDigest）；
 *   - 是否一次性（single-use）与防 replay（每个 ticket 只能判决一次）；
 *   - 过期（expiresAt）与撤销（revocation，单向不可逆）。
 *
 * 明确不做：本模块**不提供任何 apply / promote / rollout / mutate 入口**，判决结果只携带
 * execution = { autoApply: false, promotion: 'OFF', mutation 全 FORBIDDEN, adoption: 'CONTROLLED_ADOPTION_PROPOSAL_REQUIRED' }；
 * 任何真正变更都必须另经 Controlled Adoption Proposal + 人工边界。
 */

import { createHash } from 'node:crypto';

import {
  META_CANDIDATE_STATUS,
  isVerifiedMetaImprovementCandidate,
  type MetaImprovementCandidate,
} from './meta-improvement-candidate';

export const CANDIDATE_APPROVAL_VERSION = 'candidate-approval/v1';

export const CANDIDATE_APPROVAL_BOUNDARY = {
  mode: 'REVIEW_AND_VERDICT_ONLY',
  chain: 'verified evidence → verified evaluation → PROPOSAL_ONLY candidate → external judge / human approval → controlled adoption proposal',
  autoApply: false,
  autoPromotion: 'OFF',
  policyMutation: 'FORBIDDEN',
  guardMutation: 'FORBIDDEN',
  routerMutation: 'FORBIDDEN',
  actionRuntimeMutation: 'FORBIDDEN',
  productionRollout: 'FORBIDDEN',
  bypassExternalJudgeOrHuman: 'FORBIDDEN',
  selfApproval: 'FORBIDDEN（proposer/automation 不得作为 approver）',
  singleUse: true,
  replayProtection: 'ONE_VERDICT_PER_TICKET_DIGEST',
  ticketProvenance: 'PROVENANCE_REGISTERED（只可由 openCandidateReviewTicket 产生）+ fingerprint + deep-freeze',
  candidateProvenance: 'PROVENANCE_REGISTERED（只接受 U5 isVerifiedMetaImprovementCandidate === true）',
  approverScopes: ["META_IMPROVEMENT_PROPOSAL_ONLY"],
  binds: ['candidateDigest', 'evaluationDigest', 'evidenceSetDigest', 'nonce', 'ticketDigest', 'verdictDigest'],
  expiry: 'ENFORCED（expiresAt 必须晚于 requestedAt；过期后不得判决）',
  revocation: 'ENFORCED_ONE_WAY（撤销后不可恢复、不可判决）',
  adoption: 'CONTROLLED_ADOPTION_PROPOSAL_REQUIRED',
  productionWrite: 'HOLD',
} as const;

export const APPROVER_ROLES = ['EXTERNAL_JUDGE', 'HUMAN_OPERATOR'] as const;
export type ApproverRole = (typeof APPROVER_ROLES)[number];

export const APPROVER_SCOPES = ['META_IMPROVEMENT_PROPOSAL_ONLY'] as const;
export const REQUIRED_APPROVER_SCOPE = 'META_IMPROVEMENT_PROPOSAL_ONLY' as const;

export const VERDICT_OUTCOMES = ['APPROVED', 'REJECTED'] as const;
export type VerdictOutcome = (typeof VERDICT_OUTCOMES)[number];

export interface ApproverIdentity {
  approverId: string;
  role: ApproverRole;
  /** 批准范围（例如 ['META_IMPROVEMENT_PROPOSAL_ONLY']），必须非空。 */
  scope: readonly string[];
}

export interface CandidateReviewTicket {
  kind: 'CANDIDATE_REVIEW_TICKET';
  ticketId: string;
  ticketDigest: string;
  status: 'PENDING';
  candidateDigest: string;
  candidateTarget: string;
  candidateKind: string;
  evaluationDigest: string;
  evidenceSetDigest: string;
  approverId: string;
  role: ApproverRole;
  scope: readonly string[];
  requestedAt: string;
  expiresAt: string;
  nonce: string;
}

export interface ApprovalVerdictExecution {
  autoApply: false;
  promotion: 'OFF';
  mutation: {
    policy: 'FORBIDDEN';
    guard: 'FORBIDDEN';
    router: 'FORBIDDEN';
    actionRuntime: 'FORBIDDEN';
  };
  productionRollout: 'FORBIDDEN';
  adoption: 'CONTROLLED_ADOPTION_PROPOSAL_REQUIRED';
}

export interface ApprovalVerdict {
  kind: 'APPROVAL_VERDICT';
  verdictId: string;
  verdictDigest: string;
  ticketId: string;
  ticketDigest: string;
  outcome: VerdictOutcome;
  candidateDigest: string;
  evaluationDigest: string;
  evidenceSetDigest: string;
  nonce: string;
  approverId: string;
  role: ApproverRole;
  decidedAt: string;
  reason: string | null;
  execution: ApprovalVerdictExecution;
}

export interface CandidateRevocation {
  kind: 'CANDIDATE_REVIEW_REVOCATION';
  ticketId: string;
  ticketDigest: string;
  revokedBy: string;
  revokedAt: string;
  reason: string | null;
}

const DECIDED_TICKET_DIGESTS = new Set<string>();
const REVOKED_TICKET_DIGESTS = new Set<string>();
const VERIFIED_CANDIDATE_REVIEW_TICKETS = new WeakSet<CandidateReviewTicket>();
const VERIFIED_CANDIDATE_REVIEW_TICKET_FINGERPRINTS = new WeakMap<CandidateReviewTicket, string>();

/** canonical fingerprint：覆盖判决/撤销路径实际消费的所有字段（U1 FINAL anti-tamper）。 */
const ticketFingerprint = (ticket: CandidateReviewTicket): string =>
  JSON.stringify({
    kind: ticket.kind,
    ticketId: ticket.ticketId,
    ticketDigest: ticket.ticketDigest,
    status: ticket.status,
    candidateDigest: ticket.candidateDigest,
    candidateTarget: ticket.candidateTarget,
    candidateKind: ticket.candidateKind,
    evaluationDigest: ticket.evaluationDigest,
    evidenceSetDigest: ticket.evidenceSetDigest,
    approverId: ticket.approverId,
    role: ticket.role,
    scope: [...ticket.scope],
    requestedAt: ticket.requestedAt,
    expiresAt: ticket.expiresAt,
    nonce: ticket.nonce,
  });

const freezeTicket = (ticket: CandidateReviewTicket): void => {
  Object.freeze(ticket.scope);
  Object.freeze(ticket);
};

/** 只读 provenance：只有 openCandidateReviewTicket() 产生的 ticket 才为 true。 */
export function isVerifiedCandidateReviewTicket(
  ticket: CandidateReviewTicket | null | undefined,
): boolean {
  if (ticket === null || ticket === undefined) return false;
  if (!VERIFIED_CANDIDATE_REVIEW_TICKETS.has(ticket)) return false;
  const fingerprint = VERIFIED_CANDIDATE_REVIEW_TICKET_FINGERPRINTS.get(ticket);
  if (fingerprint === undefined) return false;
  try {
    return fingerprint === ticketFingerprint(ticket);
  } catch {
    return false;
  }
}

const requireText = (value: unknown): string => (typeof value === 'string' && value.trim() !== '' ? value.trim() : '');

const digest = (label: string, parts: readonly string[]): string =>
  label + ':' + createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);

const isIsoDate = (value: unknown): boolean =>
  typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));

const FORBIDDEN_EXECUTION: ApprovalVerdictExecution = {
  autoApply: false,
  promotion: 'OFF',
  mutation: {
    policy: 'FORBIDDEN',
    guard: 'FORBIDDEN',
    router: 'FORBIDDEN',
    actionRuntime: 'FORBIDDEN',
  },
  productionRollout: 'FORBIDDEN',
  adoption: 'CONTROLLED_ADOPTION_PROPOSAL_REQUIRED',
};

/**
 * 开启候选评审票据（只接受 U5 产出的 PROPOSAL_ONLY candidate）。
 * fail-closed：candidate 非法 / 非 PROPOSAL_ONLY / mutation 未全 FORBIDDEN /
 * approver 缺失或角色越权 / scope 空 / nonce 空 / 过期时间非法 → 一律 REJECT。
 */
export function openCandidateReviewTicket(
  candidate: MetaImprovementCandidate | null | undefined,
  approver: ApproverIdentity | null | undefined,
  schedule: { requestedAt: string; expiresAt: string; nonce: string },
): CandidateReviewTicket {
  if (candidate === null || candidate === undefined || typeof candidate !== 'object') {
    throw new Error('APPROVAL_TICKET_CANDIDATE_REQUIRED');
  }
  if (candidate.candidateStatus !== META_CANDIDATE_STATUS) {
    throw new Error('APPROVAL_TICKET_CANDIDATE_NOT_PROPOSAL_ONLY');
  }
  const candidateDigest = requireText(candidate.candidateDigest);
  const evaluationDigest = requireText(candidate.evaluationDigest);
  const evidenceSetDigest = requireText(candidate.evidenceSetDigest);
  if (candidateDigest === '' || evaluationDigest === '' || evidenceSetDigest === '') {
    throw new Error('APPROVAL_TICKET_CANDIDATE_BINDING_REQUIRED');
  }
  const mutation = candidate.mutation;
  if (
    mutation?.policy !== 'FORBIDDEN' ||
    mutation?.guard !== 'FORBIDDEN' ||
    mutation?.router !== 'FORBIDDEN' ||
    mutation?.actionRuntime !== 'FORBIDDEN' ||
    candidate.autoApply !== false
  ) {
    throw new Error('APPROVAL_TICKET_CANDIDATE_MUTATION_FORBIDDEN');
  }
  if (approver === null || approver === undefined || typeof approver !== 'object') {
    throw new Error('APPROVAL_TICKET_APPROVER_REQUIRED');
  }
  const approverId = requireText(approver.approverId);
  if (approverId === '') throw new Error('APPROVAL_TICKET_APPROVER_REQUIRED');
  if (!APPROVER_ROLES.includes(approver.role)) {
    // 自动化 / 系统身份不得作为批准者（防自动批准）
    throw new Error('APPROVAL_TICKET_APPROVER_ROLE_FORBIDDEN');
  }
  const scope = Array.isArray(approver.scope) ? approver.scope.map((item) => requireText(item)).filter((item) => item !== '') : [];
  if (scope.length === 0) throw new Error('APPROVAL_TICKET_SCOPE_REQUIRED');
  if (
    !scope.includes(REQUIRED_APPROVER_SCOPE) ||
    scope.some((item) => !(APPROVER_SCOPES as readonly string[]).includes(item))
  ) {
    throw new Error('APPROVAL_TICKET_SCOPE_NOT_ALLOWED:' + scope.join(','));
  }
  const nonce = requireText(schedule?.nonce);
  if (nonce === '') throw new Error('APPROVAL_TICKET_NONCE_REQUIRED');
  if (!isIsoDate(schedule?.requestedAt) || !isIsoDate(schedule?.expiresAt)) {
    throw new Error('APPROVAL_TICKET_SCHEDULE_INVALID');
  }
  if (Date.parse(schedule.expiresAt) <= Date.parse(schedule.requestedAt)) {
    throw new Error('APPROVAL_TICKET_EXPIRY_INVALID');
  }

  if (!isVerifiedMetaImprovementCandidate(candidate)) {
    throw new Error('APPROVAL_TICKET_CANDIDATE_NOT_VERIFIED');
  }
  const ticketDigest = digest('candidate-review', [
    CANDIDATE_APPROVAL_VERSION,
    candidateDigest,
    evaluationDigest,
    evidenceSetDigest,
    approverId,
    approver.role,
    scope.join('+'),
    schedule.requestedAt,
    schedule.expiresAt,
    nonce,
  ]);
  const ticket: CandidateReviewTicket = {
    kind: 'CANDIDATE_REVIEW_TICKET',
    ticketId: 'candidate-review:' + ticketDigest,
    ticketDigest,
    status: 'PENDING',
    candidateDigest,
    candidateTarget: requireText(candidate.target),
    candidateKind: requireText(candidate.kind),
    evaluationDigest,
    evidenceSetDigest,
    approverId,
    role: approver.role,
    scope,
    requestedAt: schedule.requestedAt,
    expiresAt: schedule.expiresAt,
    nonce,
  };
  freezeTicket(ticket);
  VERIFIED_CANDIDATE_REVIEW_TICKETS.add(ticket);
  VERIFIED_CANDIDATE_REVIEW_TICKET_FINGERPRINTS.set(ticket, ticketFingerprint(ticket));
  return ticket;
}

/** 只读：该 ticket 是否已判决（single-use）。 */
export function isDecidedTicket(ticket: CandidateReviewTicket | null | undefined): boolean {
  return (
    ticket !== null &&
    ticket !== undefined &&
    requireText(ticket.ticketDigest) !== '' &&
    DECIDED_TICKET_DIGESTS.has(ticket.ticketDigest)
  );
}

/** 只读：该 ticket 是否已撤销。 */
export function isRevokedTicket(ticket: CandidateReviewTicket | null | undefined): boolean {
  return (
    ticket !== null &&
    ticket !== undefined &&
    requireText(ticket.ticketDigest) !== '' &&
    REVOKED_TICKET_DIGESTS.has(ticket.ticketDigest)
  );
}

/** 撤销评审（单向、不可恢复）；撤销后不得判决。 */
export function revokeCandidateReview(
  ticket: CandidateReviewTicket | null | undefined,
  revocation: { revokedBy: string; revokedAt: string; reason?: string | null },
): CandidateRevocation {
  if (ticket === null || ticket === undefined || typeof ticket !== 'object' || requireText(ticket.ticketDigest) === '') {
    throw new Error('APPROVAL_TICKET_REQUIRED');
  }
  if (!isVerifiedCandidateReviewTicket(ticket)) throw new Error('APPROVAL_TICKET_NOT_VERIFIED');
  if (isRevokedTicket(ticket)) throw new Error('APPROVAL_TICKET_ALREADY_REVOKED');
  if (isDecidedTicket(ticket)) throw new Error('APPROVAL_TICKET_ALREADY_DECIDED');
  const revokedBy = requireText(revocation?.revokedBy);
  if (revokedBy === '') throw new Error('APPROVAL_REVOCATION_ACTOR_REQUIRED');
  if (!isIsoDate(revocation?.revokedAt)) throw new Error('APPROVAL_REVOCATION_TIME_INVALID');
  REVOKED_TICKET_DIGESTS.add(ticket.ticketDigest);
  return {
    kind: 'CANDIDATE_REVIEW_REVOCATION',
    ticketId: ticket.ticketId,
    ticketDigest: ticket.ticketDigest,
    revokedBy,
    revokedAt: revocation.revokedAt,
    reason: requireText(revocation?.reason) || null,
  };
}

/**
 * 判决（approval / rejection）。只产出判决记录，不执行任何变更。
 * fail-closed：ticket 缺失/畸形、approver 不匹配、outcome 非法、过期、已撤销、重复判决（replay）、
 * 判决时间早于请求时间 → 一律 REJECT。
 */
export function decideCandidateReview(
  ticket: CandidateReviewTicket | null | undefined,
  decision: {
    approverId: string;
    role: ApproverRole;
    outcome: VerdictOutcome;
    decidedAt: string;
    reason?: string | null;
  },
): ApprovalVerdict {
  if (ticket === null || ticket === undefined || typeof ticket !== 'object') {
    throw new Error('APPROVAL_TICKET_REQUIRED');
  }
  if (
    requireText(ticket.ticketDigest) === '' ||
    requireText(ticket.ticketId) === '' ||
    requireText(ticket.candidateDigest) === '' ||
    !isIsoDate(ticket.requestedAt) ||
    !isIsoDate(ticket.expiresAt)
  ) {
    throw new Error('APPROVAL_TICKET_MALFORMED');
  }
  if (!isVerifiedCandidateReviewTicket(ticket)) throw new Error('APPROVAL_TICKET_NOT_VERIFIED');
  if (isRevokedTicket(ticket)) throw new Error('APPROVAL_VERDICT_TICKET_REVOKED');
  if (isDecidedTicket(ticket)) throw new Error('APPROVAL_VERDICT_REPLAY_BLOCKED');
  if (!VERDICT_OUTCOMES.includes(decision?.outcome)) throw new Error('APPROVAL_VERDICT_OUTCOME_INVALID');
  const approverId = requireText(decision?.approverId);
  if (approverId === '' || approverId !== ticket.approverId || decision?.role !== ticket.role) {
    throw new Error('APPROVAL_VERDICT_APPROVER_MISMATCH');
  }
  if (!isIsoDate(decision?.decidedAt)) throw new Error('APPROVAL_VERDICT_TIME_INVALID');
  const decidedAtMs = Date.parse(decision.decidedAt);
  if (decidedAtMs < Date.parse(ticket.requestedAt)) throw new Error('APPROVAL_VERDICT_DECIDED_BEFORE_REQUEST');
  if (decidedAtMs > Date.parse(ticket.expiresAt)) throw new Error('APPROVAL_VERDICT_TICKET_EXPIRED');

  const reason = requireText(decision?.reason) || null;
  const verdictDigest = digest('approval-verdict', [
    CANDIDATE_APPROVAL_VERSION,
    ticket.ticketDigest,
    decision.outcome,
    ticket.candidateDigest,
    ticket.evaluationDigest,
    ticket.evidenceSetDigest,
    ticket.nonce,
    approverId,
    ticket.role,
    decision.decidedAt,
    reason ?? '',
  ]);

  DECIDED_TICKET_DIGESTS.add(ticket.ticketDigest);
  return {
    kind: 'APPROVAL_VERDICT',
    verdictId: 'approval-verdict:' + verdictDigest,
    verdictDigest,
    ticketId: ticket.ticketId,
    ticketDigest: ticket.ticketDigest,
    outcome: decision.outcome,
    candidateDigest: ticket.candidateDigest,
    evaluationDigest: ticket.evaluationDigest,
    evidenceSetDigest: ticket.evidenceSetDigest,
    nonce: ticket.nonce,
    approverId,
    role: ticket.role,
    decidedAt: decision.decidedAt,
    reason,
    execution: { ...FORBIDDEN_EXECUTION, mutation: { ...FORBIDDEN_EXECUTION.mutation } },
  };
}
