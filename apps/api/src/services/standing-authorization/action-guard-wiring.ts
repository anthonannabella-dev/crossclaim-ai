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
  /** AEL FINAL2 / C3：本次判定要求的非可绕过 gate（核心三项 ∪ action 派生） */
  requiredNonBypassableGates: string[];
  /** AEL FINAL2 / C3：缺少 server-owned 显式满足证明的 gate（缺失即 DENY） */
  incompleteGateProofs: string[];
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

/** AEL FINAL2 / C3：任何 action 都必须显式证明的核心非可绕过 gate */
export const CORE_REQUIRED_NON_BYPASSABLE_GATE_FIELDS = [
  'productionGate',
  'killSwitch',
  'tenantAccountIsolation',
] as const;

export const CORE_NON_BYPASSABLE_GATE_REQUIREMENT_NOTE =
  '非可绕过 gate 必须由服务端给出显式满足证明；缺失 / UNKNOWN 一律 DENY。';

export const ACTION_GUARD_WIRING_BOUNDARY = {
  reusesExistingActionGuard: true,
  createsSecondGuard: false,
  keepsOneTimeHumanApproval: true,
  standingAuthorizationSatisfiesOnly: ['humanApproval'],
  nonBypassableGates: STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES,
  requiresExplicitGateProof: true,
  gateProofFailClosed: true,
  coreRequiredNonBypassableGates: CORE_REQUIRED_NON_BYPASSABLE_GATE_FIELDS,
  highValueHitl: 'KEEP',
  executesActions: false,
  externalWritePerformed: false,
  forbidden: [
    'overriding an Action Guard DENY',
    'satisfying production / platform / kill-switch / credential / regulatory / isolation gates with a standing authorization',
    'bypassing high-value HITL',
    'using a standing authorization as a broker POA',
    'treating a missing or UNKNOWN non-bypassable gate snapshot field as satisfied',
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

/**
 * AEL FINAL2 / C3（审计裁决 MSG-20261007-01 CHANGE 3）：
 *   非可绕过 gate 必须有 **server-owned 的显式满足证明**。
 *   * 证明缺失（字段 undefined）或 UNKNOWN → 一律 DENY（fail-closed）；
 *   * 核心三项在**任何** action 上都必需：productionGate / killSwitch / tenantAccountIsolation；
 *   * 其余按 action 的 `guard.requiredGates` 派生（platformEnablement / productionGate ...）——
 *     调用方一旦声明某个非可绕过 gate，就必须给出该 gate 的显式证明；
 *   * 显式否定（NOT_SATISFIED / false / 非 null 的法规限制）同样 DENY。
 */
export type GateProof = 'SATISFIED' | 'NOT_SATISFIED' | 'UNKNOWN';

/** 单个非可绕过 gate 的证明（**只看快照里的显式值**；未提供 = UNKNOWN，绝不当满足） */
export function evaluateGateProof(gate: string, gates: NonBypassableGateSnapshot): GateProof {
  const fromBoolean = (value: boolean | undefined): GateProof =>
    value === undefined ? 'UNKNOWN' : value ? 'SATISFIED' : 'NOT_SATISFIED';
  switch (gate) {
    case 'productionGate':
      if (gates.productionGate === undefined || gates.productionGate === 'UNKNOWN') return 'UNKNOWN';
      return gates.productionGate === 'SATISFIED' ? 'SATISFIED' : 'NOT_SATISFIED';
    case 'killSwitch':
      // 证明 = 「确认未激活」；未提供视为未知（不是「默认没开」）
      if (gates.killSwitchActive === undefined) return 'UNKNOWN';
      return gates.killSwitchActive === false ? 'SATISFIED' : 'NOT_SATISFIED';
    case 'tenantAccountIsolation':
      return fromBoolean(gates.tenantAccountIsolationOk);
    case 'platformEnablement':
      return fromBoolean(gates.platformEnablement);
    case 'providerCapability':
      return fromBoolean(gates.providerCapabilityReady);
    case 'credentialGate':
      return fromBoolean(gates.credentialReady);
    case 'customsPoaGate':
      // 显式声明「本动作不涉及 POA」也构成证明；否则必须给出 POA 满足结论
      if (gates.customsPoaRequired === undefined) return 'UNKNOWN';
      if (gates.customsPoaRequired === false) return 'SATISFIED';
      return gates.customsPoaSatisfied === true ? 'SATISFIED' : 'NOT_SATISFIED';
    case 'regulatoryRestriction':
      if (gates.regulatoryRestriction === undefined) return 'UNKNOWN';
      return gates.regulatoryRestriction === null ? 'SATISFIED' : 'NOT_SATISFIED';
    default:
      return 'UNKNOWN';
  }
}

/** required non-bypassable gate 集合 = 核心三项 ∪ 由 action（guard.requiredGates）派生 */
export function computeRequiredNonBypassableGates(requiredGates: readonly string[] = []): string[] {
  const required = new Set<string>(CORE_REQUIRED_NON_BYPASSABLE_GATE_FIELDS);
  for (const gate of requiredGates) {
    if ((STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES as readonly string[]).includes(gate)) required.add(gate);
  }
  return [...required].sort();
}

export interface NonBypassableGateAssessment {
  required: string[];
  satisfied: string[];
  blocking: string[];
  /** required 但缺少显式证明（undefined / UNKNOWN）—— fail-closed 阻断 */
  incomplete: string[];
}

/** 逐 gate 评估：显式满足 / 显式否定 / 证明缺失（缺失一律 fail-closed） */
export function assessNonBypassableGates(
  gates: NonBypassableGateSnapshot,
  requiredGates: readonly string[] = [],
): NonBypassableGateAssessment {
  const required = computeRequiredNonBypassableGates(requiredGates);
  const satisfied: string[] = [];
  const blocking: string[] = [];
  const incomplete: string[] = [];
  for (const gate of required) {
    const proof = evaluateGateProof(gate, gates);
    if (proof === 'SATISFIED') satisfied.push(gate);
    else if (proof === 'NOT_SATISFIED') blocking.push(gate);
    else incomplete.push(gate);
  }
  // 显式否定证据：即使该 gate 未出现在 requiredGates 里，同样阻断
  const explicitBlocking: Array<[string, boolean]> = [
    ['platformEnablement', gates.platformEnablement === false],
    ['providerCapability', gates.providerCapabilityReady === false],
    ['credentialGate', gates.credentialReady === false],
    ['customsPoaGate', gates.customsPoaRequired === true && gates.customsPoaSatisfied !== true],
    ['regulatoryRestriction', gates.regulatoryRestriction !== undefined && gates.regulatoryRestriction !== null],
  ];
  for (const [gate, isBlocking] of explicitBlocking) {
    if (isBlocking && !blocking.includes(gate)) blocking.push(gate);
  }
  return { required, satisfied, blocking, incomplete };
}

/**
 * 判定：非可绕过 gate 快照 → 阻断清单（显式未满足 **或** 证明缺失，一律阻断）。
 * 兼容旧签名：不传 requiredGates 时，至少要求核心三项的显式证明。
 */
export function collectBlockingGates(
  gates: NonBypassableGateSnapshot,
  requiredGates: readonly string[] = [],
): string[] {
  const assessment = assessNonBypassableGates(gates, requiredGates);
  return [...assessment.blocking, ...assessment.incomplete];
}

/**
 * 组合判定：既有 Action Guard + Standing Authorization + 风险分级 + 非可绕过 gate。
 * 不做任何执行；只返回 ALLOW / REQUIRE_APPROVAL / DENY 与来源。
 */
export function evaluateAutonomousExecution(input: AutonomousExecutionInput): AutonomousExecutionDecisionResult {
  const reasonCodes: string[] = [];
  // AEL FINAL2 / C3：required non-bypassable gate = 核心三项 ∪ action（guard.requiredGates）派生；
  // 每个都必须有 server-owned 显式满足证明，缺失 / UNKNOWN 一律 DENY。
  const requiredNonBypassableGates = computeRequiredNonBypassableGates(input.guard.requiredGates);
  const gateAssessment = assessNonBypassableGates(input.gates, requiredNonBypassableGates);
  const blockingGates = [...gateAssessment.blocking, ...gateAssessment.incomplete];
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
      requiredNonBypassableGates: [...requiredNonBypassableGates],
      incompleteGateProofs: [...gateAssessment.incomplete],
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

  // ① 非可绕过 gate：必须有显式满足证明（显式未满足 或 证明缺失 / UNKNOWN 一律 DENY）
  //   Standing Authorization 无权满足任何一项（见 STANDING_AUTHORIZATION_NON_BYPASSABLE_GATES）
  if (blockingGates.length > 0) {
    for (const gate of gateAssessment.incomplete) {
      reasonCodes.push('NON_BYPASSABLE_GATE_SNAPSHOT_INCOMPLETE:' + gate);
    }
    for (const gate of gateAssessment.blocking) {
      reasonCodes.push('NON_BYPASSABLE_GATE_BLOCKED:' + gate);
    }
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
