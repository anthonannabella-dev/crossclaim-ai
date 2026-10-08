/** 组装入口验收：队列解析、no-op runner 默认、事件驱动领取、缺失 artifact 静默。 */

import { describe, expect, it } from 'vitest';

import {
  RSI_RUNTIME_COMPOSITION_BOUNDARY,
  composeRsiRuntime,
  parseTaskQueue,
} from '../runtime/rsi-run';
import { createUnconfiguredRunner } from '../runtime/rsi-task-runner';
import type { RsiReadFile } from '../runtime/rsi-local-sources';
import { createRsiCostLedger } from '../services/autonomy/rsi-cost-ledger';
import { createRsiInMemoryReconcileStore } from '../runtime/rsi-restart-reconcile';

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

  it('RSI_RUN_COMPOSES_EVENT_DRIVEN_RUNTIME：组装后可被事件驱动领取任务，且未配置 runner 时只 BLOCK', async () => {
    const log: string[] = [];
    const runtime = await composeRsiRuntime({
      readFile: files({
        '/tasks.json': JSON.stringify([{ id: 'A', priority: 'P1', dedupeKey: 'd:A' }]),
        '/ci.json': JSON.stringify([{ runId: '1', head: 'aaa', status: 'completed', conclusion: 'success' }]),
      }),
      tasksPath: '/tasks.json',
      ciResultsPath: '/ci.json',
      runner: createUnconfiguredRunner((line) => log.push(line)),
      intervalMs: 60_000,
    });

    const outcomes = await runtime.loop.pollOnce();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.claimed?.id).toBe('A');
    expect(log[0]?.startsWith('RSI_RUNNER_UNCONFIGURED')).toBe(true);
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

    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.defaultRunnerYieldsBlock).toBe(true);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.noopAutoPass).toBe(false);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.eventDriven).toBe(true);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.watchdogFallbackOnly).toBe(true);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.readsCredentials).toBe(false);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.coreWritesDatabase).toBe(false);
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.historicalDomainStepWritesInternalScanState).toBe(true);
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

  it('RSI_RUN_VERDICT_WATCHER_ONLY_WHILE_WAITING：配置后仅在等待裁决时读取并驱动续跑', async () => {
    const runtime = await composeRsiRuntime({
      readFile: files({
        '/tasks.json': JSON.stringify([{ id: 'A', priority: 'P1', dedupeKey: 'd:A' }]),
        '/verdict.json': JSON.stringify({ messageId: 'm1', verdict: 'PASS' }),
      }),
      tasksPath: '/tasks.json',
      verdictPath: '/verdict.json',
      intervalMs: 60_000,
      verdictWatch: { intervalMs: 15_000 },
    });

    expect(runtime.verdictWatcher).not.toBeNull();
    // 未进入等待 → 不读取、不投递
    const idle = await runtime.verdictWatcher!.pollOnce();
    expect(idle.delivered).toBe(false);
    expect(runtime.verdictWatcher!.reads()).toBe(0);

    // 进入等待 → 读取并投递一次（同裁决再读不重复投递）
    runtime.controller.markWaitingForVerdict('PASS');
    const delivered = await runtime.verdictWatcher!.pollOnce();
    expect(delivered.delivered).toBe(true);
    expect(runtime.verdictWatcher!.deliveries()).toBe(1);
    const again = await runtime.verdictWatcher!.pollOnce();
    expect(again.delivered).toBe(false);

    runtime.start();
    runtime.stop();
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.verdictPollOnlyWhileWaiting).toBe(true);

    const bare = await composeRsiRuntime({ readFile: files({}), intervalMs: 60_000 });
    expect(bare.verdictWatcher).toBeNull();
  });

  it('RSI_RUN_RECONCILE_WIRED_WHEN_CONFIGURED：配置后启动前执行一次 reconcile，未配置则为 null', async () => {
    // 未配置 store：NOT_CONFIGURED，不写任何状态（默认行为不变）
    const bare = await composeRsiRuntime({ readFile: files({}), intervalMs: 60_000 });
    expect(await bare.reconcileNow()).toBeNull();
    expect(RSI_RUNTIME_COMPOSITION_BOUNDARY.restartReconcileDefault).toBe('NOT_CONFIGURED');

    // 配置 store：过期 lease + 卡在 IN_PROGRESS 的任务 → 收敛；第二次运行空操作（exactly-once）
    const store = createRsiInMemoryReconcileStore({
      tasks: [{ taskId: 't1', dedupeKey: 'd:t1', status: 'IN_PROGRESS', createdAt: '2026-10-05T00:00:00.000Z' }],
      leases: [
        {
          leaseId: 'l1',
          taskId: 't1',
          ownerRef: 'runtime-old',
          status: 'ACTIVE',
          acquiredAt: '2026-10-05T00:00:00.000Z',
          renewedAt: '2026-10-05T00:00:00.000Z',
          expiresAt: '2026-10-05T00:05:00.000Z',
        },
      ],
    });
    const runtime = await composeRsiRuntime({
      readFile: files({}),
      intervalMs: 60_000,
      reconcile: { store, ownerRef: 'runtime-new', trigger: 'RESTART' },
    });
    const plan = await runtime.reconcileNow();
    expect(plan).not.toBeNull();
    expect(plan!.trigger).toBe('RESTART');
    expect(plan!.expiredLeaseIds).toEqual(['l1']);
    expect(plan!.recoveredTaskIds).toEqual(['t1']);
    expect(store.taskSnapshot()[0]?.status).toBe('READY');
    const again = await runtime.reconcileNow();
    expect(again!.idempotentNoop).toBe(true);
    runtime.start();
    runtime.stop();
  });

  it('RSI_RUN_SIGNAL_DRIVEN_TASKS：signals artifact → 自动生成任务并入队，重复信号不重复生成', async () => {
    const signals = JSON.stringify([
      { kind: 'CI_FAIL', dedupeKey: 'CI_FAIL:head-x:run-7', summary: 'CI failed on head-x (run 7)', refs: ['run:7'], riskClass: 'MEDIUM' },
      { kind: 'CI_FAIL', dedupeKey: 'CI_FAIL:head-y:run-8', summary: 'hot path broke', refs: ['run:8'], riskClass: 'HIGH' },
    ]);
    const runtime = await composeRsiRuntime({
      readFile: files({ '/signals.json': signals }),
      signalsPath: '/signals.json',
      intervalMs: 60_000,
    });
    const generation = runtime.taskGeneration();
    expect(generation).not.toBeNull();
    expect(generation!.tasks).toHaveLength(1);
    expect(generation!.ownerGatedTasks).toHaveLength(1); // HIGH 风险只登记，不入自动队列
    expect(runtime.controller.state().queueLength).toBe(1);

    // 同一信号第二次启动：队列里已有同 dedupeKey → 只记 duplicate，不重复入队
    const tasksArtifact = JSON.stringify([
      { id: generation!.tasks[0]!.id, priority: generation!.tasks[0]!.priority, dedupeKey: generation!.tasks[0]!.dedupeKey },
    ]);
    const again = await composeRsiRuntime({
      readFile: files({ '/signals.json': signals, '/tasks.json': tasksArtifact }),
      tasksPath: '/tasks.json',
      signalsPath: '/signals.json',
      intervalMs: 60_000,
    });
    expect(again.taskGeneration()!.tasks).toHaveLength(0);
    expect(again.taskGeneration()!.duplicates).toEqual(['CI_FAIL:head-x:run-7']);
    expect(again.controller.state().queueLength).toBe(1);

    const bare = await composeRsiRuntime({ readFile: files({}), intervalMs: 60_000 });
    expect(bare.taskGeneration()).toBeNull();
    runtime.start();
    runtime.stop();
  });
});
