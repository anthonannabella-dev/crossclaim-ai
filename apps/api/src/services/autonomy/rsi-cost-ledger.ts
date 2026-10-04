/**
 * RSI 调用台账（RSI-COST-03）
 * ---------------------------------------------------------------
 * 目的：为 /admin/autonomy 成本面板与预算判定提供**可审计、只追加**的调用记录与汇总。
 *
 * 硬规则：
 *   · append-only：同一 entryId 只能写一次，重写被拒（EVIDENCE_IMMUTABLE）；
 *   · 禁止 secret / credential / 原始敏感客户数据：任何含 apiKey/secret/token/credential 字段的记录一律拒收；
 *   · 汇总区分今天与本月：events / incidents / rule-resolved / low-cost calls / strong calls / tokens / cost / budget remaining；
 *   · 纯内存实现 + 可注入 sink（宿主可接 DB，DB 持久化属 Schema Delta）。
 */

import { RSI_BUDGET_DEFAULTS, type RsiBudgetLimits, type RsiModelCallRecord } from './rsi-cost-policy';

export interface RsiCostLedgerEntry extends RsiModelCallRecord {
  entryId: string;
  /** ISO 时间戳（调用发生时间）。 */
  at: string;
  /** 该次调用归属的执行等级。 */
  level: 'LEVEL_1_LOW_COST' | 'LEVEL_2_STRONG';
}

export interface RsiCostAggregate {
  events: number;
  incidents: number;
  ruleResolved: number;
  lowCostCalls: number;
  strongCalls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  budgetRemaining: number;
}

export interface RsiCostSnapshot {
  today: RsiCostAggregate;
  month: RsiCostAggregate;
  entries: number;
}

// 注意：不能匹配 inputTokens / outputTokens 这类**计量**字段，只拦真正的凭据字段。
const FORBIDDEN_KEYS = /^(api_?key|api_?secret|secret|client_?secret|credential|credentials|password|passwd|access_?token|refresh_?token|bearer_?token|auth_?token)$/i;

const hasForbiddenField = (value: unknown, depth = 0): boolean => {
  if (depth > 4 || value === null || typeof value !== 'object') return false;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.test(key)) return true;
    if (hasForbiddenField(nested, depth + 1)) return true;
  }
  return false;
};

const emptyAggregate = (budget: number): RsiCostAggregate => ({
  events: 0,
  incidents: 0,
  ruleResolved: 0,
  lowCostCalls: 0,
  strongCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  budgetRemaining: budget,
});

export interface RsiCostLedger {
  record(entry: RsiCostLedgerEntry): { ok: true; entryId: string } | { ok: false; reason: 'EVIDENCE_IMMUTABLE' | 'FORBIDDEN_FIELD' };
  /** 规则引擎解决的事件（不产生 token 成本，但需要计入 events / ruleResolved）。 */
  recordRuleResolved(input: { entryId: string; at: string; incidentId: string | null }): { ok: boolean; reason?: string };
  snapshot(): RsiCostSnapshot;
}

export function createRsiCostLedger(options: {
  limits?: RsiBudgetLimits;
  sink?: (entry: RsiCostLedgerEntry) => void;
} = {}): RsiCostLedger {
  const limits = options.limits ?? RSI_BUDGET_DEFAULTS;
  const entries: RsiCostLedgerEntry[] = [];
  const ruleEvents: { entryId: string; at: string; incidentId: string | null }[] = [];
  const seen = new Set<string>();

  const aggregate = (prefix: string, budget: number): RsiCostAggregate => {
    const inWindow = entries.filter((entry) => entry.at.startsWith(prefix));
    const rulesInWindow = ruleEvents.filter((event) => event.at.startsWith(prefix));
    const agg = emptyAggregate(budget);
    agg.events = inWindow.length + rulesInWindow.length;
    agg.ruleResolved = rulesInWindow.length;
    agg.incidents = new Set([
      ...inWindow.map((entry) => entry.incidentId).filter((id): id is string => id !== null),
      ...rulesInWindow.map((event) => event.incidentId).filter((id): id is string => id !== null),
    ]).size;
    agg.lowCostCalls = inWindow.filter((entry) => entry.level === 'LEVEL_1_LOW_COST').length;
    agg.strongCalls = inWindow.filter((entry) => entry.level === 'LEVEL_2_STRONG').length;
    agg.inputTokens = inWindow.reduce((sum, entry) => sum + entry.inputTokens, 0);
    agg.outputTokens = inWindow.reduce((sum, entry) => sum + entry.outputTokens, 0);
    agg.cost = Number(inWindow.reduce((sum, entry) => sum + entry.estimatedCost, 0).toFixed(6));
    agg.budgetRemaining = Number(Math.max(0, budget - agg.cost).toFixed(6));
    return agg;
  };

  return {
    record(entry) {
      if (seen.has(entry.entryId)) return { ok: false, reason: 'EVIDENCE_IMMUTABLE' };
      if (hasForbiddenField(entry)) return { ok: false, reason: 'FORBIDDEN_FIELD' };
      seen.add(entry.entryId);
      entries.push(entry);
      options.sink?.(entry);
      return { ok: true, entryId: entry.entryId };
    },
    recordRuleResolved(input) {
      if (seen.has(input.entryId)) return { ok: false, reason: 'EVIDENCE_IMMUTABLE' };
      seen.add(input.entryId);
      ruleEvents.push({ entryId: input.entryId, at: input.at, incidentId: input.incidentId });
      return { ok: true };
    },
    snapshot() {
      const now = new Date();
      const todayPrefix = now.toISOString().slice(0, 10);
      const monthPrefix = now.toISOString().slice(0, 7);
      return {
        today: aggregate(todayPrefix, limits.dailyBudget),
        month: aggregate(monthPrefix, limits.monthlyBudget),
        entries: entries.length + ruleEvents.length,
      };
    },
  };
}

export const RSI_COST_LEDGER_BOUNDARY = {
  appendOnly: true,
  rejectsSecretFields: true,
  recordsCustomerData: false,
  persistsToDatabase: false,
} as const;
