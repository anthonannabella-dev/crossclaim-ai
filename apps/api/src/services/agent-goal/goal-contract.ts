// AGENT EXPERIENCE LAYER / P1 — Agent Goal 契约（薄层）
// ---------------------------------------------------------------------------
// 定位：Goal **只表达客户想得到什么结果**，它不是新的执行引擎、不是新的事实源，
//   也不携带任何动作 / 工具 / 权限 —— 那些一律由 server truth 决定。
//
// 词汇复用（禁止第二套 vocabulary）：
//   * 域：直接复用 Prisma `RecoveryDomain`（PLATFORM / LOGISTICS / CUSTOMS / INDEPENDENT_SITE）；
//     Experience Memory 侧使用 `CARRIER` 表示物流，映射见 `GOAL_DOMAIN_TO_EXPERIENCE_DOMAIN`。
//   * 动作：只允许 `services/action-guard/action-guard.ts` 的 `ACTION_GUARD_CATALOG` 键。
//   * 任务命名空间：只允许既有的保留路由 `task:recovery:`（见 `runtime/rsi-domain-pack.ts`）。
//   * 工具：沿用 `services/intelligence/recovery-tool-registry.ts` 的「模型不得发明工具名」边界。
//
// 执行链（本层只到 plan 为止）：
//   Natural Language → Goal Compiler（确定性优先）→ Structured Goal → Server Validation
//   → Capability Resolution → Task Plan → **既有 ONE SI Runtime**（P2 接线）

export const AGENT_GOAL_VERSION = 'agent-goal/v1';
export const AGENT_GOAL_POLICY_VERSION = 'agent-goal-policy/v1';

/** 白名单 goal type（未知一律拒绝，不做猜测） */
export const GOAL_TYPES = ['DISCOVER_AND_RECOVER', 'DISCOVER_ONLY', 'AUDIT_DOMAIN', 'REVIEW_ATTENTION'] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

/** 与 Prisma `enum RecoveryDomain` 完全一致（不新增域词汇） */
export const GOAL_DOMAINS = ['PLATFORM', 'LOGISTICS', 'CUSTOMS', 'INDEPENDENT_SITE'] as const;
export type GoalDomain = (typeof GOAL_DOMAINS)[number];

/** Experience Memory 使用 CARRIER 表示物流；这里只做显式映射，不新增第三套词汇 */
export const GOAL_DOMAIN_TO_EXPERIENCE_DOMAIN = {
  PLATFORM: 'PLATFORM',
  LOGISTICS: 'CARRIER',
  CUSTOMS: 'CUSTOMS',
  INDEPENDENT_SITE: 'INDEPENDENT_SITE',
} as const;

/**
 * 执行偏好（**只是偏好**）：
 *   AUTO_WHEN_AUTHORIZED  —— 授权范围内可自动执行；实际放行仍由 Action Guard + Standing Authorization 决定
 *   REQUIRE_APPROVAL_EACH —— 每个受保护动作都要一次性审批
 *   DISCOVER_ONLY         —— 只发现，不执行
 */
export const GOAL_EXECUTION_MODES = ['AUTO_WHEN_AUTHORIZED', 'REQUIRE_APPROVAL_EACH', 'DISCOVER_ONLY'] as const;
export type GoalExecutionMode = (typeof GOAL_EXECUTION_MODES)[number];

export const GOAL_TIME_RANGE_KINDS = ['LAST_N_MONTHS', 'YEAR_TO_DATE', 'ALL_TIME'] as const;
export type GoalTimeRangeKind = (typeof GOAL_TIME_RANGE_KINDS)[number];

/** v1 只支持 USD（与 Standing Authorization 的 monetaryLimitUsd 同口径） */
export const GOAL_APPROVAL_CURRENCIES = ['USD'] as const;
export type GoalApprovalCurrency = (typeof GOAL_APPROVAL_CURRENCIES)[number];

export const GOAL_MAX_MONTHS = 36;
export const GOAL_MAX_INTENT_LENGTH = 600;

export type GoalTimeRange =
  | { readonly kind: 'LAST_N_MONTHS'; readonly months: number }
  | { readonly kind: 'YEAR_TO_DATE' }
  | { readonly kind: 'ALL_TIME' };

export interface GoalApprovalThresholdPreference {
  readonly currency: GoalApprovalCurrency;
  readonly amount: number;
}

/**
 * 编译器输出（**未受信**，必须经 `validateAgentGoalDraft`）。
 * 注意：这里**没有** organization / account / provider / action / service / tool 字段。
 */
export interface AgentGoalDraft {
  readonly goalType: GoalType;
  readonly domains: readonly GoalDomain[];
  readonly timeRange: GoalTimeRange;
  readonly executionMode: GoalExecutionMode;
  /** 客户**偏好**的自动执行金额上限；实际上限 = min(偏好, 有效 Standing Authorization 限额) */
  readonly approvalThreshold: GoalApprovalThresholdPreference | null;
  /** 编译器命中的稳定信号 code（可审计；不含原始用户文本） */
  readonly matchedSignals: readonly string[];
}

export interface GoalServerContext {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly now: Date;
}

/** 服务端验证后的目标（server-derived；tenant 来自服务端会话，不来自草稿） */
export interface ValidatedAgentGoal {
  readonly kind: 'VALIDATED_AGENT_GOAL';
  readonly version: string;
  readonly policyVersion: string;
  readonly goalId: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly goalType: GoalType;
  readonly domains: readonly GoalDomain[];
  readonly timeRange: GoalTimeRange;
  readonly executionMode: GoalExecutionMode;
  readonly approvalThresholdPreference: GoalApprovalThresholdPreference | null;
  /** 声明自动执行时，**必须**有有效 Standing Authorization 才能进入自动化路径 */
  readonly requiresStandingAuthorizationForAutoExecution: boolean;
  /** 恒为 false：本层不执行任何动作，也不授予任何权限 */
  readonly grantsPermissions: false;
  readonly externalWriteGranted: false;
  readonly validatedAt: string;
  readonly goalDigest: string;
}

export type GoalErrorCode =
  | 'GOAL_EMPTY_INTENT'
  | 'GOAL_INTENT_TOO_LONG'
  | 'GOAL_UNSUPPORTED_INTENT'
  | 'GOAL_INJECTION_SUSPECTED'
  | 'GOAL_MALFORMED'
  | 'GOAL_FORBIDDEN_FIELD'
  | 'GOAL_UNKNOWN_FIELD'
  | 'GOAL_UNSUPPORTED_GOAL_TYPE'
  | 'GOAL_UNSUPPORTED_DOMAIN'
  | 'GOAL_UNSUPPORTED_EXECUTION_MODE'
  | 'GOAL_UNSUPPORTED_TIME_RANGE'
  | 'GOAL_TENANT_FORGED'
  | 'GOAL_ACTION_INJECTION'
  | 'GOAL_SERVICE_INJECTION'
  | 'GOAL_EXECUTION_MODE_NOT_ALLOWED_FOR_TYPE'
  | 'GOAL_DOMAIN_COUNT_INVALID'
  | 'GOAL_TENANT_CONTEXT_REQUIRED';

export class AgentGoalError extends Error {
  readonly code: GoalErrorCode;

  constructor(code: GoalErrorCode, message: string) {
    super(message);
    this.name = 'AgentGoalError';
    this.code = code;
  }
}

export const AGENT_GOAL_BOUNDARY = {
  version: AGENT_GOAL_VERSION,
  goalExpressesIntentOnly: true,
  goalIsNotARuntime: true,
  goalIsNotAFactSource: true,
  createsSecondRuntime: false,
  createsSecondPolicyEngine: false,
  createsSecondGuard: false,
  createsSecondFactSource: false,
  naturalLanguageExecutesNothing: true,
  serverTruthDecides: [
    'organization',
    'platformAccount',
    'provider',
    'availableCapability',
    'actionCatalog',
    'permission',
    'authorizationValidity',
    'standingAuthorizationScope',
    'amountLimit',
    'riskTier',
    'providerAvailability',
    'customsReadiness',
    'productionGate',
    'externalWriteGate',
    'hitlRequirement',
  ],
  llmMayOnly: ['interpretIntent', 'chooseWhitelistedGoalType', 'proposeScope', 'proposeTimeRange', 'proposeExecutionPreference'],
  forbidden: [
    'emitting service / tool / function names for execution',
    'carrying tenant, account or provider identity in the goal',
    'carrying action names that bypass the Action Guard catalog',
    'deciding permissions, eligibility or monetary amounts',
    'granting any external write capability',
    'starting a second runtime, scheduler, workflow engine or policy engine',
  ],
} as const;
