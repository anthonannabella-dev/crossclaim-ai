// AGENT EXPERIENCE LAYER / P1 — Capability Resolution（server truth → 可用动作）
// ---------------------------------------------------------------------------
// 目标：把「服务端事实快照」解析成**每个域在当前状态下的真实可用动作**。
//   * 动作词汇只来自既有 `ACTION_GUARD_CATALOG`（不新增动作目录）；
//   * 本模块**不做放行决定**，只描述「哪些动作当前没有硬阻断」以及「哪些动作在有效授权下可能自动执行」；
//     最终执行权仍在既有 Action Guard（+ Standing Authorization / HITL）。
//   * 任何外部写 / 资金动作在 Production Gate 未满足时一律 blocked（fail-closed）。

import { ACTION_GUARD_CATALOG, type ActionRiskClass } from '../action-guard/action-guard';
import { digestOf } from '../config-execution-durability/digests';
import type { GoalDomain } from './goal-contract';

export const GOAL_CAPABILITY_RESOLVER_VERSION = 'agent-goal-capability/v1';

/**
 * 域 → 可参与规划的动作（全部必须是 `ACTION_GUARD_CATALOG` 的键，模块加载时断言）。
 * 注意：这里只是「候选」，是否放行由 Action Guard 决定。
 */
export const GOAL_DOMAIN_ACTIONS: Record<GoalDomain, readonly string[]> = {
  PLATFORM: [
    'evidence.read',
    'claim.prepare',
    'recovery.manual_submit',
    'recovery.manual_submit_reference_recorded',
    'claim.submit',
    'appeal.submit',
    'platform.write',
    'billing.draft',
  ],
  LOGISTICS: [
    'evidence.read',
    'claim.prepare',
    'carrier.manual_submission.record',
    'carrier.claim_response.record',
    'recovery.manual_submit',
    'billing.draft',
  ],
  CUSTOMS: ['evidence.read', 'claim.prepare', 'customs.recovery.start', 'recovery.manual_submit', 'billing.draft'],
  INDEPENDENT_SITE: ['evidence.read', 'claim.prepare', 'recovery.manual_submit', 'billing.draft'],
};

// 模块加载即断言：规划面不得出现目录外的动作名（防止静默引入第二套动作词汇）
for (const [domain, actions] of Object.entries(GOAL_DOMAIN_ACTIONS)) {
  for (const action of actions) {
    if (!Object.prototype.hasOwnProperty.call(ACTION_GUARD_CATALOG, action)) {
      throw new Error(`GOAL_DOMAIN_ACTION_NOT_IN_CATALOG: ${domain}.${action}`);
    }
  }
}

/** 服务端事实快照（全部 server-derived；本模块不读取任何客户端声明） */
export interface GoalCapabilityFacts {
  readonly productionGate: 'SATISFIED' | 'NOT_SATISFIED' | 'UNKNOWN';
  readonly writeEnabled: boolean;
  readonly tenantEnabled: boolean;
  readonly featureEnabled: Readonly<Record<string, boolean>>;
  readonly platformEnablement: Readonly<Record<string, boolean>>;
  /** true = 相关 Kill Switch scope 处于阻断状态 */
  readonly killSwitchActive: boolean;
  /** action → provider capability 是否就绪（缺省视为未就绪） */
  readonly providerCapabilityReady: Readonly<Record<string, boolean>>;
  /** Customs 15-gate readiness 中的 POA 结论（Standing Authorization **不能**替代） */
  readonly customsPoaSatisfied: boolean;
  readonly regulatoryRestriction: string | null;
  /** 该 scope 是否存在有效 Standing Authorization（server-derived） */
  readonly standingAuthorizationValid: boolean;
  /** 有效 Standing Authorization 的金额上限（USD）；无有效授权 → null */
  readonly standingAuthorizationLimitUsd: number | null;
}

export interface GoalActionCapability {
  readonly action: string;
  readonly risk: ActionRiskClass;
  readonly requiredGates: readonly string[];
  /** 无硬阻断（仍可能要求一次性审批） */
  readonly executable: boolean;
  /** 在**有效 Standing Authorization 覆盖**的前提下，可能由授权满足 humanApproval 而自动执行 */
  readonly autoExecutableWithAuthorization: boolean;
  readonly blockedReasons: readonly string[];
}

export interface GoalDomainCapability {
  readonly domain: GoalDomain;
  readonly actions: readonly GoalActionCapability[];
  readonly executableActions: readonly string[];
  readonly autoExecutableActions: readonly string[];
  readonly blockedActions: readonly string[];
}

export interface GoalCapabilityResolution {
  readonly kind: 'AGENT_GOAL_CAPABILITY_RESOLUTION';
  readonly version: string;
  readonly organizationId: string;
  readonly domains: readonly GoalDomainCapability[];
  readonly productionGate: GoalCapabilityFacts['productionGate'];
  readonly externalWriteAllowed: false;
  readonly createsSecondGuard: false;
  readonly decisionOwner: 'services/action-guard';
  readonly computedAt: string;
  readonly resolutionDigest: string;
}

function blockReasons(action: string, facts: GoalCapabilityFacts): string[] {
  const entry = ACTION_GUARD_CATALOG[action];
  const reasons: string[] = [];
  const risk = entry.risk;
  const readOnly = risk === 'READ_ONLY';

  if (risk === 'SECRET_ACCESS') reasons.push('SECRET_ACCESS_FORBIDDEN');
  if (!readOnly && facts.killSwitchActive) reasons.push('KILL_SWITCH_ACTIVE');
  if (!readOnly && facts.tenantEnabled !== true) reasons.push('TENANT_NOT_ENABLED');
  if (!readOnly && facts.featureEnabled[action] !== true) reasons.push('FEATURE_FLAG_DISABLED');

  const externalOrMoney = risk === 'EXTERNAL_WRITE' || risk === 'MONEY_MOVEMENT';
  if (externalOrMoney && facts.writeEnabled !== true) reasons.push('WRITE_DISABLED');
  if (externalOrMoney && facts.productionGate !== 'SATISFIED') reasons.push('PRODUCTION_GATE_NOT_SATISFIED');
  if (entry.requires.includes('platformEnablement') && facts.platformEnablement[action] !== true) {
    reasons.push('PLATFORM_ENABLEMENT_MISSING');
  }
  if (entry.requires.includes('productionGate') && facts.productionGate !== 'SATISFIED') {
    reasons.push('PRODUCTION_GATE_NOT_SATISFIED');
  }
  if (entry.requires.includes('hostApproval')) reasons.push('HOST_APPROVAL_REQUIRED');
  if (facts.providerCapabilityReady[action] === false) reasons.push('PROVIDER_CAPABILITY_NOT_READY');
  if (action.startsWith('customs.') && facts.customsPoaSatisfied !== true) reasons.push('CUSTOMS_POA_GATE_UNSATISFIED');
  if (!readOnly && facts.regulatoryRestriction !== null) reasons.push('REGULATORY_RESTRICTION');

  return [...new Set(reasons)].sort();
}

export function resolveGoalCapabilities(input: {
  organizationId: string;
  domains: readonly GoalDomain[];
  facts: GoalCapabilityFacts;
  now: Date;
}): GoalCapabilityResolution {
  const domains: GoalDomainCapability[] = input.domains.map((domain) => {
    const actions: GoalActionCapability[] = GOAL_DOMAIN_ACTIONS[domain].map((action) => {
      const entry = ACTION_GUARD_CATALOG[action];
      const blockedReasons = blockReasons(action, input.facts);
      const executable = blockedReasons.length === 0;
      // 自动执行只可能发生在「只差 humanApproval」且存在有效授权的场景（TIER/风险分级在运行时再判）
      const onlyHumanApproval = entry.requires.every((gate) => gate === 'humanApproval');
      // TIER 0（只读且无闸门）本身就是自动的，不需要授权
      const tier0Read = entry.risk === 'READ_ONLY' && entry.requires.length === 0;
      const autoExecutableWithAuthorization =
        executable &&
        (tier0Read ||
          (entry.risk === 'INTERNAL_WRITE' && onlyHumanApproval && input.facts.standingAuthorizationValid));
      return {
        action,
        risk: entry.risk,
        requiredGates: [...entry.requires],
        executable,
        autoExecutableWithAuthorization,
        blockedReasons,
      };
    });
    return {
      domain,
      actions,
      executableActions: actions.filter((a) => a.executable).map((a) => a.action),
      autoExecutableActions: actions.filter((a) => a.autoExecutableWithAuthorization).map((a) => a.action),
      blockedActions: actions.filter((a) => !a.executable).map((a) => a.action),
    };
  });

  const body = {
    version: GOAL_CAPABILITY_RESOLVER_VERSION,
    organizationId: input.organizationId,
    domains,
    productionGate: input.facts.productionGate,
    computedAt: input.now.toISOString(),
  };

  return {
    kind: 'AGENT_GOAL_CAPABILITY_RESOLUTION',
    ...body,
    externalWriteAllowed: false,
    createsSecondGuard: false,
    decisionOwner: 'services/action-guard',
    resolutionDigest: digestOf(body),
  };
}

export const GOAL_CAPABILITY_BOUNDARY = {
  version: GOAL_CAPABILITY_RESOLVER_VERSION,
  actionVocabularyOwner: 'services/action-guard/action-guard.ts',
  createsActionCatalog: false,
  createsSecondGuard: false,
  decidesExecution: false,
  externalWriteAllowed: false,
  productionGateFailClosed: true,
  customsPoaCannotBeSatisfiedByStandingAuthorization: true,
  forbidden: [
    'planning an action that is not in ACTION_GUARD_CATALOG',
    'treating a client-declared capability as truth',
    'allowing external write while the production gate is not satisfied',
    'using a standing authorization to satisfy the customs POA gate',
  ],
} as const;
