// STANDING AUTHORIZATION / RISK-TIERED EXECUTION — slice SA-2 — Action Guard 接线（不绕过既有 Guard）
// ---------------------------------------------------------------------------
// 语义（HOST 第 3 条）：保留 per-action **一次性 humanApproval**，并允许
//   `explicit one-time approval`  **OR**  `valid Standing Authorization`（仅在允许它满足的 gate 上）。
// 关键约束：
//   ① 既有 Action Guard 仍是唯一执行权判定（DENY 一律 DENY，本模块不会把它变 ALLOW）；
//   ② Standing Authorization **只**能替代 humanApproval 这一道 gate，且仅在 TIER_1 低风险场景；
//   ③ 以下 gate 一律不可被授权绕过：Production Gate / Platform Enablement / Kill Switch /
//      Provider capability / Credential gate / Customs·Broker·POA gate / Regulatory restriction /
//      tenant·account isolation → 未满足即 DENY；
//   ④ 高金额 HITL 规则保留（> USD 1,000 → OWNER/ADMIN；≥ USD 10,000 → ADMIN），授权不得绕过；
//   ⑤ 本模块不执行任何动作（只判定），externalWritePerformed 恒为 false。

import { digestOf } from '../config-execution-durability/digests';
import type { ActionGuardResult } from '../action-guard/action-guard';
import {
  STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES,
  evaluateStandingAuthorization,
  type StandingAuthorizationEvaluation,
  type StandingAuthorizationRecord,
  type StandingAuthorizationRequest,
} from './standing-authorization';
import type { RiskTierResult } from './risk-tier-policy';

export const ACTION_GUARD_WIRING_VERSION = 'standing-authorization-guard-wiring/v1';

export const AUTONOMOUS_EXECUTION_DECISIONS = ['ALLOW', 'REQUIRE_APPROVAL', 'DENY'] as const;
export type AutonomousExecutionDecision = (typeof AUTONOMOUS_EXECUTION_DECISIONS)[number];

export const AUTHORIZATION_SOURCES = ['STANDING_AUTHORIZATION', 'ONE_TIME_APPROVAL', 'NONE'] as const;
export type AuthorizationSource = (typeof AUTHORIZATION_SOURCES)[number];

export interface NonBypassableGateSnapshot {
  productionGate?: 'SATISFIED' | 'NOT_SATISFIED' | 'UNKNOWN';
  platformEnablement?: boolean;
  /** true = Kill Switch 处于激活（阻断）状态 */
  killSwitchActive?: boolean;
  providerCapabilityReady?: boolean;
  credentialReady?: boolean;
  /** 该动作是否触碰 Customs filing / broker 通道 */
  customsPoaRequired?: boolean;
  /** 既有 15-gate readiness 中的 POA 相关结论（POA 有效且 scope/辖区覆盖） */
  customsPoaSatisfied?: boolean;
  /** 非 null = 存在生效中的法规限制 */
  regulatoryRestriction?: string | null;
  tenantAccountIsolationOk?: boolean;
}

export interface AutonomousExecutionInput {
  guard: Pick<ActionGuardResult, 'decision' | 'code' | 'action' | 'risk' | 'requiredGates'>;
  authorization: StandingAuthorizationRecord | null;
  request: StandingAuthorizationRequest;
  riskTier: RiskTierResult;
  gates: NonBypassableGateSnapshot;
  now: Date;
}

export interface AutonomousExecutionDecisionResult {
  kind: 'AUTONOMOUS_EXECUTION_DECISION';
  version: string;
  action: string;
  decision: AutonomousExecutionDecision;
  authorizedBy: AuthorizationSource;
  satisfiedGates: string[];
  blockingGates: string[];
  standingAuthorizationDecision: StandingAuthorizationEvaluation['decision'] | null;
  standingAuthorizationReasonCodes: string[];
  riskTier: RiskTierResult['tier'];
  riskTierRequiresHitl: boolean;
  highValueHitlKept: true;
  oneTimeApprovalStillSupported: true;
  standingAuthorizationCannotBypass: readonly string[];
  /** 恒为 false：本模块只判定，不执行 */
  externalWritePerformed: false;
  executionPerformed: false;
  reasonCodes: string[];
  evaluatedAt: string;
  wiringDigest: string;
}

export const ACTION_GUARD_WIRING_BOUNDARY = {
  reusesExistingActionGuard: true,
  createsSecondGuard: false,
  keepsOneTimeHumanApproval: true,
  standingAuthorizationSatisfiesOnly: ['humanApproval'],
  nonBypassableGates: STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES,
  highValueHitl: 'KEEP',
  executesActions: false,
  externalWritePerformed: false,
  forbidden: [
    'overriding an Action Guard DENY',
    'satisfying production / platform / kill-switch / credential / regulatory / isolation gates with a standing authorization',
    'bypassing high-value HITL',
    'using a standing authorization as a broker POA',
    'executing any action from this decision layer',
  ],
} as const;

export const CUSTOMS_POA_BOUNDARY = {
  standingAuthorizationIsBrokerPoa: false,
  platformOAuthIsBrokerPoa: false,
  paymentAuthorizationIsBrokerPoa: false,
  requiredBrokerPoaForm: 'CBP_FORM_5291',
  form4811AsBrokerPoa: false,
  poaReuseRequiresVerifiedScopeAndJurisdiction: true,
  invalidatedPoaRequiresCustomerOrBroker: true,
} as const;

export type ActionGuardWiringErrorCode = 'STANDING_AUTH_CANNOT_BYPASS_GATE';

export class ActionGuardWiringError extends Error {
  readonly code: ActionGuardWiringErrorCode;

  constructor(code: ActionGuardWiringErrorCode, message: string) {
    super(message);
    this.name = 'ActionGuardWiringError';
    this.code = code;
  }
}

/** 判定：非可绕过 gate 的快照 → 阻断清单（未满足即阻断，fail-closed） */
export function collectBlockingGates(gates: NonBypassableGateSnapshot): string[] {
  const blocking: string[] = [];
  if (gates.productionGate !== undefined && gates.productionGate !== 'SATISFIED') {
    blocking.push('productionGate');
  }
  if (gates.platformEnablement === false) blocking.push('platformEnablement');
  if (gates.killSwitchActive === true) blocking.push('killSwitch');
  if (gates.providerCapabilityReady === false) blocking.push('providerCapability');
  if (gates.credentialReady === false) blocking.push('credentialGate');
  if (gates.customsPoaRequired === true && gates.customsPoaSatisfied !== true) {
    blocking.push('customsPoaGate');
  }
  if (gates.regulatoryRestriction !== undefined && gates.regulatoryRestriction !== null) {
    blocking.push('regulatoryRestriction');
  }
  if (gates.tenantAccountIsolationOk === false) blocking.push('tenantAccountIsolation');
  return blocking;
}

/**
 * 组合判定：既有 Action Guard + Standing Authorization + 风险分级 + 非可绕过 gate。
 * 不做任何执行；只返回 ALLOW / REQUIRE_APPROVAL / DENY 与来源。
 */
export function evaluateAutonomousExecution(input: AutonomousExecutionInput): AutonomousExecutionDecisionResult {
  const reasonCodes: string[] = [];
  const blockingGates = collectBlockingGates(input.gates);
  const standingEvaluation = evaluateStandingAuthorization({
    authorization: input.authorization,
    request: input.request,
    now: input.now,
  });

  const build = (
    decision: AutonomousExecutionDecision,
    authorizedBy: AuthorizationSource,
    satisfiedGates: string[],
  ): AutonomousExecutionDecisionResult => {
    const body = {
      version: ACTION_GUARD_WIRING_VERSION,
      action: input.guard.action,
      decision,
      authorizedBy,
      satisfiedGates,
      blockingGates,
      standingAuthorizationDecision: input.authorization === null ? null : standingEvaluation.decision,
      standingAuthorizationReasonCodes: [...standingEvaluation.reasonCodes],
      riskTier: input.riskTier.tier,
      riskTierRequiresHitl: input.riskTier.requiresHitl,
      highValueHitlKept: true as const,
      oneTimeApprovalStillSupported: true as const,
      standingAuthorizationCannotBypass: STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES,
      externalWritePerformed: false as const,
      executionPerformed: false as const,
      reasonCodes: [...new Set(reasonCodes)].sort(),
      evaluatedAt: input.now.toISOString(),
    };
    return { kind: 'AUTONOMOUS_EXECUTION_DECISION', ...body, wiringDigest: digestOf(body) };
  };

  // ① 非可绕过 gate：未满足即 DENY（Standing Authorization 无权满足）
  if (blockingGates.length > 0) {
    reasonCodes.push('NON_BYPASSABLE_GATE_BLOCKED:' + blockingGates.join(','));
    return build('DENY', 'NONE', []);
  }

  // ② 既有 Action Guard 权威：DENY 保持 DENY
  if (input.guard.decision === 'DENY') {
    reasonCodes.push('ACTION_GUARD_DENIED:' + input.guard.code);
    return build('DENY', 'NONE', []);
  }

  // ③ 授权已被撤销 / 过期 / 范围不符 / 被篡改 → 立即 fail-closed（不得退化为 REQUIRE_APPROVAL）
  if (standingEvaluation.decision === 'DENY') {
    reasonCodes.push('STANDING_AUTHORIZATION_DENIED');
    return build('DENY', 'NONE', []);
  }

  // ④ 高金额 / TIER 2-3：必须 HITL（授权不得绕过）
  if (input.riskTier.requiresHitl) {
    reasonCodes.push('RISK_TIER_REQUIRES_HITL:' + input.riskTier.tier);
    if (input.riskTier.highValueHitl.applicable) reasonCodes.push('HIGH_VALUE_HITL_KEPT');
    return build('REQUIRE_APPROVAL', 'NONE', []);
  }

  // ⑤ Guard 已 ALLOW（例如 READ_ONLY 或已带 approvalId）：直接放行
  if (input.guard.decision === 'ALLOW') {
    reasonCodes.push('ACTION_GUARD_ALLOWED');
    if (input.guard.requiredGates.includes('humanApproval')) {
      reasonCodes.push('ONE_TIME_APPROVAL_PRESENT');
      return build('ALLOW', 'ONE_TIME_APPROVAL', ['humanApproval']);
    }
    return build('ALLOW', 'NONE', []);
  }

  // ⑥ Guard 要求 humanApproval：允许 standing authorization 满足（仅 TIER_1）
  const requiresHumanApproval = input.guard.requiredGates.includes('humanApproval');
  if (!requiresHumanApproval) {
    reasonCodes.push('GUARD_REQUIRES_NON_HUMAN_GATES');
    return build('REQUIRE_APPROVAL', 'NONE', []);
  }

  if (standingEvaluation.decision === 'SATISFIED' && input.riskTier.tier === 'TIER_1_LOW_RISK_RECOVERY') {
    reasonCodes.push('AUTHORIZED_BY_STANDING_AUTHORIZATION');
    return build('ALLOW', 'STANDING_AUTHORIZATION', ['humanApproval']);
  }

  reasonCodes.push(
    standingEvaluation.decision === 'REQUIRE_APPROVAL'
      ? 'STANDING_AUTHORIZATION_OUT_OF_SCOPE'
      : 'STANDING_AUTHORIZATION_NOT_SUFFICIENT',
  );
  return build('REQUIRE_APPROVAL', 'NONE', []);
}

/** 断言：Standing Authorization 永远不能替代 Broker POA */
export function assertStandingAuthorizationIsNotBrokerPoa(record: {
  standingAuthorizationIsBrokerPoa?: boolean;
}): void {
  if (record.standingAuthorizationIsBrokerPoa === true) {
    throw new ActionGuardWiringError(
      'STANDING_AUTH_CANNOT_BYPASS_GATE',
      'Standing Authorization ≠ Broker POA：报关/申报通道的 POA gate 必须单独满足。',
    );
  }
}

/** 断言：任何声称授权满足了非可绕过 gate 的记录都必须被拒绝 */
export function assertNoNonBypassableGateSatisfiedByStanding(satisfiedGates: readonly string[]): void {
  const violation = satisfiedGates.filter((gate) =>
    (STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES as readonly string[]).includes(gate),
  );
  if (violation.length > 0) {
    throw new ActionGuardWiringError(
      'STANDING_AUTH_CANNOT_BYPASS_GATE',
      'Standing Authorization 不能绕过：' + violation.join(', '),
    );
  }
}
