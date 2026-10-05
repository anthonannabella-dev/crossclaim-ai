/**
 * RSI 本地仿真 Model Adapter（零网络 / 零费用 / 可注入）
 * ---------------------------------------------------------------
 * 裁定依据：MSG-20261005-09
 *   LOCAL_SIM_ADAPTER_IMPLEMENTATION = AUTHORIZED
 *   ROUTER_TO_SIM_ADAPTER_WIRING    = AUTHORIZED
 *   OUTPUT_SCHEMA_VALIDATION / INPUT_SENSITIVE_DATA_FILTER / OUTPUT_SENSITIVE_DATA_FILTER = REQUIRED
 *   ADAPTER_INTERNAL_RETRY = FORBIDDEN（一次 invoke = 恰好一次 attempt）
 *   REAL_MODEL_NETWORK / PAID_MODEL_CALL = HOLD
 *
 * 本适配器：
 *   · 不做任何网络调用、不读环境密钥、不持有 provider 凭据；
 *   · 按声明的计价模型做**调用前**最坏费用自检（超过本次调用上限直接 fail-closed）；
 *   · 输入侧解析不可变 prompt 并校验 promptDigest + 敏感数据扫描；
 *   · 输出侧做 schema 校验 + 敏感数据扫描，任一步失败 fail-closed；
 *   · 输出只回传 outputRef + outputDigest + usage，不回传原始 provider 响应。
 */

import { scanSensitiveData, sha256Hex } from './rsi-adapter-safety';
import type {
  RsiModelInvocation,
  RsiModelProviderAdapter,
  RsiProviderAttemptResult,
  RsiProviderFailureReason,
  RsiProviderPricing,
  RsiProviderTier,
  RsiProviderUsage,
} from './rsi-model-router';

export const RSI_LOCAL_SIM_PROVIDER_NAME = 'rsi-local-sim';
export const RSI_LOCAL_SIM_MODEL_ID = 'rsi-local-sim-v1';
export const RSI_LOCAL_SIM_MAX_OUTPUT_TOKENS = 1_024;
export const RSI_LOCAL_SIM_MAX_TASK_KIND_CHARS = 120;
export const RSI_LOCAL_SIM_MAX_SUMMARY_CHARS = 600;

/** 声明的计价模型（最坏费用 = 输入上限 + 输出上限） */
export const RSI_LOCAL_SIM_PRICING: RsiProviderPricing = {
  inputUsdPerToken: 0.000_000_5,
  outputUsdPerToken: 0.000_001_5,
  maxInputTokens: 8_000,
};

/** 仿真输出 schema（严格：只允许这三个字段） */
export interface RsiLocalSimOutput {
  kind: 'RSI_LOCAL_SIM';
  taskKind: string;
  summary: string;
}

const OUTPUT_KEYS = ['kind', 'taskKind', 'summary'] as const;

export function parseRsiLocalSimOutput(
  value: unknown,
): { ok: true; value: RsiLocalSimOutput } | { ok: false; reason: 'OUTPUT_SCHEMA_INVALID' } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'OUTPUT_SCHEMA_INVALID' };
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (keys.length !== OUTPUT_KEYS.length || keys.some((key, index) => key !== [...OUTPUT_KEYS].sort()[index])) {
    return { ok: false, reason: 'OUTPUT_SCHEMA_INVALID' };
  }
  if (row.kind !== 'RSI_LOCAL_SIM') return { ok: false, reason: 'OUTPUT_SCHEMA_INVALID' };
  if (typeof row.taskKind !== 'string' || row.taskKind.trim() === '' || row.taskKind.length > RSI_LOCAL_SIM_MAX_TASK_KIND_CHARS) {
    return { ok: false, reason: 'OUTPUT_SCHEMA_INVALID' };
  }
  if (typeof row.summary !== 'string' || row.summary.trim() === '' || row.summary.length > RSI_LOCAL_SIM_MAX_SUMMARY_CHARS) {
    return { ok: false, reason: 'OUTPUT_SCHEMA_INVALID' };
  }
  return { ok: true, value: { kind: 'RSI_LOCAL_SIM', taskKind: row.taskKind, summary: row.summary } };
}

/** 粗略 token 估算（4 字符 ≈ 1 token），只用于仿真与上限约束 */
export const estimateSimTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

export interface RsiLocalSimAdapterOptions {
  tier?: RsiProviderTier;
  /** 默认 `rsi-local-sim`；同一进程内同时挂低成本/强模型仿真时用不同名字区分 */
  providerName?: string;
  pricing?: RsiProviderPricing;
  /** 宿主提供不可变 prompt 解析；提供后启用 promptDigest 校验与输入敏感扫描 */
  resolvePrompt?: (promptRef: string) => string | undefined | Promise<string | undefined>;
  now?: () => number;
}

/** FINAL3 ③：不可伪造的运行时 provenance —— 只有本工厂创建的实例会被登记（不看 providerName） */
const LOCAL_SIM_FACTORY_INSTANCES = new WeakSet<object>();

/** 只读判定：该 adapter 是否由唯一 local-sim 工厂创建 */
export function isRsiLocalSimAdapter(adapter: unknown): boolean {
  return typeof adapter === 'object' && adapter !== null && LOCAL_SIM_FACTORY_INSTANCES.has(adapter as object);
}

export function createRsiLocalSimAdapter(options: RsiLocalSimAdapterOptions = {}): RsiModelProviderAdapter {
  const tier: RsiProviderTier = options.tier ?? 'LOW_COST';
  const providerName = options.providerName ?? RSI_LOCAL_SIM_PROVIDER_NAME;
  const pricing = options.pricing ?? RSI_LOCAL_SIM_PRICING;
  for (const value of [pricing.inputUsdPerToken, pricing.outputUsdPerToken, pricing.maxInputTokens]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error('RSI_LOCAL_SIM_PRICING_INVALID');
    }
  }
  const now = options.now ?? (() => Date.now());
  const resolvePrompt = options.resolvePrompt;

  const fail = (
    reason: RsiProviderFailureReason,
    latencyMs: number,
    usage?: RsiProviderUsage,
  ): RsiProviderAttemptResult => ({ ok: false, reason, usage, latencyMs });

  const adapter: RsiModelProviderAdapter = {
    providerName,
    tier,
    pricing,
    async invoke(invocation: RsiModelInvocation): Promise<RsiProviderAttemptResult> {
      const startedAt = now();
      const elapsed = (): number => Math.max(0, now() - startedAt);

      if (!Number.isInteger(invocation.timeoutMs) || invocation.timeoutMs <= 0) {
        return fail('TIMEOUT_MS_INVALID', elapsed());
      }
      if (!Number.isInteger(invocation.maxOutputTokens) || invocation.maxOutputTokens <= 0) {
        return fail('MAX_OUTPUT_TOKENS_INVALID', elapsed());
      }
      if (!Number.isFinite(invocation.budget.maxUsdThisCall) || invocation.budget.maxUsdThisCall < 0) {
        return fail('BUDGET_GUARD_UNENFORCEABLE', elapsed());
      }

      // 调用前自检：本次最坏费用必须落在本次调用上限内，否则 fail-closed（不发请求）
      const worstCase = pricing.inputUsdPerToken * pricing.maxInputTokens +
        pricing.outputUsdPerToken * invocation.maxOutputTokens;
      if (worstCase > invocation.budget.maxUsdThisCall) {
        return fail('BUDGET_GUARD_UNENFORCEABLE', elapsed());
      }

      // 输入侧：解析不可变 prompt（若宿主提供）→ digest 校验 → 敏感数据扫描
      let promptText: string | null = null;
      if (resolvePrompt !== undefined) {
        const resolved = await resolvePrompt(invocation.promptRef);
        if (typeof resolved !== 'string' || resolved.trim() === '') {
          return fail('INPUT_SCHEMA_INVALID', elapsed());
        }
        if (sha256Hex(resolved) !== invocation.promptDigest.trim().toLowerCase()) {
          return fail('INPUT_SCHEMA_INVALID', elapsed());
        }
        if (!scanSensitiveData(resolved).clean) {
          return fail('INPUT_SENSITIVE_DATA_DETECTED', elapsed());
        }
        promptText = resolved;
      }

      // 输出侧：确定性生成 → schema 校验 → 敏感数据扫描
      const effectiveMaxOutputTokens = Math.min(invocation.maxOutputTokens, RSI_LOCAL_SIM_MAX_OUTPUT_TOKENS);
      const maxSummaryChars = Math.max(0, effectiveMaxOutputTokens * 4 - 64);
      const output: RsiLocalSimOutput = {
        kind: 'RSI_LOCAL_SIM',
        taskKind: invocation.taskKind.slice(0, RSI_LOCAL_SIM_MAX_TASK_KIND_CHARS),
        summary: `local simulation for ${invocation.taskKind} at ${tier} tier`.slice(0, Math.max(1, maxSummaryChars)),
      };
      let outputText = JSON.stringify(output);
      if (estimateSimTokens(outputText) > effectiveMaxOutputTokens) {
        const excessChars = (estimateSimTokens(outputText) - effectiveMaxOutputTokens) * 4;
        const trimmed = output.summary.slice(0, Math.max(0, output.summary.length - excessChars));
        if (trimmed.trim() === '') return fail('MAX_OUTPUT_TOKENS_INVALID', elapsed());
        output.summary = trimmed;
        outputText = JSON.stringify(output);
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(outputText) as unknown;
      } catch {
        return fail('OUTPUT_SCHEMA_INVALID', elapsed());
      }
      const validated = parseRsiLocalSimOutput(decoded);
      if (!validated.ok) return fail('OUTPUT_SCHEMA_INVALID', elapsed());
      if (!scanSensitiveData(outputText).clean) return fail('OUTPUT_SENSITIVE_DATA_DETECTED', elapsed());

      const inputTokens = Math.min(pricing.maxInputTokens, estimateSimTokens(promptText ?? invocation.promptRef));
      const outputTokens = estimateSimTokens(outputText);
      const usage: RsiProviderUsage = {
        inputTokens,
        outputTokens,
        estimatedCost: Number(
          (inputTokens * pricing.inputUsdPerToken + outputTokens * pricing.outputUsdPerToken).toFixed(6),
        ),
      };
      if (usage.estimatedCost > invocation.budget.maxUsdThisCall) {
        return fail('BUDGET_GUARD_UNENFORCEABLE', elapsed(), usage);
      }

      const outputDigest = sha256Hex(outputText);
      return {
        ok: true,
        modelId: RSI_LOCAL_SIM_MODEL_ID,
        outputRef: `sim:${outputDigest.slice(0, 16)}`,
        outputDigest,
        usage,
        latencyMs: elapsed(),
      };
    },
  };
  LOCAL_SIM_FACTORY_INSTANCES.add(adapter as unknown as object);
  return adapter;
}

export const RSI_LOCAL_SIM_ADAPTER_BOUNDARY = {
  performsNetworkCalls: false,
  holdsProviderCredentials: false,
  readsEnvironmentSecrets: false,
  internalRetry: false,
  sdkAutoRetry: false,
  externalWrite: false,
  payment: false,
  transport: false,
  persistsRawProviderResponse: false,
  inputFilter: 'REQUIRED',
  outputFilter: 'REQUIRED',
  budgetGuardBeforeCall: true,
} as const;

/**
 * FINAL4：受控 **test-mode factory** —— 供测试构造确定性失败/成功探针；
 * 其返回的实例同样登记进 WeakSet provenance，因此不构成 caller 自报 capability 的旁路。
 */
export function createRsiLocalSimTestAdapter(options: {
  tier: RsiProviderTier;
  providerName: string;
  behavior?: 'SUCCESS' | 'FAIL';
}): RsiModelProviderAdapter {
  const behavior = options.behavior ?? 'SUCCESS';
  const adapter: RsiModelProviderAdapter = {
    providerName: options.providerName,
    tier: options.tier,
    pricing: RSI_LOCAL_SIM_PRICING,
    async invoke(): Promise<RsiProviderAttemptResult> {
      if (behavior === 'FAIL') {
        return { ok: false, reason: 'PROVIDER_FAILED', usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 }, latencyMs: 1 };
      }
      return {
        ok: true,
        modelId: 'rsi-local-sim-test-model',
        outputRef: 'sim:test',
        outputDigest: 'd'.repeat(64),
        usage: { inputTokens: 10, outputTokens: 5, estimatedCost: 0.001 },
        latencyMs: 1,
      };
    },
  };
  LOCAL_SIM_FACTORY_INSTANCES.add(adapter as unknown as object);
  return adapter;
}
