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
  assertJudgeCannotAuthorizeModelCall,
  clampAiEscalationLimits,
  decideAiEscalation,
  type AiEscalationLimits,
  type AiQualityVerdict,
} from './rsi-model-escalation-policy';
import type { AiModelCacheScope } from './si-model-cache-runtime';

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
  /**
   * C3：tenant-safe cache identity（host 计算；tenant-safe 判定复用 C1 identity 契约）。
   * 缺省 / null ⇒ 不查缓存（行为与 C1/C2 完全一致）；identity 非法 ⇒ fail-closed（不降级放行 provider）。
   */
  cacheScope?: AiModelCacheScope | null;
}

/**
 * C3 —— cache runtime 端口（host 注入；Router 不直接持有 Prisma / 不读环境变量）。
 * HIT 只返回判定与 savings；**绝不**因此产生 provider ledger entry。
 */
/** C3 FINAL-3：Safe Mode 准入结果（durable resolver 也可异步提供） */
export interface RsiCostSafeModeAdmission {
  standardAiAllowed: boolean;
  state: string;
  reason: string;
}
/** C3 FINAL-3：Safe Mode port（支持 async —— host 在 provider 调用前读取 durable policy + ledger） */
export type RsiCostSafeModePort = (
  input: { channel: 'STANDARD_AI' },
) => RsiCostSafeModeAdmission | Promise<RsiCostSafeModeAdmission>;

export interface RsiModelCachePort {
  lookup(input: { scope: AiModelCacheScope; highRisk?: boolean }): Promise<
    | {
        hit: true;
        reason: 'HIT';
        resultDigest: string;
        savedTokens: number | null;
        savedCostMicros: number | null;
        savingsSource: string;
      }
    | { hit: false; reason: string }
  >;
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
  /** C3：cache 命中 ⇒ MODEL_CALL = SKIPPED（called=false，无 provider 调用） */
  cacheHit?: boolean;
  savedTokens?: number | null;
  savedCostMicros?: number | null;
  savingsSource?: string;
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
  /**
   * C1 FINAL-2（CHANGE A）：**server-side deterministic quality evaluator**。
   * strong 升级授权只能来自：preceding LOW_COST attempt + 本 evaluator 的确定性结论；
   * 未配置 → 无法证明质量 → 不升级（strong = 0）。caller 自报 quality/state 一律被忽略。
   */
  qualityEvaluator?: (input: {
    taskType: string;
    tier: RsiProviderTier;
    attempt: RsiProviderAttemptResult;
  }) => AiQualityVerdict;
  /**
   * C3：Cost Safe Mode 准入（host 注入；阈值来自 durable policy、用量来自 durable ledger）。
   * 缺省不启用 ⇒ 行为与 C1/C2 完全一致。SAFE MODE 只停 STANDARD_AI；L0 / health / critical alert 豁免。
   */
  costSafeMode?: RsiCostSafeModePort;
  /**
   * C3：business-value cost policy（host 注入）。价值只能来自可信 canonical / recovery basis；
   * caller 自报价值一律被忽略，且不得据此提高模型等级或预算。
   */
  businessValue?: (input: { taskType: string; requestedTier: RsiProviderTier }) => {
    allowed: boolean;
    maxTier: RsiProviderTier;
    reason: string;
  };
  /** C3：cache runtime（tenant-safe identity；HIT ⇒ MODEL_CALL = SKIPPED，不产生 provider ledger entry） */
  cache?: RsiModelCachePort;
  /** C3：cache 命中时登记 savings（真实口径由 host 提供；不可测 → NOT_YET_MEASURABLE） */
  onCacheSavings?: (savings: {
    taskType: string;
    incidentId: string | null;
    taskId: string | null;
    savedTokens: number | null;
    savedCostMicros: number | null;
    savingsSource: string;
    resultDigest: string;
  }) => void;
  /** C3：并发槽闸门（host 注入 PostgreSQL advisory-lock slots；多实例互斥；缺省不启用） */
  concurrency?: <T>(run: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false; reason: string }>;
  now?: () => number;
  callIdFactory?: () => string;
}): ModelRouterPort & {
  outcomeOf(request: RsiModelCallRequest | RsiModelInvocationRequest): Promise<RsiRouterOutcome>;
} {
  const limits = options.limits ?? RSI_BUDGET_DEFAULTS;
  const now = options.now ?? (() => Date.now());
  let callSequence = 0;
  /**
   * C1 FINAL-2：per-task 内部升级状态（Gateway 自己维护，caller 不可注入）。
   * 保证：无 preceding LOW_COST attempt 不升级；触顶后不再调用 provider（无递归、无 retry storm）。
   */
  const taskState = new Map<string, { attempts: number; escalations: number; strongFailed: boolean }>();
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
  ): Promise<{ outcome: RsiRouterOutcome; guardRejected: boolean; attempt: RsiProviderAttemptResult | null }> => {
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
        attempt: null,
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
      attempt,
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

  /**
   * C3：把**单次** provider attempt 放进并发槽（多实例互斥）。
   * 占不到 slot ⇒ 视为 guard rejection：零 provider 调用、零 ledger 事实、不计 attempt（无重试风暴）。
   */
  const guardedAttempt = async (
    run: () => Promise<{ outcome: RsiRouterOutcome; guardRejected: boolean; attempt: RsiProviderAttemptResult | null }>,
    level: string,
  ): Promise<{ outcome: RsiRouterOutcome; guardRejected: boolean; attempt: RsiProviderAttemptResult | null }> => {
    if (!options.concurrency) return run();
    const gate = await options.concurrency(run);
    if (gate.ok) return gate.value;
    return {
      guardRejected: true,
      attempt: null,
      outcome: { called: false, level, reason: gate.reason, record: null },
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

      // C3①：Cost Safe Mode 准入（只停 STANDARD_AI；L0 / health / critical alert 由调用方豁免通道放行）
      if (options.costSafeMode) {
        // C3 FINAL-3 CHANGE A：port 支持 async（host 在调用前读取 durable policy + ledger）
        const admission = await options.costSafeMode({ channel: 'STANDARD_AI' });
        if (!admission.standardAiAllowed) {
          return { called: false, level: effectiveLevel, reason: admission.reason, record: null };
        }
      }

      // C3②：Deterministic model cache（tenant-safe identity）—— HIT ⇒ MODEL_CALL = SKIPPED
      // 不产生假 provider ledger entry；savings 交由 host 显式登记（无估算器 ⇒ NOT_YET_MEASURABLE）
      if (options.cache && request.cacheScope) {
        let lookup: Awaited<ReturnType<RsiModelCachePort['lookup']>>;
        try {
          lookup = await options.cache.lookup({
            scope: request.cacheScope,
            highRisk: request.complexity === 'HIGH',
          });
        } catch (error) {
          // identity / tenant 非法 ⇒ fail-closed（绝不降级为「miss 后放行 provider」）
          return {
            called: false,
            level: effectiveLevel,
            reason: 'AI_MODEL_CACHE_LOOKUP_FAIL_CLOSED:' + (error instanceof Error ? error.message : String(error)),
            record: null,
          };
        }
        if (lookup.hit) {
          options.onCacheSavings?.({
            taskType: request.taskType,
            incidentId: request.incidentId,
            taskId: request.taskId,
            savedTokens: lookup.savedTokens,
            savedCostMicros: lookup.savedCostMicros,
            savingsSource: lookup.savingsSource,
            resultDigest: lookup.resultDigest,
          });
          return {
            called: false,
            level: effectiveLevel,
            reason: 'MODEL_CALL_SKIPPED_CACHE_HIT',
            record: null,
            cacheHit: true,
            savedTokens: lookup.savedTokens,
            savedCostMicros: lookup.savedCostMicros,
            savingsSource: lookup.savingsSource,
          };
        }
      }

      // C3③：Business-value cost policy（caller 不得提高等级 / 预算；价值只来自可信 basis）
      if (options.businessValue) {
        const value = options.businessValue({ taskType: request.taskType, requestedTier: 'LOW_COST' });
        if (!value.allowed) {
          return { called: false, level: effectiveLevel, reason: value.reason, record: null };
        }
      }

      // C1 FINAL-2（CHANGE A）：strong 授权只能来自「preceding LOW_COST attempt + server-side
      // deterministic quality evaluator」。caller 自报 escalation.quality/state 一律被忽略。
      const { effective: escalationLimits } = clampAiEscalationLimits(options.escalationLimits ?? null);
      // C1 FINAL-3 CHANGE A：AI-eligible 调用必须有**稳定、不可伪造**的 per-task 身份。
      // 缺少 taskId（或为空）→ fail-closed，绝不落入共享 fallback key；
      // 同时把 taskType + promptDigest 纳入 key，避免同一 taskId 复用不同任务时状态串扰。
      const taskId = typeof request.taskId === 'string' ? request.taskId.trim() : '';
      if (taskId === '') {
        return { called: false, level: effectiveLevel, reason: 'AI_ESCALATION_TASK_IDENTITY_REQUIRED', record: null };
      }
      const taskKey =
        (request.incidentId ?? '-') + '::' + taskId + '::' + request.taskType + '::' + request.promptDigest;
      const state = taskState.get(taskKey) ?? { attempts: 0, escalations: 0, strongFailed: false };
      if (state.strongFailed) {
        return { called: false, level: 'LEVEL_2_STRONG', reason: 'AI_ESCALATION_STOP_FAILED', record: null };
      }
      if (state.attempts >= escalationLimits.maxAttempts) {
        return { called: false, level: effectiveLevel, reason: 'AI_ESCALATION_MAX_ATTEMPTS', record: null };
      }

      // ① 先跑 LOW_COST（cheap 前置 attempt 由 Gateway 自己产生，不接受 caller 声明）
      const first = await guardedAttempt(
        () => runAttempt(options.lowCost, request, 'LEVEL_1', effectiveLevel),
        effectiveLevel,
      );
      // C1 FINAL-3 CHANGE B：attempts 只统计**真实 provider attempt**（budget guard 拒绝不算）
      const cheapProviderAttempt = !first.guardRejected && first.attempt !== null && first.outcome.called === true;
      if (cheapProviderAttempt) {
        state.attempts += 1;
        taskState.set(taskKey, state);
      }

      if (options.strong === undefined || first.guardRejected) {
        return first.outcome;
      }

      // ② 质量结论只能来自 server-side deterministic evaluator；未配置 → 无法证明 → 不升级
      const cheapSucceeded = first.outcome.record?.result === 'SUCCESS';
      let quality: AiQualityVerdict | null = null;
      if (!cheapSucceeded) {
        // provider 失败 → 无可用输出，确定性判定为 FAIL（可进入一次有界升级）
        quality = 'FAIL';
      } else if (options.qualityEvaluator && first.attempt) {
        quality = options.qualityEvaluator({ taskType: request.taskType, tier: 'LOW_COST', attempt: first.attempt });
      }
      if (quality === null) {
        return first.outcome;
      }

      const escalation = decideAiEscalation({
        currentTier: 'LOW_COST',
        quality,
        state: { attempts: state.attempts, escalations: state.escalations },
        limits: escalationLimits,
      });
      if (escalation.action !== 'ESCALATE_TO_STRONG') {
        return first.outcome;
      }
      // C3 FINAL-2 CHANGE A：STRONG 升级必须**再过一道** business-value gate
      // （价值 + canonical 风险；两道 gate 都允许才可 strong；否则保持 first.outcome，strong = 0）
      if (options.businessValue) {
        const strongValue = options.businessValue({ taskType: request.taskType, requestedTier: 'STRONG' });
        if (!strongValue.allowed || strongValue.maxTier !== 'STRONG') {
          return first.outcome;
        }
      }
      assertJudgeCannotAuthorizeModelCall({ requestedStrongCall: true, escalation });
      const second = await guardedAttempt(
        () => runAttempt(options.strong as RsiModelProviderAdapter, request, 'LEVEL_2_STRONG', 'LEVEL_2_STRONG'),
        'LEVEL_2_STRONG',
      );
      // strong attempt 同样计入 attempts（attempts = 真实 provider attempt 数）
      const strongProviderAttempt = !second.guardRejected && second.attempt !== null && second.outcome.called === true;
      if (strongProviderAttempt) {
        state.attempts += 1;
        state.escalations += 1;
        if (second.outcome.record?.result !== 'SUCCESS') {
          state.strongFailed = true;
        }
        taskState.set(taskKey, state);
      }
      // telemetry（MSG-20261005-33 非阻断注意项）：只有 strong **真实 invoke** 时才标记 escalatedToStrong
      return strongProviderAttempt ? { ...second.outcome, escalatedToStrong: true } : second.outcome;
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
  /** C3：cache runtime（HIT ⇒ MODEL_CALL = SKIPPED；不产生 provider ledger entry） */
  cacheRuntimeWiring: 'OPTIONAL_PORT（缺省不启用；HIT 不写 provider ledger entry）',
  /** C3：Cost Safe Mode（只停 STANDARD_AI；L0 / health / critical alert 豁免；无重试风暴） */
  costSafeMode: 'OPTIONAL_PORT（缺省不启用；SAFE MODE 下拒绝为终局，retryAllowed=false）',
  /** C3：业务价值等级只来自可信 canonical basis（caller 自报值一律忽略） */
  businessValuePolicy: 'OPTIONAL_PORT（caller 不得提高等级 / 预算；STRONG 升级需再过一道 gate）',
  /** C3：并发槽（host 注入 PostgreSQL advisory-lock slots；多实例互斥） */
  concurrencySlots: 'OPTIONAL_PORT（缺省不启用；跨实例互斥，非进程内计数）',
} as const;
