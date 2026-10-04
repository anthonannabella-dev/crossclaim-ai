/** 组装入口验收：队列解析、no-op runner 默认、事件驱动领取、缺失 artifact 静默。 */

import { describe, expect, it } from 'vitest';

import {
  RSI_RUNTIME_COMPOSITION_BOUNDARY,
  composeRsiRuntime,
  createNoopRunner,
  parseTaskQueue,
} from '../runtime/rsi-run';
import type { RsiReadFile } from '../runtime/rsi-local-sources';
import { createRsiCostLedger } from '../services/autonomy/rsi-cost-ledger';

const files = (map: Record<string, string>): RsiReadFile => async (path) => {
  const value = map[path];
  if (value === undefined) throw new Error('ENOENT');
  return value;
};

describe('RSI 运行组装入口', () => {
  it('RSI_RUN_PARSE_TASK_QUEUE：合法任务保留，畸形行丢弃', () => {
    const queue = parseTaskQueue(
      JSON.stringify([
        { id: 'A', priority: 'P0', dedupeKey: 'd:A' },
        { id: 'B', priority: 'P9', dedupeKey: 'd:B' }, // 非法优先级 → 丢弃
        { id: 'C' }, // 缺 dedupeKey → 丢弃
        'junk',
      ]),
    );
    expect(queue).toEqual([{ id: 'A', priority: 'P0', dedupeKey: 'd:A' }]);
    expect(parseTaskQueue('not json')).toEqual([]);
  });

  it('RSI_RUN_COMPOSES_EVENT_DRIVEN_RUNTIME：组装后可被事件驱动领取任务，且默认 runner 是 no-op', async () => {
    const log: string[] = [];
    const runtime = await composeRsiRuntime({
      readFile: files({
        '/tasks.json': JSON.stringify([{ id: 'A', priority: 'P1', dedupeKey: 'd:A' }]),
        '/ci.json': JSON.stringify([{ runId: '1', head: 'aaa', status: 'completed', conclusion: 'success' }]),
      }),
      tasksPath: '/tasks.json',
      ciResultsPath: '/ci.json',
      runner: createNoopRunner((line) => log.push(line)),
      intervalMs: 60_000,
    });

    const outcomes = await runtime.loop.pollOnce();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.claimed?.id).toBe('A');
    expect(log).toEqual(['RSI_NOOP_RUNNER claimed=A priority=P1']);
    // 无新事件 → 静默
    expect(await runtime.loop.pollOnce()).toEqual([]);

    runtime.start();
    runtime.stop(); // 可安全起停
  });

  it('RSI_RUN_MISSING_ARTIFACTS_ARE_SILENT：任务/CI/verdict 全缺失 → 空队列 + 静默轮询', async () => {
    const runtime = await composeRsiRuntime({
      readFile: files({}),
      tasksPath: '/missing-tasks.json',
      ciResultsPath: '/missing-ci.json',
      verdictPath: '/missing-verdict.json',
      intervalMs: 60_000,
    });
    expect(runtime.controller.state().queueLength).toBe(0);
    expect(await runtime.loop.pollOnce()).toEqual([]);
    expect(runtime.loop.silentPolls()).toBe(1);

    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.defaultRunnerIsNoop).toBe(true);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.eventDriven).toBe(true);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.watchdogFallbackOnly).toBe(true);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.readsCredentials).toBe(false);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.writesDatabase).toBe(false);
  });

  it('RSI_RUN_PUBLISHER_WIRED_WHEN_CONFIGURED：配置后随运行时起停并写出快照，未配置则为 null', async () => {
    const writes: string[] = [];
    const ledger = createRsiCostLedger();
    ledger.recordRuleResolved({ entryId: 'r1', at: new Date().toISOString(), incidentId: 'inc-1' });

    const runtime = await composeRsiRuntime({
      readFile: files({}),
      intervalMs: 60_000,
      adminSnapshot: {
        path: '/snapshot.json',
        write: async (_path, content) => {
          writes.push(content);
        },
        ledger,
        healthProvider: () => ({
          health: 'HEALTHY',
          openIncidents: 0,
          activeTasks: 0,
          failedTasks: 0,
          pendingOwnerApprovals: 0,
          lastScanAt: null,
        }),
        usageProvider: () => ({
          spentToday: 0,
          spentThisMonth: 0,
          incidentSpent: 0,
          incidentAttempts: 0,
          incidentCandidates: 0,
          incidentLlmCalls: 0,
          incidentTokens: 0,
          incidentElapsedMinutes: 0,
          strongCallsForTask: 0,
        }),
      },
    });
    expect(runtime.publisher).not.toBeNull();
    const published = await runtime.publisher!.publishOnce();
    expect(published.ok).toBe(true);
    expect(JSON.parse(writes[0]!).schema).toBe('rsi-admin-snapshot-v1');
    runtime.start();
    runtime.stop();

    const bare = await composeRsiRuntime({ readFile: files({}), intervalMs: 60_000 });
    expect(bare.publisher).toBeNull();
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.adminSnapshotIsReadOnlyArtifact).toBe(true);
  });
});
