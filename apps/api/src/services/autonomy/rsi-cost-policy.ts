/**
 * RSI Cost Control Layer —— 三级执行策略 / 预算 / 熔断（纯函数，零 IO）
 * ---------------------------------------------------------------
 * 硬规则（OWNER《AI Model Invocation / Cost Control Layer》）：
 *   · 默认 LEVEL 0 = RULE ENGINE，**不调用 LLM**；只有真正需要语义理解/根因/复杂修复/Prompt 优化/
 *     文档理解/Adapter 生成/复杂 Judge 时才升级；
 *   · RSI **不持有任何 Provider Key**：只向 `ModelRouterPort` 声明 taskType / complexity / maxCost /
 *     latency / requiredCapability，由 Router 选模型（本模块只定义 Port 契约，不含凭据字段）；
 *   · 预算耗尽 → COST_SAFE_MODE：规则引擎、健康监控、critical alert 继续，普通 AI 优化暂停，
 *     高风险事项转 OWNER_ACTION_REQUIRED，禁止无限调用；
 *   · 单个 Incident 有硬上限（attempts / candidates / llmCalls / tokens / wall-clock），达到即
 *     AUTONOMY_BUDGET_EXHAUSTED 并停止递归。
 */

export const RSI_EXECUTION_LEVELS = ['LEVEL_0_RULE', 'LEVEL_1_LOW_COST', 'LEVEL_2_STRONG'] as const;
export type RsiExecutionLevel = (typeof RSI_EXECUTION_LEVELS)[number];

export const RSI_RULE_SOLVABLE_SIGNALS = [
  'CI_FAIL',
  'TEST_FAILURE',
  'TYPECHECK_FAILURE',
  'HEALTH_CHECK',
  'SCHEMA_COMPARISON',
  'RETRY',
  'RESTART',
  'ROLLBACK',
  'BENCHMARK_COMPARISON',
  'THRESHOLD_BREACH',
  'METRIC_REGRESSION',
] as const;

export const RSI_AI_REQUIRED_CAPABILITIES = [
  'SEMANTIC_UNDERSTANDING',
  'ROOT_CAUSE_ANALYSIS',
  'COMPLEX_CODE_FIX',
  'PROMPT_OPTIMIZATION',
  'API_DOC_COMPREHENSION',
  'ADAPTER_GENERATION',
  'COMPLEX_JUDGE',
] as const;
export type RsiAiCapability = (typeof RSI_AI_REQUIRED_CAPABILITIES)[number];

/** 规则可解的信号：必须走 LEVEL 0，禁止调用 LLM。 */
export function isRuleSolvable(signalKind: string): boolean {
  return (RSI_RULE_SOLVABLE_SIGNALS as readonly string[]).includes(signalKind);
}

/**
 * 选择执行等级：默认 LEVEL 0。
 * 只有声明了「真正需要 AI 的能力」才升级；复杂能力 → LEVEL 2，其余 AI 能力 → LEVEL 1。
 */
export function selectExecutionLevel(input: {
  signalKind: string;
  requiredCapabilities?: readonly string[];
}): RsiExecutionLevel {
  const capabilities = (input.requiredCapabilities ?? []).filter((capability) =>
    (RSI_AI_REQUIRED_CAPABILITIES as readonly string[]).includes(capability),
  );
  if (capabilities.length === 0) return 'LEVEL_0_RULE';
  const strong = ['COMPLEX_CODE_FIX', 'ROOT_CAUSE_ANALYSIS', 'ADAPTER_GENERATION', 'COMPLEX_JUDGE', 'PROMPT_OPTIMIZATION'];
  return capabilities.some((capability) => strong.includes(capability)) ? 'LEVEL_2_STRONG' : 'LEVEL_1_LOW_COST';
}

/** 预算配置（来自环境；未设置取保守默认）。 */
export interface RsiBudgetLimits {
  dailyBudget: number;
  monthlyBudget: number;
  maxCostPerIncident: number;
  maxStrongModelCallsPerTask: number;
  maxAttemptsPerIncident: number;
  maxCandidatesPerIncident: number;
  maxLlmCallsPerIncident: number;
  maxTokensPerIncident: number;
  maxWallClockMinutesPerIncident: number;
}

export const RSI_BUDGET_DEFAULTS: RsiBudgetLimits = {
  dailyBudget: Number(process.env.RSI_DAILY_AI_BUDGET ?? 5),
  monthlyBudget: Number(process.env.RSI_MONTHLY_AI_BUDGET ?? 50),
  maxCostPerIncident: Number(process.env.RSI_MAX_COST_PER_INCIDENT ?? 0.5),
  maxStrongModelCallsPerTask: Number(process.env.RSI_MAX_STRONG_MODEL_CALLS_PER_TASK ?? 2),
  maxAttemptsPerIncident: 3,
  maxCandidatesPerIncident: 3,
  maxLlmCallsPerIncident: 6,
  maxTokensPerIncident: 200_000,
  maxWallClockMinutesPerIncident: 30,
};

export interface RsiCostUsage {
  spentToday: number;
  spentThisMonth: number;
  incidentSpent: number;
  incidentAttempts: number;
  incidentCandidates: number;
  incidentLlmCalls: number;
  incidentTokens: number;
  incidentElapsedMinutes: number;
  strongCallsForTask: number;
}

export type RsiCostDecision =
  | { allowed: true; level: RsiExecutionLevel; costSafeMode: boolean; reason: 'RULE_ENGINE' | 'WITHIN_BUDGET' }
  | {
      allowed: false;
      level: RsiExecutionLevel;
      costSafeMode: boolean;
      reason:
        | 'COST_SAFE_MODE'
        | 'AUTONOMY_BUDGET_EXHAUSTED'
        | 'INCIDENT_COST_LIMIT'
        | 'STRONG_MODEL_CALL_LIMIT'
        | 'OWNER_ACTION_REQUIRED';
    };

/** 是否进入 COST_SAFE_MODE（日/月预算任一耗尽）。 */
export function isCostSafeMode(usage: RsiCostUsage, limits: RsiBudgetLimits = RSI_BUDGET_DEFAULTS): boolean {
  return usage.spentToday >= limits.dailyBudget || usage.spentThisMonth >= limits.monthlyBudget;
}

/**
 * 核心决策：给定信号与用量，返回是否允许调用模型、用哪个等级。
 * 规则可解信号永远 LEVEL 0（allowed，但**不是** AI 调用）；AI 请求在预算/熔断下会被拒绝。
 */
export function decideRsiModelCall(input: {
  signalKind: string;
  requiredCapabilities?: readonly string[];
  usage: RsiCostUsage;
  limits?: RsiBudgetLimits;
  ownerGatedAction?: string | null;
}): RsiCostDecision {
  const limits = input.limits ?? RSI_BUDGET_DEFAULTS;
  const level = selectExecutionLevel(input);
  const costSafeMode = isCostSafeMode(input.usage, limits);

  // LEVEL 0：规则引擎，始终允许（不消耗 token），COST_SAFE_MODE 下也继续运行。
  if (level === 'LEVEL_0_RULE') {
    return { allowed: true, level, costSafeMode, reason: 'RULE_ENGINE' };
  }

  // OWNER-gated 动作：即便预算充足也不由 RSI 处理，转宿主。
  if (input.ownerGatedAction) {
    return { allowed: false, level, costSafeMode, reason: 'OWNER_ACTION_REQUIRED' };
  }

  // 单个 Incident 的硬上限（防递归烧 token）。
  const exhausted =
    input.usage.incidentAttempts >= limits.maxAttemptsPerIncident ||
    input.usage.incidentCandidates >= limits.maxCandidatesPerIncident ||
    input.usage.incidentLlmCalls >= limits.maxLlmCallsPerIncident ||
    input.usage.incidentTokens >= limits.maxTokensPerIncident ||
    input.usage.incidentElapsedMinutes >= limits.maxWallClockMinutesPerIncident;
  if (exhausted) {
    return { allowed: false, level, costSafeMode, reason: 'AUTONOMY_BUDGET_EXHAUSTED' };
  }

  if (input.usage.incidentSpent >= limits.maxCostPerIncident) {
    return { allowed: false, level, costSafeMode, reason: 'INCIDENT_COST_LIMIT' };
  }

  if (level === 'LEVEL_2_STRONG' && input.usage.strongCallsForTask >= limits.maxStrongModelCallsPerTask) {
    return { allowed: false, level, costSafeMode, reason: 'STRONG_MODEL_CALL_LIMIT' };
  }

  // COST_SAFE_MODE：普通 AI 任务暂停（规则/健康/告警不受影响，已在上面放行）。
  if (costSafeMode) {
    return { allowed: false, level, costSafeMode, reason: 'COST_SAFE_MODE' };
  }

  return { allowed: true, level, costSafeMode, reason: 'WITHIN_BUDGET' };
}

/**
 * ModelRouterPort —— RSI 只声明需求，**不持有任何 Provider Key**。
 * 注意：请求结构里没有 provider / apiKey / credential 字段（由 Router 内部保管凭据）。
 */
export interface RsiModelCallRequest {
  taskType: string;
  complexity: 'LOW' | 'MEDIUM' | 'HIGH';
  maxCost: number;
  latencyRequirementMs: number;
  requiredCapability: RsiAiCapability | 'NONE';
  /** 审计关联字段（不含任何客户数据/secret）。 */
  incidentId: string | null;
  taskId: string | null;
}

export interface ModelRouterPort {
  route(request: RsiModelCallRequest): Promise<{
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
    latencyMs: number;
    retryCount: number;
  }>;
}

/** 调用记录结构（禁止 secret / credential / 原始敏感客户数据）。 */
export interface RsiModelCallRecord {
  incidentId: string | null;
  taskId: string | null;
  provider: string;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  latencyMs: number;
  result: 'SUCCESS' | 'FAILED' | 'REJECTED';
  retryCount: number;
}

export const RSI_COST_POLICY_BOUNDARY = {
  holdsProviderCredentials: false,
  recordsCustomerData: false,
  defaultLevel: 'LEVEL_0_RULE',
  externalWritePerformed: false,
  productionCredentials: 'ABSENT',
} as const;
