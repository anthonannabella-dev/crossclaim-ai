/**
 * RSI Admin 快照生成器（RSI-RT-09）
 * ---------------------------------------------------------------
 * 把控制器健康态 + 成本台账汇总写成 `rsi-admin-snapshot-v1` artifact，供 /admin/autonomy 只读展示。
 *
 * 硬规则：
 *   · artifact 只含白名单字段（健康计数 + 台账聚合 + costSafeMode），**不含凭据/客户数据/任务明细**；
 *   · 由台账 `snapshot()` 提供 today/month 聚合，不自行重算；
 *   · 纯函数：写文件由调用方完成（宿主决定落盘位置）。
 */

import type { RsiCostLedger, RsiCostSnapshot } from '../services/autonomy/rsi-cost-ledger';
import { isCostSafeMode, RSI_BUDGET_DEFAULTS, type RsiCostUsage } from '../services/autonomy/rsi-cost-policy';
import type { RsiHealthState } from '../services/autonomy/rsi-runtime-config';

export const RSI_ADMIN_SNAPSHOT_SCHEMA = 'rsi-admin-snapshot-v1' as const;

export interface RsiAdminHealth {
  health: RsiHealthState;
  openIncidents: number;
  activeTasks: number;
  failedTasks: number;
  pendingOwnerApprovals: number;
  lastScanAt: string | null;
}

export interface RsiAdminSnapshot {
  schema: typeof RSI_ADMIN_SNAPSHOT_SCHEMA;
  generatedAt: string;
  health: RsiAdminHealth;
  cost: {
    costSafeMode: boolean;
    today: Omit<RsiCostSnapshot['today'], never>;
    month: Omit<RsiCostSnapshot['month'], never>;
  };
}

const FORBIDDEN_KEYS = /^(api_?key|api_?secret|secret|credential|credentials|password|access_?token|refresh_?token)$/i;

const hasForbiddenField = (value: unknown, depth = 0): boolean => {
  if (depth > 4 || value === null || typeof value !== 'object') return false;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.test(key)) return true;
    if (hasForbiddenField(nested, depth + 1)) return true;
  }
  return false;
};

/** 由「健康态 + 台账」生成快照；用量用于判定 costSafeMode。 */
export function buildAdminSnapshot(input: {
  health: RsiAdminHealth;
  ledger: RsiCostLedger;
  usage: RsiCostUsage;
  now?: Date;
}): RsiAdminSnapshot {
  const now = input.now ?? new Date();
  const aggregate = input.ledger.snapshot();
  const snapshot: RsiAdminSnapshot = {
    schema: RSI_ADMIN_SNAPSHOT_SCHEMA,
    generatedAt: now.toISOString(),
    health: input.health,
    cost: {
      costSafeMode: isCostSafeMode(input.usage, RSI_BUDGET_DEFAULTS),
      today: aggregate.today,
      month: aggregate.month,
    },
  };
  if (hasForbiddenField(snapshot)) throw new Error('ADMIN_SNAPSHOT_FORBIDDEN_FIELD');
  return snapshot;
}

export const RSI_ADMIN_SNAPSHOT_BOUNDARY = {
  whitelistedFieldsOnly: true,
  includesTaskDetail: false,
  recordsCustomerData: false,
  readsCredentials: false,
  writesDatabase: false,
} as const;
