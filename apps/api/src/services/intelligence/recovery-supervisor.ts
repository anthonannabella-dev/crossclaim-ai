/**
 * Recovery SI —— Supervisor（Phase 1 编排出口）
 * ---------------------------------------------------------------
 * OBSERVE → DISCOVER → ESTIMATE（复用既有 estimate 视图）→ PRIORITIZE → PLAN → VERIFY → POLICY → SUPERVISE
 *
 * Phase 1 只产出 **decision**：`READY_FOR_EXECUTION` 是标记，不是执行；
 * 真正执行必须经过 Action Guard → Authorization / HITL / OWNER Gate → Deterministic Executor。
 *
 * 确定性：同一 snapshot + 同一 registry + 同一 `nowMs` → 完全相同的 plan 与 decision（测试中强制）。
 * 零外写：本模块不调用任何工具的执行路径、不落库、不发网络、不读凭据。
 */

import type { CustomerRecoveryState } from './customer-recovery-state';
import { prioritizeOpportunities, type PriorityResult } from './recovery-prioritizer';
import { planRecovery, type RecoveryPlan, type RecoveryPlanAction } from './recovery-planner';
import { verifyRecoveryPlan, type RejectedAction } from './recovery-verifier';
import { decideRecoveryAction, type RecoveryPolicyDecision } from './recovery-policy';
import type { RecoveryToolRegistry } from './recovery-tool-registry';
import type { RsiFlags } from '../autonomy/rsi-runtime-config';

export interface RecoveryDecision {
  opportunityRef: string;
  proposedAction: RecoveryPlanAction['proposedAction'];
  allowedForRecoverySi: boolean;
  /** CHANGE C：Phase 1 恒为 false —— READY_FOR_EXECUTION 不是执行许可 */
  executionAuthorized: boolean;
  requiresOwnerApproval: boolean;
  reasonCodes: readonly string[];
}

export interface RecoverySupervisionResult {
  organizationId: string;
  generatedAt: string;
  snapshotObservedAt: string;
  plan: RecoveryPlan | null;
  priority: PriorityResult;
  decisions: readonly RecoveryDecision[];
  rejected: readonly RejectedAction[];
  halted: 'STALE_SNAPSHOT' | 'TENANT_MISMATCH' | null;
  boundaries: {
    externalWritePerformed: false;
    paymentPerformed: false;
    productionCredentialsRead: false;
    realClaimSubmitted: false;
    customsFiled: false;
    canonicalFactMutated: false;
    executionAuthorizedInPhase1: false;
  };
}

export function superviseRecovery(input: {
  state: CustomerRecoveryState;
  registry: RecoveryToolRegistry;
  nowMs: number;
  maxSnapshotAgeMs?: number;
  flags?: RsiFlags;
}): RecoverySupervisionResult {
  const boundaries = {
    externalWritePerformed: false as const,
    paymentPerformed: false as const,
    productionCredentialsRead: false as const,
    realClaimSubmitted: false as const,
    customsFiled: false as const,
    canonicalFactMutated: false as const,
    executionAuthorizedInPhase1: false as const,
  };
  const priority = prioritizeOpportunities(input.state);
  const plan = planRecovery({
    state: input.state,
    ranked: priority.ranked,
    registry: input.registry,
    generatedAt: new Date(input.nowMs).toISOString(),
  });
  const verification = verifyRecoveryPlan({
    plan,
    state: input.state,
    registry: input.registry,
    priority,
    nowMs: input.nowMs,
    maxSnapshotAgeMs: input.maxSnapshotAgeMs ?? 15 * 60 * 1000,
  });
  if (!verification.ok) {
    const halted = verification.reason === 'TENANT_MISMATCH' ? ('TENANT_MISMATCH' as const) : ('STALE_SNAPSHOT' as const);
    return {
      organizationId: input.state.organizationId,
      generatedAt: plan.generatedAt,
      snapshotObservedAt: input.state.observedAt,
      plan,
      priority,
      decisions: [],
      rejected: verification.rejected,
      halted,
      boundaries,
    };
  }

  const decisions: RecoveryDecision[] = verification.verifiedActions.map((action) => {
    const policy: RecoveryPolicyDecision = decideRecoveryAction(
      action.proposedAction,
      input.flags === undefined ? {} : { flags: input.flags },
    );
    return {
      opportunityRef: action.opportunityRef,
      proposedAction: action.proposedAction,
      allowedForRecoverySi: policy.allowedForRecoverySi,
      executionAuthorized: false as const,
      requiresOwnerApproval: policy.requiresOwnerApproval || action.ownerApprovalRequired,
      reasonCodes: [...new Set([...action.reasonCodes, ...policy.reasonCodes])].sort(),
    };
  });

  return {
    organizationId: input.state.organizationId,
    generatedAt: plan.generatedAt,
    snapshotObservedAt: input.state.observedAt,
    plan,
    priority,
    decisions,
    rejected: verification.rejected,
    halted: null,
    boundaries,
  };
}

export const RECOVERY_SUPERVISOR_BOUNDARY = {
  reusesRsiInfrastructure: true,
  createsSecondRuntime: false,
  executesTools: false,
  appliesChanges: false,
  externalWritePerformed: false,
  paymentPerformed: false,
  productionCredentialsRead: false,
  realClaimSubmitted: false,
  customsFiled: false,
  canonicalFactMutated: false,
  decisionOnly: true,
} as const;
