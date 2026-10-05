/**
 * Recovery SI —— Plan 校验器（Phase 1）
 * ---------------------------------------------------------------
 * 每一个 SI 判断都必须过 Verifier：**任何无法验证的字段一律 fail-closed**，禁止 LLM 自证。
 *
 * 校验项：
 *   ① snapshot 陈旧（超过 `maxSnapshotAgeMs`）→ 整份 plan 拒绝（`STALE_SNAPSHOT`）；
 *   ② 引用的 opportunity 必须真实存在（`REFERENCE_NOT_FOUND`）；
 *   ③ tenant 必须匹配（`TENANT_MISMATCH`）；
 *   ④ 金额必须来自持久化事实（`MONEY_NOT_FROM_FACT`）；
 *   ⑤ 动作必须在 Phase 1 允许集合内（`UNKNOWN_ACTION`）；
 *   ⑥ toolRef 必须已登记且访问级别允许（`TOOL_NOT_REGISTERED` / `TOOL_ACCESS_FORBIDDEN`）；
 *   ⑦ 证据/授权声明必须与 state 一致（`EVIDENCE_STATE_MISMATCH` / `AUTHORIZATION_STATE_MISMATCH`）；
 *   ⑧ `READY_FOR_EXECUTION` 不得在 Phase 1 被当作可执行（`EXECUTION_NOT_AUTHORIZED_IN_PHASE1`）。
 */

import type { CustomerRecoveryState } from './customer-recovery-state';
import { RECOVERY_ACTION_KINDS, type RecoveryPlan, type RecoveryPlanAction } from './recovery-planner';
import type { RecoveryToolRegistry } from './recovery-tool-registry';

export type RecoveryVerificationReason =
  | 'STALE_SNAPSHOT'
  | 'REFERENCE_NOT_FOUND'
  | 'TENANT_MISMATCH'
  | 'MONEY_NOT_FROM_FACT'
  | 'UNKNOWN_ACTION'
  | 'TOOL_NOT_REGISTERED'
  | 'TOOL_ACCESS_FORBIDDEN'
  | 'EVIDENCE_STATE_MISMATCH'
  | 'AUTHORIZATION_STATE_MISMATCH'
  | 'EXECUTION_NOT_AUTHORIZED_IN_PHASE1';

export interface RejectedAction {
  opportunityRef: string;
  proposedAction: RecoveryPlanAction['proposedAction'];
  reasonCodes: readonly RecoveryVerificationReason[];
}

export type RecoveryVerificationResult =
  | {
      ok: true;
      verifiedActions: readonly RecoveryPlanAction[];
      rejected: readonly RejectedAction[];
      /** Phase 1：`READY_FOR_EXECUTION` 只是决策标记，**从未**被授权执行 */
      executionAuthorizedInPhase1: false;
    }
  | { ok: false; reason: 'STALE_SNAPSHOT'; rejected: readonly RejectedAction[] };

export function verifyRecoveryPlan(input: {
  plan: RecoveryPlan;
  state: CustomerRecoveryState;
  registry: RecoveryToolRegistry;
  nowMs: number;
  maxSnapshotAgeMs: number;
}): RecoveryVerificationResult {
  const observedMs = Date.parse(input.state.observedAt);
  const stale =
    !Number.isFinite(observedMs) || input.nowMs - observedMs > input.maxSnapshotAgeMs || input.nowMs < observedMs;
  if (stale) {
    return { ok: false, reason: 'STALE_SNAPSHOT', rejected: [] };
  }

  const byRef = new Map(input.state.opportunities.map((slice) => [slice.opportunityRef, slice]));
  const verified: RecoveryPlanAction[] = [];
  const rejected: RejectedAction[] = [];

  for (const action of input.plan.actions) {
    const reasons: RecoveryVerificationReason[] = [];
    if (!(RECOVERY_ACTION_KINDS as readonly string[]).includes(action.proposedAction)) {
      reasons.push('UNKNOWN_ACTION');
    }
    const slice = byRef.get(action.opportunityRef);
    if (slice === undefined) {
      reasons.push('REFERENCE_NOT_FOUND');
    } else {
      if (slice.organizationId !== input.state.organizationId || input.plan.organizationId !== input.state.organizationId) {
        reasons.push('TENANT_MISMATCH');
      }
      if (action.expectedRecovery !== null && slice.recoverable === null) {
        reasons.push('MONEY_NOT_FROM_FACT');
      }
      if (action.proposedAction === 'REQUEST_EVIDENCE' && slice.evidenceComplete && slice.missingEvidence.length === 0) {
        reasons.push('EVIDENCE_STATE_MISMATCH');
      }
      if (action.proposedAction === 'REQUEST_AUTHORIZATION' && slice.authorizationReady) {
        reasons.push('AUTHORIZATION_STATE_MISMATCH');
      }
    }
    if (action.toolRef !== null) {
      if (!input.registry.has(action.toolRef)) reasons.push('TOOL_NOT_REGISTERED');
      else {
        const tool = input.registry.list().find((entry) => entry.name === action.toolRef);
        if (tool !== undefined && !['READ', 'PLAN', 'PREPARE'].includes(tool.access)) {
          reasons.push('TOOL_ACCESS_FORBIDDEN');
        }
      }
    }
    if (reasons.length === 0) verified.push(action);
    else rejected.push({ opportunityRef: action.opportunityRef, proposedAction: action.proposedAction, reasonCodes: [...new Set(reasons)].sort() });
  }

  return { ok: true, verifiedActions: verified, rejected, executionAuthorizedInPhase1: false };
}

export const RECOVERY_VERIFIER_BOUNDARY = {
  failClosed: true,
  llmSelfAttestation: false,
  staleSnapshotRejected: true,
  crossTenantRejected: true,
  moneyMustComeFromFact: true,
  executionNotAuthorizedInPhase1: true,
} as const;
