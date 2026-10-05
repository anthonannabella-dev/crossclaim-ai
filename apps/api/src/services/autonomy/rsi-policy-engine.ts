/**
 * RSI-P1-06 —— Policy Engine（L0–L5 分级 + 永久 OWNER 硬禁清单，纯函数）
 * ---------------------------------------------------------------
 * 依据 OWNER 任务《RSI Runtime》第六/七节与 MSG-20261005-02：
 *   · 每个动作都有自己的**执行层级**与**所需 stage**（OBSERVE / AUTO_INCIDENT / AUTO_PATCH /
 *     AUTO_VALIDATE / AUTO_JUDGE / AUTO_PROMOTE_LOW_RISK）；
 *   · **L5 = 永久禁止 RSI 自治执行**：无论 flags 怎么开、是否带 ownerApprovalRef，RSI 都不得执行；
 *     这类动作只能由 OWNER 走既有人工通道完成；
 *   · Kill Switch / 总开关关闭 → 不推进新工作（新建 incident/candidate/patch/promotion 全部拒绝），
 *     仅保留**只读**动作；
 *   · 未知动作 **fail-closed**（默认按最严处理），不允许“没登记就放行”；
 *   · 本模块**不授予任何新权限**：所有规则要么是既有 OWNER 规格常量，要么更严格；
 *     它只回决策，不执行任何动作、不落库、不发网络、不读凭据。
 */

import { canAutoPromote, requiresOwnerApproval } from './rsi-lifecycle';
import { canRunStage, RSI_DEFAULT_FLAGS, type RsiFlags, type RsiStage } from './rsi-runtime-config';

export const RSI_POLICY_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as const;
export type RsiPolicyLevel = (typeof RSI_POLICY_LEVELS)[number];

export interface RsiActionPolicy {
  level: RsiPolicyLevel;
  stage: RsiStage | null;
  /** 只读动作在 Kill Switch 触发时仍然允许（不产生新工作） */
  readOnly: boolean;
}

/**
 * 动作 → 层级/stage 的唯一映射表。
 * L0 确定性规则 · L1 低成本模型 · L2 强模型 · L3 沙箱内代码变更提案 · L4 判定/低风险提升 · L5 特权（永久禁止）
 */
export const RSI_ACTION_POLICY: Record<string, RsiActionPolicy> = {
  OBSERVE_STATE: { level: 'L0', stage: 'OBSERVE', readOnly: true },
  HEALTH_CHECK: { level: 'L0', stage: 'OBSERVE', readOnly: true },
  RUN_RULE_ENGINE: { level: 'L0', stage: 'OBSERVE', readOnly: true },
  GENERATE_INCIDENT: { level: 'L1', stage: 'AUTO_INCIDENT', readOnly: false },
  CLASSIFY_SIGNAL: { level: 'L1', stage: 'AUTO_INCIDENT', readOnly: false },
  DIAGNOSE_ROOT_CAUSE: { level: 'L2', stage: 'AUTO_PATCH', readOnly: false },
  GENERATE_DOC: { level: 'L2', stage: 'AUTO_PATCH', readOnly: false },
  PROPOSE_PATCH: { level: 'L3', stage: 'AUTO_PATCH', readOnly: false },
  VALIDATE_PATCH: { level: 'L3', stage: 'AUTO_VALIDATE', readOnly: false },
  JUDGE_CANDIDATE: { level: 'L4', stage: 'AUTO_JUDGE', readOnly: false },
  PROMOTE_LOW_RISK: { level: 'L4', stage: 'AUTO_PROMOTE_LOW_RISK', readOnly: false },
  // L5：永久禁止 RSI 自治执行（含 kill switch 自关、越权、改策略、动生产凭据/外写/资金/报关等）
  DISABLE_KILL_SWITCH: { level: 'L5', stage: null, readOnly: false },
  RAISE_OWN_PRIVILEGE: { level: 'L5', stage: null, readOnly: false },
  EDIT_POLICY_ENGINE: { level: 'L5', stage: null, readOnly: false },
  EXTERNAL_WRITE: { level: 'L5', stage: null, readOnly: false },
  PAYMENT: { level: 'L5', stage: null, readOnly: false },
  TRANSPORT: { level: 'L5', stage: null, readOnly: false },
  PRODUCTION_CREDENTIALS: { level: 'L5', stage: null, readOnly: false },
  PRODUCTION_ENABLEMENT: { level: 'L5', stage: null, readOnly: false },
  REAL_CLAIM_SUBMIT: { level: 'L5', stage: null, readOnly: false },
  CUSTOMS_FILING: { level: 'L5', stage: null, readOnly: false },
};

/** 永久禁止 RSI 自治执行的动作（硬编码，不接受任何 flag 放宽） */
export const RSI_PERMANENTLY_FORBIDDEN_ACTIONS: readonly string[] = [
  ...Object.entries(RSI_ACTION_POLICY)
    .filter(([, policy]) => policy.level === 'L5')
    .map(([action]) => action),
  ...Object.keys(RSI_ACTION_POLICY).filter((action) => requiresOwnerApproval(action)),
]
  .filter((action, index, all) => all.indexOf(action) === index)
  .sort();

export interface RsiPolicyRequest {
  action: string;
  /** L4 判定用（低风险才允许自动提升） */
  riskClass?: 'LOW' | 'MEDIUM' | 'HIGH';
  /** 仅供记录：即便带了 OWNER 批准，L5 也不允许 RSI 执行 */
  ownerApprovalRef?: string | null;
}

export interface RsiPolicyDecision {
  action: string;
  level: RsiPolicyLevel;
  stage: RsiStage | null;
  allowedForRsi: boolean;
  requiresOwnerApproval: boolean;
  permanentlyForbidden: boolean;
  reasonCodes: readonly string[];
}

const deny = (
  action: string,
  level: RsiPolicyLevel,
  stage: RsiStage | null,
  reasonCodes: readonly string[],
  overrides: Partial<Pick<RsiPolicyDecision, 'requiresOwnerApproval' | 'permanentlyForbidden'>> = {},
): RsiPolicyDecision => ({
  action,
  level,
  stage,
  allowedForRsi: false,
  requiresOwnerApproval: overrides.requiresOwnerApproval ?? false,
  permanentlyForbidden: overrides.permanentlyForbidden ?? false,
  reasonCodes: [...new Set(reasonCodes)].sort(),
});

/** 决策（纯函数）：同样输入永远得到同样输出 */
export function decideRsiPolicyAction(
  request: RsiPolicyRequest,
  options: { flags?: RsiFlags; autoPromoteEnabled?: boolean } = {},
): RsiPolicyDecision {
  const flags = options.flags ?? RSI_DEFAULT_FLAGS;
  const policy = RSI_ACTION_POLICY[request.action];

  // 未登记的动作：fail-closed，按最严处理
  if (policy === undefined) {
    return deny(request.action, 'L5', null, ['UNKNOWN_ACTION_FAIL_CLOSED', 'PERMANENTLY_FORBIDDEN_FOR_RSI'], {
      requiresOwnerApproval: true,
      permanentlyForbidden: true,
    });
  }

  // L5 / 既有 OWNER 清单：RSI 永远不能自治执行（带 ownerApprovalRef 也不放宽）
  if (policy.level === 'L5' || requiresOwnerApproval(request.action)) {
    return deny(request.action, 'L5', null, ['PERMANENTLY_FORBIDDEN_FOR_RSI', 'OWNER_APPROVAL_REQUIRED'], {
      requiresOwnerApproval: true,
      permanentlyForbidden: true,
    });
  }

  // L4：判定/提升受显式开关与风险等级双重约束
  if (policy.level === 'L4') {
    const reasons: string[] = [];
    if (!canRunStage(flags, policy.stage ?? 'AUTO_JUDGE')) reasons.push('STAGE_DISABLED:' + (policy.stage ?? 'AUTO_JUDGE'));
    if (policy.stage === 'AUTO_PROMOTE_LOW_RISK') {
      if (options.autoPromoteEnabled !== true) reasons.push('AUTO_PROMOTE_DISABLED');
      if (!canAutoPromote(request.riskClass ?? 'HIGH', { autoPromoteEnabled: options.autoPromoteEnabled })) {
        reasons.push('AUTO_PROMOTE_LOW_RISK_ONLY');
      }
    }
    if (reasons.length > 0) {
      return deny(request.action, policy.level, policy.stage, reasons, { requiresOwnerApproval: true });
    }
  } else if (!canRunStage(flags, policy.stage ?? 'OBSERVE')) {
    if (policy.readOnly && flags.paused && flags.enabled) {
      return {
        action: request.action,
        level: policy.level,
        stage: policy.stage,
        allowedForRsi: true,
        requiresOwnerApproval: false,
        permanentlyForbidden: false,
        reasonCodes: ['ALLOWED', 'PAUSED_READ_ONLY_ALLOWED'],
      };
    }
    const reasons: string[] = [];
    if (!flags.enabled) reasons.push('RSI_DISABLED');
    else if (flags.paused) reasons.push('KILL_SWITCH_PAUSED');
    else reasons.push('STAGE_DISABLED:' + (policy.stage ?? 'OBSERVE'));
    return deny(request.action, policy.level, policy.stage, reasons);
  }

  return {
    action: request.action,
    level: policy.level,
    stage: policy.stage,
    allowedForRsi: true,
    requiresOwnerApproval: false,
    permanentlyForbidden: false,
    reasonCodes: ['ALLOWED'],
  };
}

export const RSI_POLICY_ENGINE_BOUNDARY = {
  grantsNewAuthority: false,
  unknownActionFailsClosed: true,
  privilegedActionsPermanentlyForbidden: true,
  ownerApprovalDoesNotUnlockL5: true,
  killSwitchAllowsReadOnly: true,
  executesActions: false,
  writesDatabase: false,
  performsNetworkCalls: false,
  readsCredentials: false,
} as const;
