/**
 * RSI Model Router 接入层（RSI-COST-02 + 适配器 contract v2）
 * ---------------------------------------------------------------
 * 职责
 *   · 实现 `ModelRouterPort`：RSI 只能通过 Router 间接使用模型；
 *   · **凭据只在 host 注入的 adapter 内**：本模块不读任何环境密钥，不发起任何 HTTP；
 *   · 调用前先过 `decideRsiModelCall()`（优先级/预算/熔断），拒绝时不调用 provider；
 *   · 调用前还必须证明「本次最坏费用 <= 剩余日/月/incident/本次调用上限」，否则
 *     `BUDGET_EXCEEDED` 且不调用 adapter，并把 REJECTED 记入 ledger；
 *   · 每次调用都产出可审计记录（provider/model/tokens/cost/latency/retry）；
 *   · 低成本优先：LEVEL_1 只用低成本 provider；只有 LEVEL_2 且低成本 attempt 失败才升级强模型。
 *
 * 适配器 contract v2（裁定 MSG-20261005-09）
 *   · 一次 invoke = **恰好一次** provider attempt；SDK 自动重试必须关闭，重试只由 supervisor
 *     发起且每次都要重新做预算检查；因此 adapter 结果里没有 retryCount 输入位；
 *   · `timeoutMs` 是显式调用字段（Runner timeout 不能取消已经发出的 HTTP 请求）；
 *   · 结果用判别式联合，不用一堆 nullable 字段；失败调用也可能已经产生 token/费用，
 *     所以 `ok:false` 时 `usage` 允许非空，且必须进入 ledger。
 */

import {
  decideRsiModelCall,
  RSI_BUDGET_DEFAULTS,
  type ModelRouterPort,
  type RsiBudgetLimits,
  type RsiCostUsage,
  type RsiModelCallRecord,
  type RsiModelCallRequest,
} from './rsi-cost-policy';
import { evaluateAiNecessity } from './rsi-ai-necessity-gate';
import {
  AI_ESCALATION_DEFAULTS,
  assertJudgeCannotAuthorizeModelCall,
  decideAiEscalation,
  type AiEscalationLimits,
} from './rsi-model-escalation-policy';

export type RsiProviderTier = 'LOW_COST' | 'STRONG';

/** 一次 provider attempt 的用量（成功与失败都可能产生真实费用） */
export interface RsiProviderUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export type RsiProviderFailureReason =
  | 'PROVIDER_FAILED'
  | 'INPUT_SCHEMA_INVALID'
  | 'INPUT_SENSITIVE_DATA_DETECTED'
  | 'OUTPUT_SCHEMA_INVALID'
  | 'OUTPUT_SENSITIVE_DATA_DETECTED'
  | 'TIMEOUT_MS_INVALID'
  | 'MAX_OUTPUT_TOKENS_INVALID'
  | 'PROVIDER_TIMEOUT'
  | 'BUDGET_GUARD_UNENFORCEABLE';

/** 判别式联合：SUCCESS 带 modelId/outputRef/outputDigest/usage；FAILURE 带 reason + 可选 usage */
export type RsiProviderAttemptResult =
  | {
      ok: true;
      modelId: string;
      outputRef: string;
      outputDigest: string;
      usage: RsiProviderUsage;
      latencyMs: number;
    }
  | {
      ok: false;
      reason: RsiProviderFailureReason;
      usage?: RsiProviderUsage;
      latencyMs: number;
    };

/**
 * 计价模型：用于**调用前**最坏费用估算。
 * 缺失 / 非有限 / 非正 → BUDGET_GUARD_UNENFORCEABLE（fail-closed，不调用 provider）。
 */
export interface RsiProviderPricing {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
  maxInputTokens: number;
}

/** 完整 invocation：一次 adapter 调用所需的全部显式字段（不含任何凭据） */
export interface RsiModelInvocation {
  callId: string;
  taskKind: string;
  promptRef: string;
  promptDigest: string;
  tier: RsiProviderTier;
  timeoutMs: number;
  maxOutputTokens: number;
  budget: {
    remainingUsd: number;
    maxUsdThisCall: number;
  };
}

/** host 注入的 provider 适配器；本接口不下发、不读取、不保存任何凭据 */
export interface RsiModelProviderAdapter {
  readonly providerName: string;
  readonly tier: RsiProviderTier;
  /** 缺失即视为不可证明最坏费用 → fail-closed */
  readonly pricing?: RsiProviderPricing;
  invoke(invocation: RsiModelInvocation): Promise<RsiProviderAttemptResult>;
}

/** Router 入口请求：在 `RsiModelCallRequest` 之上补齐 invocation 必需字段 */
export interface RsiModelInvocationRequest extends RsiModelCallRequest {
  promptRef: string;
  promptDigest: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export type RsiRouterRejectionReason =
  | 'INVOCATION_INVALID'
  | 'BUDGET_EXCEEDED'
  | 'BUDGET_GUARD_UNENFORCEABLE';

export interface RsiRouterOutcome {
  called: boolean;
  level: string;
  reason: string;
  record: RsiModelCallRecord | null;
  escalatedToStrong?: boolean;
  worstCaseCostUsd?: number;
  remainingUsd?: number;
}

export interface RsiBudgetGuardResult {
  ok: boolean;
  reason?: RsiRouterRejectionReason;
  worstCaseCostUsd: number | null;
  remainingUsd: number;
  maxUsdThisCall: number;
}

const round6 = (value: number): number => Number(value.toFixed(6));

/** 最坏费用估算；返回 null 表示「无法证明最坏费用」→ 必须 fail-closed */
export function estimateWorstCaseCost(
  adapter: RsiModelProviderAdapter,
  maxOutputTokens: number,
): number | null {
  const pricing = adapter.pricing;
  if (pricing === undefined || pricing === null) return null;
  const { inputUsdPerToken, outputUsdPerToken, maxInputTokens } = pricing;
  for (const value of [inputUsdPerToken, outputUsdPerToken, maxInputTokens, maxOutputTokens]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  }
  return round6(inputUsdPerToken * maxInputTokens + outputUsdPerToken * maxOutputTokens);
}

/**
 * 调用前熔断：必须证明 最坏费用 <= 剩余日/月/incident/本次调用上限，才允许调用 adapter。
 * 这里不是「先调用再看花多少」。
 */
export function checkRsiCallBudget(input: {
  adapter: RsiModelProviderAdapter;
  maxOutputTokens: number;
  maxCostThisCall: number;
  usage: RsiCostUsage;
  limits?: RsiBudgetLimits;
}): RsiBudgetGuardResult {
  const limits = input.limits ?? RSI_BUDGET_DEFAULTS;
  const remainingDay = limits.dailyBudget - input.usage.spentToday;
  const remainingMonth = limits.monthlyBudget - input.usage.spentThisMonth;
  const remainingIncident = limits.maxCostPerIncident - input.usage.incidentSpent;
  const remaining = Math.min(remainingDay, remainingMonth, remainingIncident, input.maxCostThisCall);
  const remainingUsd = round6(Math.max(0, remaining));
  const worstCase = estimateWorstCaseCost(input.adapter, input.maxOutputTokens);
  if (worstCase === null) {
    return {
      ok: false,
      reason: 'BUDGET_GUARD_UNENFORCEABLE',
      worstCaseCostUsd: null,
      remainingUsd,
      maxUsdThisCall: remainingUsd,
    };
  }
  if (worstCase > remaining) {
    return {
      ok: false,
      reason: 'BUDGET_EXCEEDED',
      worstCaseCostUsd: worstCase,
      remainingUsd,
      maxUsdThisCall: remainingUsd,
    };
  }
  return { ok: true, worstCaseCostUsd: worstCase, remainingUsd, maxUsdThisCall: remainingUsd };
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/** invocation 必需字段的运行时校验；任何缺失/非法 → 不调用 adapter */
export function isInvocationReady(request: RsiModelCallRequest): request is RsiModelInvocationRequest {
  const candidate = request as Partial<RsiModelInvocationRequest>;
  if (typeof candidate.promptRef !== 'string' || candidate.promptRef.trim() === '') return false;
  if (typeof candidate.promptDigest !== 'string' || !/^[0-9a-f]{8,64}$/i.test(candidate.promptDigest.trim())) {
    return false;
  }
  if (!isPositiveInteger(candidate.maxOutputTokens)) return false;
  if (!isPositiveInteger(candidate.timeoutMs)) return false;
  return true;
}

export function createRsiModelRouter(options: {
  lowCost: RsiModelProviderAdapter;
  strong?: RsiModelProviderAdapter;
  usage: () => RsiCostUsage;
  /** 每次调用（含失败与拒绝）都会回调；满足 ledger 的 append-only 记录要求 */
  onCall?: (record: RsiModelCallRecord) => void;
  limits?: RsiBudgetLimits;
  /** C1：有界升级上限（默认 maxAttempts=2 / maxEscalations=1；不得被调用方放大） */
  escalationLimits?: AiEscalationLimits;
  now?: () => number;
  callIdFactory?: () => string;
}): ModelRouterPort & {
  outcomeOf(request: RsiModelCallRequest | RsiModelInvocationRequest): Promise<RsiRouterOutcome>;
} {
  const limits = options.limits ?? RSI_BUDGET_DEFAULTS;
  const now = options.now ?? (() => Date.now());
  let callSequence = 0;
  const nextCallId = options.callIdFactory ?? (() => `rsi-call-${++callSequence}`);

  const emit = (record: RsiModelCallRecord): void => {
    options.onCall?.(record);
  };

  const rejectRecord = (
    adapter: RsiModelProviderAdapter,
    request: RsiModelCallRequest,
    purpose: string,
  ): RsiModelCallRecord => ({
    incidentId: request.incidentId,
    taskId: request.taskId,
    provider: adapter.providerName,
    model: 'UNRESOLVED',
    purpose,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    latencyMs: 0,
    result: 'REJECTED',
    retryCount: 0,
  });

  /** 一次 attempt：预算熔断 → 组 invocation → 调用 adapter → 记录 */
  const runAttempt = async (
    adapter: RsiModelProviderAdapter,
    request: RsiModelInvocationRequest,
    purpose: string,
    level: string,
  ): Promise<{ outcome: RsiRouterOutcome; guardRejected: boolean }> => {
    const usageBefore = options.usage();
    const guard = checkRsiCallBudget({
      adapter,
      maxOutputTokens: request.maxOutputTokens,
      maxCostThisCall: request.maxCost,
      usage: usageBefore,
      limits,
    });

    if (!guard.ok) {
      const record = rejectRecord(adapter, request, purpose);
      emit(record);
      return {
        guardRejected: true,
        outcome: {
          called: false,
          level,
          reason: guard.reason ?? 'BUDGET_GUARD_UNENFORCEABLE',
          record,
          worstCaseCostUsd: guard.worstCaseCostUsd ?? undefined,
          remainingUsd: guard.remainingUsd,
        },
      };
    }

    const invocation: RsiModelInvocation = {
      callId: nextCallId(),
      taskKind: request.taskType,
      promptRef: request.promptRef,
      promptDigest: request.promptDigest,
      tier: adapter.tier,
      timeoutMs: request.timeoutMs,
      maxOutputTokens: request.maxOutputTokens,
      budget: { remainingUsd: guard.remainingUsd, maxUsdThisCall: guard.maxUsdThisCall },
    };

    const startedAt = now();
    const attempt = await adapter.invoke(invocation);
    const latencyMs = Number.isFinite(attempt.latencyMs) ? Math.max(0, attempt.latencyMs) : now() - startedAt;
    const usage = attempt.usage;
    const record: RsiModelCallRecord = {
      incidentId: request.incidentId,
      taskId: request.taskId,
      provider: adapter.providerName,
      model: attempt.ok ? attempt.modelId : 'UNRESOLVED',
      purpose,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      estimatedCost: usage?.estimatedCost ?? 0,
      latencyMs,
      result: attempt.ok ? 'SUCCESS' : 'FAILED',
      // 一次 invoke = 一次 attempt；adapter 内部禁止重试，因此恒为 0
      retryCount: 0,
    };
    emit(record);

    return {
      guardRejected: false,
      outcome: {
        called: true,
        level,
        reason: attempt.ok ? 'CALLED' : `CALL_FAILED:${attempt.reason}`,
        record,
        worstCaseCostUsd: guard.worstCaseCostUsd ?? undefined,
        remainingUsd: guard.remainingUsd,
      },
    };
  };

  const routerApi = {
    route,
    async outcomeOf(request: RsiModelCallRequest | RsiModelInvocationRequest): Promise<RsiRouterOutcome> {
      // C1（MSG-20261005-30）：AI Necessity Gate —— 唯一咽喉，无旁路。
      // caller 仅声明 requiredCapability 不构成模型调用权；RULE_SOLVABLE / HIGH_CONFIDENCE → 禁止；
      // UNKNOWN / 无证据 → fail-closed；AMBIGUOUS / SEMANTIC_REQUIRED → 只允许 LEVEL_1。
      const necessity = evaluateAiNecessity({
        taskType: request.taskType,
        requiredCapability: request.requiredCapability,
        evidence: request.necessity ?? null,
      });
      if (necessity.decision !== 'LEVEL_1_ELIGIBLE') {
        // 与既有约定一致：确定性处理/拒绝路径不写 provider 调用记录（零 token、零成本）。
        return { called: false, level: 'LEVEL_0_RULE', reason: necessity.reason, record: null };
      }

      const decision = decideRsiModelCall({
        signalKind: request.taskType,
        requiredCapabilities: [request.requiredCapability],
        usage: options.usage(),
        limits,
      });

      // 优先级 / 预算 / 熔断：**不调用 provider**
      if (!decision.allowed) {
        return { called: false, level: decision.level, reason: decision.reason, record: null };
      }
      if (decision.level === 'LEVEL_0_RULE') {
        return { called: false, level: decision.level, reason: 'RULE_ENGINE', record: null };
      }

      // C1：gate 只放行 LEVEL_1；cost policy 声明的 LEVEL_2 在此被钳制为 LEVEL_1（strong 仅经有界升级）
      const effectiveLevel: 'LEVEL_1_LOW_COST' = 'LEVEL_1_LOW_COST';

      // invocation 必需字段缺失 → fail-closed，不调用 adapter
      if (!isInvocationReady(request)) {
        const record = rejectRecord(options.lowCost, request, 'INVOCATION');
        emit(record);
        return { called: false, level: effectiveLevel, reason: 'INVOCATION_INVALID', record };
      }

      // C1：cheap → strong 必须经过 quality gate 且有界（LLM Judge 不得授权再次调用）
      const escalationRequest = request.escalation ?? null;
      if (options.strong === undefined || escalationRequest === null) {
        return (await runAttempt(options.lowCost, request, 'LEVEL_1', effectiveLevel)).outcome;
      }
      const escalation = decideAiEscalation({
        currentTier: 'LOW_COST',
        quality: escalationRequest.quality,
        state: escalationRequest.state,
        limits: options.escalationLimits ?? AI_ESCALATION_DEFAULTS,
      });
      if (escalation.action !== 'ESCALATE_TO_STRONG') {
        // 不允许升级（含 quality=PASS / 触顶 / judge 授权被忽略）→ 只跑一次 LOW_COST，绝不调用 strong
        return (await runAttempt(options.lowCost, request, 'LEVEL_1', effectiveLevel)).outcome;
      }
      assertJudgeCannotAuthorizeModelCall({ requestedStrongCall: true, escalation });
      const second = await runAttempt(options.strong, request, 'LEVEL_2_STRONG', 'LEVEL_2_STRONG');
      return { ...second.outcome, escalatedToStrong: true };
    },
  };

  function route(request: RsiModelCallRequest): Promise<{
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
    latencyMs: number;
    retryCount: number;
  }> {
    return (async () => {
      const outcome = await routerApi.outcomeOf(request);
      if (!outcome.called || outcome.record === null) {
        throw new Error('MODEL_CALL_REJECTED:' + outcome.reason);
      }
      return {
        provider: outcome.record.provider,
        model: outcome.record.model,
        inputTokens: outcome.record.inputTokens,
        outputTokens: outcome.record.outputTokens,
        estimatedCost: outcome.record.estimatedCost,
        latencyMs: outcome.record.latencyMs,
        retryCount: outcome.record.retryCount,
      };
    })();
  }

  return routerApi as ModelRouterPort & {
    outcomeOf(request: RsiModelCallRequest | RsiModelInvocationRequest): Promise<RsiRouterOutcome>;
  };
}

export const RSI_MODEL_ROUTER_BOUNDARY = {
  holdsProviderCredentials: false,
  readsEnvironmentSecrets: false,
  providersInjectedByHost: true,
  recordsCustomerData: false,
  budgetGuardBeforeCall: true,
  recordsRejectedCalls: true,
  adapterInternalRetry: false,
  timeoutMsExplicit: true,
  realProviderNetwork: 'HOLD',
  paidModelCalls: 'HOLD',
} as const;
