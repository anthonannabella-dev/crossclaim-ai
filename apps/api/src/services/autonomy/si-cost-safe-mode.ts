/**
 * SI-COST-OPTIMIZATION C3 —— Cost Safe Mode（确定性；零模型依赖）
 * ---------------------------------------------------------------
 * 硬约束（MSG-20261005-30 3.5 / MSG-20261005-37 NEXT #3）：
 *   - budget exhausted → 停止**普通 AI 调用**（STANDARD_AI）；
 *   - LEVEL_0_RULE 继续运行（规则 / 状态机 / 校验 / 对账永不受影响）；
 *   - health check 继续；
 *   - critical alert 继续；
 *   - **不产生 retry storm**：SAFE MODE 下的拒绝是终局判定（retryAllowed = false）。
 *
 * 阈值来源：durable `AiBudgetPolicy`（EffectiveAiBudget）与 durable `AiCostLedgerEntry` 聚合。
 * 本模块为纯函数：不做 IO、不读环境变量、不持有任何凭据、不记录客户数据。
 */

export const AI_COST_SAFE_MODE_STATES = ['NORMAL', 'COST_SAFE'] as const;
export type AiCostSafeModeState = (typeof AI_COST_SAFE_MODE_STATES)[number];

export const AI_COST_SAFE_MODE_CHANNELS = [
  'STANDARD_AI',
  'LEVEL_0_RULE',
  'HEALTH_CHECK',
  'CRITICAL_ALERT',
] as const;
export type AiCostSafeModeChannel = (typeof AI_COST_SAFE_MODE_CHANNELS)[number];

/** SAFE MODE 下仍然必须继续运行的通道（安全 / 健康 / 告警永不因降本而停） */
export const AI_COST_SAFE_MODE_EXEMPT_CHANNELS: readonly AiCostSafeModeChannel[] = [
  'LEVEL_0_RULE',
  'HEALTH_CHECK',
  'CRITICAL_ALERT',
];

export interface AiCostSafeModeBudgetView {
  dailyLimitMicros?: number | null;
  monthlyLimitMicros?: number | null;
  perIncidentLimitMicros?: number | null;
  strongCallLimit?: number | null;
  tokenLimit?: number | null;
  concurrencyLimit?: number | null;
}

export interface AiCostSafeModeUsageView {
  /** 当前 UTC 日账本聚合成本（micros） */
  dayMicros: number;
  /** 当前 UTC 月账本聚合成本（micros） */
  monthMicros: number;
  /** 当前 incident 账本聚合成本（micros） */
  incidentMicros: number;
  /** 当前 UTC 日账本聚合 token（input + output） */
  dayTokens: number;
  /** 当前 UTC 日 LEVEL_2_STRONG 调用次数 */
  dayStrongCalls: number;
}

export interface AiCostSafeModeVerdict {
  state: AiCostSafeModeState;
  reason: string;
  exhaustedDimensions: readonly string[];
  standardAiAllowed: boolean;
  exemptChannelsAlwaysAllowed: readonly AiCostSafeModeChannel[];
  /** SAFE MODE 下禁止无上限重试；此处恒为 false（终局判定） */
  retryAllowed: false;
}

export interface AiCostSafeModeAdmission {
  allowed: boolean;
  channel: AiCostSafeModeChannel;
  state: AiCostSafeModeState;
  reason: string;
  retryAllowed: false;
}

export const AI_COST_SAFE_MODE_BOUNDARY = {
  level0RuleAffected: false,
  healthCheckAffected: false,
  criticalAlertAffected: false,
  retryStormAllowed: false,
  secondBudgetSource: 'FORBIDDEN（阈值只来自 durable policy；用量只来自 durable ledger）',
  modelDependency: 'NONE（纯确定性函数）',
  recordsCustomerData: false,
} as const;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * 输入校验 fail-closed：任何缺失 / 非法 / 负数一律拒绝（不放大模型调用权）。
 * 未知状态默认 SAFE（不自动升级昂贵模型），见 `evaluateAiCostSafeMode` 调用方约定。
 */
export function validateAiCostSafeModeInputs(input: {
  budget: AiCostSafeModeBudgetView;
  usage: AiCostSafeModeUsageView;
}): { ok: true } | { ok: false; reason: string } {
  for (const field of ['dailyLimitMicros', 'monthlyLimitMicros', 'perIncidentLimitMicros', 'strongCallLimit', 'tokenLimit', 'concurrencyLimit'] as const) {
    const value = input.budget[field];
    if (value === undefined || value === null) continue;
    if (!isNonNegativeInteger(value)) return { ok: false, reason: 'AI_COST_SAFE_MODE_BUDGET_INVALID:' + field };
  }
  for (const field of ['dayMicros', 'monthMicros', 'incidentMicros', 'dayTokens', 'dayStrongCalls'] as const) {
    if (!isNonNegativeInteger(input.usage[field])) {
      return { ok: false, reason: 'AI_COST_SAFE_MODE_USAGE_INVALID:' + field };
    }
  }
  return { ok: true };
}

/**
 * 由「已触顶维度」构造判定（账本驱动的 durable resolver 与纯函数判定共用同一构造）。
 * `exhausted` 为空 → NORMAL；非空 → COST_SAFE。retryAllowed 恒为 false。
 */
export function createAiCostSafeModeVerdict(exhaustedDimensions: readonly string[]): AiCostSafeModeVerdict {
  const dimensionList = Array.from(new Set(exhaustedDimensions)).sort();
  const state: AiCostSafeModeState = dimensionList.length > 0 ? 'COST_SAFE' : 'NORMAL';
  return {
    state,
    reason: state === 'COST_SAFE' ? 'AI_COST_SAFE_MODE_EXHAUSTED:' + dimensionList.join('+') : 'WITHIN_BUDGET',
    exhaustedDimensions: dimensionList,
    standardAiAllowed: state === 'NORMAL',
    exemptChannelsAlwaysAllowed: AI_COST_SAFE_MODE_EXEMPT_CHANNELS,
    retryAllowed: false,
  };
}

/**
 * 判定当前是否进入 COST_SAFE：
 *   任一日 / 月 / incident / token / strong-call 维度触顶 → COST_SAFE（fail-safe）。
 * 未知 / 非法输入 → 抛错（fail-closed；调用方不得据此继续普通 AI 调用）。
 */
export function evaluateAiCostSafeMode(input: {
  budget: AiCostSafeModeBudgetView;
  usage: AiCostSafeModeUsageView;
}): AiCostSafeModeVerdict {
  const validated = validateAiCostSafeModeInputs(input);
  if (!validated.ok) throw new Error(validated.reason);

  const exhausted: string[] = [];
  const breached = (limit: number | null | undefined, used: number, dimension: string): void => {
    if (typeof limit === 'number' && used >= limit) exhausted.push(dimension);
  };
  breached(input.budget.dailyLimitMicros, input.usage.dayMicros, 'DAILY');
  breached(input.budget.monthlyLimitMicros, input.usage.monthMicros, 'MONTHLY');
  breached(input.budget.perIncidentLimitMicros, input.usage.incidentMicros, 'INCIDENT');
  breached(input.budget.tokenLimit, input.usage.dayTokens, 'TOKEN');
  breached(input.budget.strongCallLimit, input.usage.dayStrongCalls, 'STRONG_CALL');

  return createAiCostSafeModeVerdict(exhausted);
}

/**
 * 通道准入：SAFE MODE 只停 STANDARD_AI；L0 / health / critical alert 永久放行。
 * 放行通道的 reason 明确标注「EXEMPT」，便于审计区分「降级」与「豁免」。
 */
export function decideAiCostSafeModeAdmission(input: {
  verdict: AiCostSafeModeVerdict;
  channel: AiCostSafeModeChannel;
}): AiCostSafeModeAdmission {
  if (AI_COST_SAFE_MODE_EXEMPT_CHANNELS.includes(input.channel)) {
    return {
      allowed: true,
      channel: input.channel,
      state: input.verdict.state,
      reason: 'AI_COST_SAFE_MODE_EXEMPT_CHANNEL:' + input.channel,
      retryAllowed: false,
    };
  }
  if (input.verdict.standardAiAllowed) {
    return {
      allowed: true,
      channel: input.channel,
      state: input.verdict.state,
      reason: 'WITHIN_BUDGET',
      retryAllowed: false,
    };
  }
  return {
    allowed: false,
    channel: input.channel,
    state: input.verdict.state,
    reason: 'AI_COST_SAFE_MODE:' + (input.verdict.exhaustedDimensions.join('+') || 'EXHAUSTED'),
    retryAllowed: false,
  };
}
