/** Admin 快照生成器验收：schema、台账聚合、costSafeMode、无凭据字段。 */

import { describe, expect, it } from 'vitest';

import { RSI_ADMIN_SNAPSHOT_BOUNDARY, RSI_ADMIN_SNAPSHOT_SCHEMA, buildAdminSnapshot } from '../runtime/rsi-admin-snapshot';
import { createRsiCostLedger } from '../services/autonomy/rsi-cost-ledger';
import type { RsiCostUsage } from '../services/autonomy/rsi-cost-policy';

const usage = (over: Partial<RsiCostUsage> = {}): RsiCostUsage => ({
  spentToday: 0,
  spentThisMonth: 0,
  incidentSpent: 0,
  incidentAttempts: 0,
  incidentCandidates: 0,
  incidentLlmCalls: 0,
  incidentTokens: 0,
  incidentElapsedMinutes: 0,
  strongCallsForTask: 0,
  ...over,
});

const health = {
  health: 'HEALTHY' as const,
  openIncidents: 1,
  activeTasks: 2,
  failedTasks: 0,
  pendingOwnerApprovals: 1,
  lastScanAt: '2026-10-05T02:00:00.000Z',
};

describe('RSI Admin 快照', () => {
  it('RSI_SNAPSHOT_SCHEMA_AND_AGGREGATES：schema 固定，today/month 直接取自台账', () => {
    const ledger = createRsiCostLedger();
    ledger.record({
      entryId: 'e1',
      at: new Date().toISOString(),
      level: 'LEVEL_1_LOW_COST',
      incidentId: 'inc-1',
      taskId: 'task-1',
      provider: 'provider-lowcost',
      model: 'lowcost-model',
      purpose: 'LEVEL_1',
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.002,
      latencyMs: 120,
      result: 'SUCCESS',
      retryCount: 0,
    });
    ledger.recordRuleResolved({ entryId: 'r1', at: new Date().toISOString(), incidentId: 'inc-2' });

    const snapshot = buildAdminSnapshot({ health, ledger, usage: usage() });
    expect(snapshot.schema).toBe(RSI_ADMIN_SNAPSHOT_SCHEMA);
    expect(snapshot.health).toEqual(health);
    expect(snapshot.cost.today.lowCostCalls).toBe(1);
    expect(snapshot.cost.today.ruleResolved).toBe(1);
    expect(snapshot.cost.today.cost).toBeCloseTo(0.002, 6);
    expect(snapshot.cost.month.cost).toBeGreaterThanOrEqual(snapshot.cost.today.cost);
  });

  it('RSI_SNAPSHOT_COST_SAFE_MODE_FLAG：预算耗尽时快照标记 costSafeMode', () => {
    const ledger = createRsiCostLedger();
    expect(buildAdminSnapshot({ health, ledger, usage: usage() }).cost.costSafeMode).toBe(false);
    expect(buildAdminSnapshot({ health, ledger, usage: usage({ spentToday: 999 }) }).cost.costSafeMode).toBe(true);
  });

  it('RSI_SNAPSHOT_WHITELIST_NO_SECRETS：白名单边界（无任务明细、无客户数据、无凭据）', () => {
    const ledger = createRsiCostLedger();
    const snapshot = buildAdminSnapshot({ health, ledger, usage: usage() });
    const keys = Object.keys(snapshot);
    expect(keys.sort()).toEqual(['cost', 'generatedAt', 'health', 'schema']);
    expect(JSON.stringify(snapshot)).not.toMatch(/apiKey|secret|credential|customerEmail/i);
    expect(RSI_ADMIN_SNAPSHOT_BOUNDARY.whitelistedFieldsOnly).toBe(true);
    expect(RSI_ADMIN_SNAPSHOT_BOUNDARY.includesTaskDetail).toBe(false);
    expect(RSI_ADMIN_SNAPSHOT_BOUNDARY.recordsCustomerData).toBe(false);
    expect(RSI_ADMIN_SNAPSHOT_BOUNDARY.writesDatabase).toBe(false);
  });
});
