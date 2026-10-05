/** RSI-P1-03 验收：signal → incident → task 生成、去重、OWNER 保护、限流、与续跑引擎联通 */

import { describe, expect, it } from 'vitest';

import { createRsiContinuationEngine } from '../services/autonomy/rsi-continuation-engine';
import type { RsiSignal } from '../services/autonomy/rsi-observer';
import {
  RSI_GENERATION_HARD_CAP_PER_CYCLE,
  RSI_TASK_GENERATOR_BOUNDARY,
  generateRsiWork,
  parseRsiSignals,
} from '../services/autonomy/rsi-task-generator';

const signal = (over: Partial<RsiSignal> = {}): RsiSignal => ({
  kind: 'CI_FAIL',
  dedupeKey: 'CI_FAIL:head-aaa:run-1',
  summary: 'CI failed on head-aaa (run 1)',
  refs: ['run:1', 'head:head-aaa'],
  riskClass: 'MEDIUM',
  ...over,
});

describe('RSI task generator', () => {
  it('RSI_GEN_SIGNAL_BECOMES_INCIDENT_AND_TASK：一个新信号 → 一条 incident + 一条可自动执行任务', () => {
    const result = generateRsiWork({ signals: [signal()] });
    expect(result.incidents).toHaveLength(1);
    expect(result.tasks).toHaveLength(1);
    expect(result.ownerGatedTasks).toEqual([]);
    expect(result.truncated).toBe(false);
    const task = result.tasks[0]!;
    expect(task.priority).toBe('P1');
    expect(task.ownerGateRequired).toBe(false);
    expect(task.incidentId).toBe(result.incidents[0]!.incidentId);
    expect(task.dedupeKey).toBe('task:CI_FAIL:head-aaa:run-1');
    expect(result.incidents[0]!.dedupeKey).toBe('incident:CI_FAIL:head-aaa:run-1');
  });

  it('RSI_GEN_IDS_ARE_STABLE_ACROSS_RESTARTS：id 由 dedupeKey 派生，跨重启稳定（exactly-once 前置）', () => {
    const first = generateRsiWork({ signals: [signal()] });
    const second = generateRsiWork({ signals: [signal()] });
    expect(second.tasks[0]!.id).toBe(first.tasks[0]!.id);
    expect(second.incidents[0]!.incidentId).toBe(first.incidents[0]!.incidentId);
  });

  it('RSI_GEN_DEDUPES_KNOWN_KEYS：同因已存在（历史 incident/task/队列）→ 只记 duplicates，不再生成', () => {
    const known = ['task:CI_FAIL:head-aaa:run-1'];
    const result = generateRsiWork({ signals: [signal()], knownDedupeKeys: known });
    expect(result.tasks).toEqual([]);
    expect(result.incidents).toEqual([]);
    expect(result.duplicates).toEqual(['CI_FAIL:head-aaa:run-1']);

    const byIncidentKey = generateRsiWork({
      signals: [signal()],
      knownDedupeKeys: ['incident:CI_FAIL:head-aaa:run-1'],
    });
    expect(byIncidentKey.duplicates).toEqual(['CI_FAIL:head-aaa:run-1']);
  });

  it('RSI_GEN_DEDUPES_WITHIN_BATCH：同一批里重复的 dedupeKey 只生成一次', () => {
    const result = generateRsiWork({ signals: [signal(), signal()] });
    expect(result.tasks).toHaveLength(1);
    expect(result.skipped).toEqual([{ dedupeKey: 'CI_FAIL:head-aaa:run-1', reason: 'DUPLICATE_IN_BATCH' }]);
  });

  it('RSI_GEN_HIGH_RISK_NEVER_AUTO_EXECUTES：HIGH 风险只生成 ownerGateRequired 记录', () => {
    const result = generateRsiWork({ signals: [signal({ dedupeKey: 'CI_FAIL:hot:run-9', riskClass: 'HIGH' })] });
    expect(result.tasks).toEqual([]);
    expect(result.ownerGatedTasks).toHaveLength(1);
    expect(result.ownerGatedTasks[0]!.ownerGateRequired).toBe(true);
    expect(result.ownerGatedTasks[0]!.priority).toBe('P0');
    expect(result.incidents).toHaveLength(1);
  });

  it('RSI_GEN_REJECTS_SENSITIVE_SIGNAL：摘要仍含敏感数据 → fail-closed 跳过，不产出任何记录', () => {
    const result = generateRsiWork({
      signals: [signal({ dedupeKey: 'CI_FAIL:pii:run-2', summary: 'failed for ops@example.com' })],
    });
    expect(result.incidents).toEqual([]);
    expect(result.tasks).toEqual([]);
    expect(result.skipped).toEqual([{ dedupeKey: 'CI_FAIL:pii:run-2', reason: 'SENSITIVE_SIGNAL' }]);
  });

  it('RSI_GEN_RATE_LIMITS_PER_CYCLE：超过单轮上限只生成上限条数并标记 truncated', () => {
    const signals = Array.from({ length: 5 }, (_value, index) =>
      signal({ dedupeKey: `CI_FAIL:head-${index}:run-${index}` }),
    );
    const limited = generateRsiWork({ signals, maxTasksPerCycle: 2 });
    expect(limited.tasks).toHaveLength(2);
    expect(limited.truncated).toBe(true);

    const many = Array.from({ length: 12 }, (_value, index) =>
      signal({ dedupeKey: `CI_FAIL:head-${index}:run-${index}` }),
    );
    const hardCapped = generateRsiWork({ signals: many, maxTasksPerCycle: 999 });
    expect(hardCapped.tasks).toHaveLength(RSI_GENERATION_HARD_CAP_PER_CYCLE);
    expect(hardCapped.truncated).toBe(true);

    const exact = generateRsiWork({ signals: many.slice(0, RSI_GENERATION_HARD_CAP_PER_CYCLE), maxTasksPerCycle: 999 });
    expect(exact.tasks).toHaveLength(RSI_GENERATION_HARD_CAP_PER_CYCLE);
    expect(exact.truncated).toBe(false);
  });

  it('RSI_GEN_PARSE_SIGNALS_ARTIFACT：畸形行丢弃，合法信号保留', () => {
    const raw = JSON.stringify([
      signal(),
      { dedupeKey: 'x' },
      { dedupeKey: 'y', kind: 'CI_FAIL', summary: 'ok', riskClass: 'WHATEVER' },
      'junk',
    ]);
    const parsed = parseRsiSignals(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.dedupeKey).toBe('CI_FAIL:head-aaa:run-1');
    expect(parseRsiSignals('not json')).toEqual([]);
  });

  it('RSI_GEN_FEEDS_CONTINUATION_ENGINE：生成的任务能被续跑引擎立刻领取（事件 → task 真实闭环）', () => {
    const result = generateRsiWork({ signals: [signal()] });
    const engine = createRsiContinuationEngine({
      tasks: result.tasks.map((task) => ({ id: task.id, priority: task.priority, dedupeKey: task.dedupeKey })),
      now: () => 1_000,
    });
    const outcome = engine.handleEvent('CI_COMPLETED');
    expect(outcome.claimed?.id).toBe(result.tasks[0]!.id);
    expect(outcome.claimed?.dedupeKey).toBe('task:CI_FAIL:head-aaa:run-1');
  });

  it('RSI_TASK_GENERATOR_BOUNDARY：不落库、不发网络、不读凭据、不自动创建 OWNER 级工作', () => {
    expect(RSI_TASK_GENERATOR_BOUNDARY.writesDatabase).toBe(false);
    expect(RSI_TASK_GENERATOR_BOUNDARY.performsNetworkCalls).toBe(false);
    expect(RSI_TASK_GENERATOR_BOUNDARY.readsCredentials).toBe(false);
    expect(RSI_TASK_GENERATOR_BOUNDARY.createsOwnerGatedWork).toBe(false);
    expect(RSI_TASK_GENERATOR_BOUNDARY.ownerGatedSignalsAreRecordedOnly).toBe(true);
    expect(RSI_TASK_GENERATOR_BOUNDARY.dedupeByStableKey).toBe(true);
  });
});
