/**
 * Recovery SI —— 动作策略（Phase 1，薄适配层）
 * ---------------------------------------------------------------
 * 设计原则：**策略入口单一**。SI 的任何动作都先映射到既有 `rsi-policy-engine` 的动作名再判定，
 * 因此 L0–L5 与「L5 永久禁区」只有一份定义；本模块**只加不松**，绝不复制或放宽那张表。
 *
 * 特别：`READY_FOR_EXECUTION` 在 Phase 1 只是**决策标记**，不是执行授权；
 * 真正的执行仍必须走 Action Guard → Authorization / HITL / OWNER Gate → Deterministic Executor。
 */

import { decideRsiPolicyAction, type RsiPolicyDecision } from '../autonomy/rsi-policy-engine';
import type { RsiFlags } from '../autonomy/rsi-runtime-config';
import type { RecoveryActionKind } from './recovery-planner';

/** SI 动作 → 既有 policy engine 动作名（不新增权限语义） */
export const RECOVERY_ACTION_TO_POLICY_ACTION: Record<RecoveryActionKind, string> = {
  EXECUTE_READ_ONLY_CHECK: 'OBSERVE_STATE',
  PREPARE_PACKAGE: 'PROPOSE_PATCH',
  REQUEST_EVIDENCE: 'OBSERVE_STATE',
  REQUEST_AUTHORIZATION: 'OBSERVE_STATE',
  REQUEST_OWNER_APPROVAL: 'OBSERVE_STATE',
  WAIT_PROVIDER: 'OBSERVE_STATE',
  FILE_MODE_FALLBACK: 'OBSERVE_STATE',
  HOLD: 'OBSERVE_STATE',
  READY_FOR_EXECUTION: 'JUDGE_CANDIDATE',
};

/** 任何被请求执行这些动作的尝试都必须落到 L5（永久禁止） */
export const RECOVERY_FORBIDDEN_EXECUTION_ACTIONS = [
  'EXTERNAL_WRITE',
  'PAYMENT',
  'TRANSPORT',
  'PRODUCTION_CREDENTIALS',
  'PRODUCTION_ENABLEMENT',
  'REAL_CLAIM_SUBMIT',
  'REAL_APPEAL_SUBMIT',
  'CUSTOMS_FILING',
  'BROKER_PRIVILEGED_EXECUTION',
  'COMMISSION_CAPTURE',
  'SECURITY_POLICY_DOWNGRADE',
  'PERMISSION_EXPANSION',
  'DESTRUCTIVE_MIGRATION',
  'CUSTOMER_DATA_DELETION',
  'KILL_SWITCH_DISABLE',
] as const;

export interface RecoveryPolicyDecision {
  kind: RecoveryActionKind;
  allowedForRecoverySi: boolean;
  requiresOwnerApproval: boolean;
  permanentlyForbidden: boolean;
  reasonCodes: readonly string[];
  delegated: RsiPolicyDecision;
}

export function decideRecoveryAction(
  kind: RecoveryActionKind,
  options: { flags?: RsiFlags; riskClass?: 'LOW' | 'MEDIUM' | 'HIGH' } = {},
): RecoveryPolicyDecision {
  const policyAction = RECOVERY_ACTION_TO_POLICY_ACTION[kind];
  const delegated = decideRsiPolicyAction(
    { action: policyAction, ...(options.riskClass === undefined ? {} : { riskClass: options.riskClass }) },
    options.flags === undefined ? {} : { flags: options.flags },
  );
  // CHANGE C（MSG-20261005-11）：READY_FOR_EXECUTION 只是**决策标记**，
  // 绝不表达为执行许可 —— 即使底层 policy（JUDGE_CANDIDATE，AUTO_JUDGE 默认 true）放行。
  if (kind === 'READY_FOR_EXECUTION') {
    return {
      kind,
      allowedForRecoverySi: false,
      requiresOwnerApproval: true,
      permanentlyForbidden: false,
      reasonCodes: [...new Set([...delegated.reasonCodes, 'EXECUTION_NOT_AUTHORIZED_IN_PHASE1'])].sort(),
      delegated,
    };
  }
  return {
    kind,
    allowedForRecoverySi: delegated.allowedForRsi,
    requiresOwnerApproval: delegated.requiresOwnerApproval,
    permanentlyForbidden: delegated.permanentlyForbidden,
    reasonCodes: delegated.reasonCodes,
    delegated,
  };
}

/** 请求执行类动作时的统一入口：**永远**走 L5 判定，必然被拒 */
export function decideRecoveryExecutionRequest(
  action: string,
  options: { flags?: RsiFlags } = {},
): RsiPolicyDecision {
  return decideRsiPolicyAction({ action }, options.flags === undefined ? {} : { flags: options.flags });
}

export const RECOVERY_POLICY_BOUNDARY = {
  singlePolicySource: 'services/autonomy/rsi-policy-engine.ts',
  duplicatesPolicyTable: false,
  relaxesL5: false,
  /** READY_FOR_EXECUTION 不产生 allowedForRecoverySi=true（CHANGE C） */
  readyForExecutionNeverAllowedForSi: true,
  readyForExecutionIsExecution: false,
  ownerGatedActionsRemainOwnerGated: true,
} as const;
