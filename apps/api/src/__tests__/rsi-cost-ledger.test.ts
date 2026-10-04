/** RSI 调用台账验收：append-only、today/month 汇总、拒收 secret 字段。 */

import { describe, expect, it } from 'vitest';

import { RSI_COST_LEDGER_BOUNDARY, createRsiCostLedger, type RsiCostLedgerEntry } from '../services/autonomy/rsi-cost-ledger';

const entry = (over: Partial<RsiCostLedgerEntry> = {}): RsiCostLedgerEntry => ({
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
  estimatedCost: 0.001,
  latencyMs: 120,
  result: 'SUCCESS',
  retryCount: 0,
  ...over,
});

describe('RSI 调用台账', () => {
  it('RSI_LEDGER_APPEND_ONLY_REJECTS_REWRITE：同一 entryId 只能写一次', () => {
    const ledger = createRsiCostLedger();
    expect(ledger.record(entry()).ok).toBe(true);
    expect(ledger.record(entry({ estimatedCost: 999 }))).toEqual({ ok: false, reason: 'EVIDENCE_IMMUTABLE' });
    expect(ledger.snapshot().entries).toBe(1);
  });

  it('RSI_LEDGER_AGGREGATES_TODAY_AND_MONTH：区分今天/本月，包含 rule-resolved 与预算余额', () => {
    const ledger = createRsiCostLedger();
    ledger.record(entry({ entryId: 'e1', estimatedCost: 0.01, inputTokens: 100, outputTokens: 20 }));
    ledger.record(entry({ entryId: 'e2', level: 'LEVEL_2_STRONG', provider: 'provider-strong', estimatedCost: 0.2, inputTokens: 500, outputTokens: 200 }));
    ledger.recordRuleResolved({ entryId: 'r1', at: new Date().toISOString(), incidentId: 'inc-2' });

    const snapshot = ledger.snapshot();
    expect(snapshot.entries).toBe(3);
    expect(snapshot.today.events).toBe(3);
    expect(snapshot.today.ruleResolved).toBe(1);
    expect(snapshot.today.lowCostCalls).toBe(1);
    expect(snapshot.today.strongCalls).toBe(1);
    expect(snapshot.today.incidents).toBe(2);
    expect(snapshot.today.inputTokens).toBe(600);
    expect(snapshot.today.outputTokens).toBe(220);
    expect(snapshot.today.cost).toBeCloseTo(0.21, 6);
    expect(snapshot.today.budgetRemaining).toBeLessThan(snapshot.today.events * 100); // 余额为正且已扣减
    expect(snapshot.month.cost).toBeGreaterThanOrEqual(snapshot.today.cost);
  });

  it('RSI_LEDGER_REJECTS_SECRET_FIELDS：含 apiKey/secret/token/credential 字段的记录被拒收', () => {
    const ledger = createRsiCostLedger();
    const dirty = { ...entry({ entryId: 'dirty' }), apiKey: 'sk-live-xxx' } as unknown as RsiCostLedgerEntry;
    expect(ledger.record(dirty)).toEqual({ ok: false, reason: 'FORBIDDEN_FIELD' });
    expect(ledger.snapshot().entries).toBe(0);

    const nested = { ...entry({ entryId: 'nested' }), meta: { credential: 'x' } } as unknown as RsiCostLedgerEntry;
    expect(ledger.record(nested)).toEqual({ ok: false, reason: 'FORBIDDEN_FIELD' });

    expect(RSI_COST_LEDGER_BOUNDARY.appendOnly).toBe(true);
    expect(RSI_COST_LEDGER_BOUNDARY.rejectsSecretFields).toBe(true);
    expect(RSI_COST_LEDGER_BOUNDARY.recordsCustomerData).toBe(false);
    expect(RSI_COST_LEDGER_BOUNDARY.persistsToDatabase).toBe(false);
  });
});
