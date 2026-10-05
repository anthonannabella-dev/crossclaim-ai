/**
 * PHASE 5 U3 —— Controlled Config Proposal（PROPOSAL_ONLY）
 * ---------------------------------------------------------------
 * 链路（审计冻结）：Verified APPROVED Verdict + Verified Rollback Plan → Controlled Config Proposal。
 * 硬约束：APPROVED only（REJECTED 永不生成）；one verdict → one proposal；delta 必须限于 candidate target；
 * baseline fingerprint 明确；必须先有 verified rollback plan；proposal 仍 PROPOSAL_ONLY；
 * **不修改 Policy / Guard / Router / Action Runtime，不 apply / promotion / rollout**；本模块不导出任何执行入口。
 */

import { createHash } from 'node:crypto';

import { isVerifiedApprovalVerdict, type ApprovalVerdict } from './candidate-approval';
import { isVerifiedRollbackPlan, type RollbackPlan } from './rollback-plan';

export const CONTROLLED_PROPOSAL_VERSION = 'controlled-config-proposal/v1';

export const CONTROLLED_PROPOSAL_BOUNDARY = {
  mode: 'PROPOSAL_ONLY',
  chain: 'verified APPROVED verdict + verified rollback plan → controlled config proposal',
  verdictGate: 'isVerifiedApprovalVerdict(verdict) === true && outcome === APPROVED',
  rollbackPlanGate: 'isVerifiedRollbackPlan(plan) === true && plan.verdictDigest === v.verdictDigest',
  rejectedVerdict: 'NEVER_PROPOSES（fail-closed）',
  oneProposalPer: 'VERDICT_DIGEST（Set<string>，contract/sandbox 层）',
  deltaTarget: 'MUST_EQUAL_CANDIDATE_TARGET（取自 verified rollback plan）',
  deltaPath: 'TARGET_SPECIFIC_ALLOWLIST（TARGET_DELTA_PATHS；越界 fail-closed）',
  deltaFrom: 'MUST_EQUAL_BASELINE_SNAPSHOT_VALUE（delta.from 必须等于 trusted snapshot 中该字段当前值）',
  apply: 'FORBIDDEN',
  autoPromotion: 'OFF',
  autoRollout: 'FORBIDDEN',
  policyMutation: 'FORBIDDEN',
  guardMutation: 'FORBIDDEN',
  routerMutation: 'FORBIDDEN',
  actionRuntimeMutation: 'FORBIDDEN',
  binds: [
    'verdictDigest',
    'ticketDigest',
    'candidateDigest',
    'evaluationDigest',
    'evidenceSetDigest',
    'baselineConfigFingerprint',
    'baselineSnapshotDigest',
    'rollbackPlanDigest',
    'proposedDelta',
    'proposalDigest',
  ],
  proposalProvenance: 'PROVENANCE_REGISTERED + fingerprint + deep-freeze',
  productionWrite: 'HOLD',
} as const;

/** 每 target 的受控字段 allowlist（server-owned；不在表内即拒绝）。 */
export const TARGET_DELTA_PATHS = {
  POLICY: ['policy.retryBudget', 'policy.resolutionWindowHours'],
  GUARD: ['guard.evidenceStrengthRequirement'],
  ROUTER: ['router.escalationThreshold', 'router.modelTierPolicy'],
  ACTION_RUNTIME: ['actionRuntime.maxAttempts'],
} as const;
export type DeltaTargetName = keyof typeof TARGET_DELTA_PATHS;

export interface ProposedDelta {
  target: string;
  path: string;
  from: string;
  to: string;
  rationale: string;
}

export interface ControlledConfigProposal {
  kind: 'CONTROLLED_CONFIG_PROPOSAL';
  mode: 'PROPOSAL_ONLY';
  proposalId: string;
  proposalDigest: string;
  verdictDigest: string;
  ticketDigest: string;
  candidateDigest: string;
  evaluationDigest: string;
  evidenceSetDigest: string;
  candidateTarget: string;
  baselineConfigFingerprint: string;
  baselineSnapshotDigest: string;
  rollbackPlanRef: string;
  rollbackPlanDigest: string;
  proposedDelta: ProposedDelta;
  execution: {
    apply: 'FORBIDDEN';
    autoPromotion: 'OFF';
    autoRollout: 'FORBIDDEN';
    requiresHumanApproval: true;
  };
}

const VERIFIED_CONTROLLED_PROPOSALS = new WeakSet<ControlledConfigProposal>();
const VERIFIED_CONTROLLED_PROPOSAL_FINGERPRINTS = new WeakMap<ControlledConfigProposal, string>();
const PROPOSED_VERDICT_DIGESTS = new Set<string>();

const requireText = (value: unknown): string => (typeof value === 'string' && value.trim() !== '' ? value.trim() : '');

const digest = (label: string, parts: readonly string[]): string =>
  label + ':' + createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);

const proposalFingerprint = (proposal: ControlledConfigProposal): string =>
  JSON.stringify({
    kind: proposal.kind,
    mode: proposal.mode,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    verdictDigest: proposal.verdictDigest,
    ticketDigest: proposal.ticketDigest,
    candidateDigest: proposal.candidateDigest,
    evaluationDigest: proposal.evaluationDigest,
    evidenceSetDigest: proposal.evidenceSetDigest,
    candidateTarget: proposal.candidateTarget,
    baselineConfigFingerprint: proposal.baselineConfigFingerprint,
    baselineSnapshotDigest: proposal.baselineSnapshotDigest,
    rollbackPlanRef: proposal.rollbackPlanRef,
    rollbackPlanDigest: proposal.rollbackPlanDigest,
    proposedDelta: { ...proposal.proposedDelta },
    execution: { ...proposal.execution },
  });

/** 只读 provenance：只有 createControlledConfigProposal() 产出的 proposal 才为 true。 */
export function isVerifiedControlledConfigProposal(
  proposal: ControlledConfigProposal | null | undefined,
): boolean {
  if (proposal === null || proposal === undefined) return false;
  if (!VERIFIED_CONTROLLED_PROPOSALS.has(proposal)) return false;
  const fingerprint = VERIFIED_CONTROLLED_PROPOSAL_FINGERPRINTS.get(proposal);
  if (fingerprint === undefined) return false;
  try {
    return fingerprint === proposalFingerprint(proposal);
  } catch {
    return false;
  }
}

/**
 * 由 verified APPROVED verdict + verified rollback plan 生成受控配置提案（只提案，不执行）。
 * fail-closed：verdict/plan 未 provenance / 非 APPROVED / 二者不互绑 / 重复提案 / delta 越界或畸形 → REJECT。
 */
export function createControlledConfigProposal(
  verdict: ApprovalVerdict | null | undefined,
  rollbackPlan: RollbackPlan | null | undefined,
  input: { proposedDelta: ProposedDelta | null | undefined } | null | undefined,
): ControlledConfigProposal {
  if (!isVerifiedApprovalVerdict(verdict)) {
    throw new Error('CONTROLLED_PROPOSAL_VERDICT_NOT_VERIFIED');
  }
  const v: ApprovalVerdict = verdict as ApprovalVerdict;
  if (v.outcome !== 'APPROVED') {
    throw new Error('CONTROLLED_PROPOSAL_VERDICT_NOT_APPROVED:' + String(v.outcome));
  }
  if (!isVerifiedRollbackPlan(rollbackPlan)) {
    throw new Error('CONTROLLED_PROPOSAL_ROLLBACK_PLAN_NOT_VERIFIED');
  }
  const plan: RollbackPlan = rollbackPlan as RollbackPlan;
  if (plan.verdictDigest !== v.verdictDigest) {
    throw new Error('CONTROLLED_PROPOSAL_ROLLBACK_PLAN_VERDICT_MISMATCH');
  }
  if (PROPOSED_VERDICT_DIGESTS.has(v.verdictDigest)) {
    throw new Error('CONTROLLED_PROPOSAL_ALREADY_EXISTS:' + v.verdictDigest);
  }
  const delta = input?.proposedDelta;
  if (delta === null || delta === undefined || typeof delta !== 'object') {
    throw new Error('CONTROLLED_PROPOSAL_DELTA_REQUIRED');
  }
  const target = requireText(delta.target);
  const path = requireText(delta.path);
  const from = requireText(delta.from);
  const to = requireText(delta.to);
  const rationale = requireText(delta.rationale);
  if (target === '' || path === '' || from === '' || to === '' || rationale === '') {
    throw new Error('CONTROLLED_PROPOSAL_DELTA_MALFORMED');
  }
  if (target !== plan.candidateTarget) {
    throw new Error('CONTROLLED_PROPOSAL_DELTA_TARGET_NOT_ALLOWED:' + target);
  }
  const allowedPaths = (TARGET_DELTA_PATHS as Record<string, readonly string[]>)[target];
  if (allowedPaths === undefined || !allowedPaths.includes(path)) {
    throw new Error('CONTROLLED_PROPOSAL_DELTA_PATH_NOT_ALLOWED:' + target + ':' + path);
  }
  const baselineValue = plan.baselineConfigValues[path];
  if (baselineValue === undefined || baselineValue !== from) {
    throw new Error('CONTROLLED_PROPOSAL_DELTA_FROM_NOT_IN_BASELINE:' + target + ':' + path);
  }

  const proposalDigest = digest('controlled-proposal', [
    CONTROLLED_PROPOSAL_VERSION,
    v.verdictDigest,
    v.ticketDigest,
    v.candidateDigest,
    v.evaluationDigest,
    v.evidenceSetDigest,
    plan.baselineConfigFingerprint,
    plan.baselineSnapshotDigest,
    plan.rollbackPlanDigest,
    [target, path, from, to, rationale].join('~'),
  ]);

  const proposal: ControlledConfigProposal = {
    kind: 'CONTROLLED_CONFIG_PROPOSAL',
    mode: 'PROPOSAL_ONLY',
    proposalId: 'controlled-proposal:' + proposalDigest,
    proposalDigest,
    verdictDigest: v.verdictDigest,
    ticketDigest: v.ticketDigest,
    candidateDigest: v.candidateDigest,
    evaluationDigest: v.evaluationDigest,
    evidenceSetDigest: v.evidenceSetDigest,
    candidateTarget: plan.candidateTarget,
    baselineConfigFingerprint: plan.baselineConfigFingerprint,
    baselineSnapshotDigest: plan.baselineSnapshotDigest,
    rollbackPlanRef: plan.planId,
    rollbackPlanDigest: plan.rollbackPlanDigest,
    proposedDelta: { target, path, from, to, rationale },
    execution: { apply: 'FORBIDDEN', autoPromotion: 'OFF', autoRollout: 'FORBIDDEN', requiresHumanApproval: true },
  };
  Object.freeze(proposal.proposedDelta);
  Object.freeze(proposal.execution);
  Object.freeze(proposal);
  VERIFIED_CONTROLLED_PROPOSALS.add(proposal);
  VERIFIED_CONTROLLED_PROPOSAL_FINGERPRINTS.set(proposal, proposalFingerprint(proposal));
  PROPOSED_VERDICT_DIGESTS.add(v.verdictDigest);
  return proposal;
}
