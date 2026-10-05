/** RSI-RT-06 重启/接管 reconcile 验收：lease 恢复、孤儿任务、去重、exactly-once 幂等 */

import { describe, expect, it } from 'vitest';

import {
  RSI_RESTART_RECONCILE_BOUNDARY,
  createRsiInMemoryReconcileStore,
  planRsiReconcile,
  runRsiRestartReconcile,
  type RsiPersistedLease,
  type RsiPersistedTask,
  type RsiReconcileStore,
} from '../runtime/rsi-restart-reconcile';

const NOW = '2026-10-05T00:10:00.000Z';

const task = (over: Partial<RsiPersistedTask> = {}): RsiPersistedTask => ({
  taskId: 'task-1',
  dedupeKey: 'dedupe-1',
  status: 'IN_PROGRESS',
  createdAt: '2026-10-05T00:00:00.000Z',
  ...over,
});

const lease = (over: Partial<RsiPersistedLease> = {}): RsiPersistedLease => ({
  leaseId: 'lease-1',
  taskId: 'task-1',
  ownerRef: 'runtime-a',
  status: 'ACTIVE',
  acquiredAt: '2026-10-05T00:00:00.000Z',
  renewedAt: '2026-10-05T00:00:00.000Z',
  expiresAt: '2026-10-05T00:05:00.000Z',
  ...over,
});

const run = async (
  input: { tasks: readonly RsiPersistedTask[]; leases: readonly RsiPersistedLease[] },
  ownerRef = 'runtime-b',
): Promise<{ plan: Awaited<ReturnType<typeof runRsiRestartReconcile>>; store: ReturnType<typeof createRsiInMemoryReconcileStore> }> => {
  const store = createRsiInMemoryReconcileStore(input);
  const plan = await runRsiRestartReconcile({ store, ownerRef, trigger: 'BOOT', now: () => NOW });
  return { plan, store };
};

describe('RSI restart reconcile', () => {
  it('RSI_RECONCILE_EXPIRED_ACTIVE_LEASE：过期 ACTIVE lease → 标 EXPIRED + 任务回 READY', async () => {
    const { plan, store } = await run({ tasks: [task()], leases: [lease()] });
    expect(plan.expiredLeaseIds).toEqual(['lease-1']);
    expect(plan.recoveredTaskIds).toEqual(['task-1']);
    expect(plan.heldActiveLeaseIds).toEqual([]);
    expect(plan.idempotentNoop).toBe(false);
    expect(store.leaseSnapshot()[0]?.status).toBe('EXPIRED');
    expect(store.taskSnapshot()[0]?.status).toBe('READY');
  });

  it('RSI_RECONCILE_LIVE_LEASE_HELD：未过期 ACTIVE lease（他人 or 自己）一律不动', async () => {
    const held = await run({ tasks: [task()], leases: [lease({ expiresAt: '2026-10-05T00:30:00.000Z' })] });
    expect(held.plan.heldActiveLeaseIds).toEqual(['lease-1']);
    expect(held.plan.recoveredTaskIds).toEqual([]);
    expect(held.plan.idempotentNoop).toBe(true);
    expect(held.store.appliedOps()).toEqual([]);

    const selfHeld = await run(
      { tasks: [task()], leases: [lease({ ownerRef: 'runtime-b', expiresAt: '2026-10-05T00:30:00.000Z' })] },
      'runtime-b',
    );
    expect(selfHeld.plan.heldActiveLeaseIds).toEqual(['lease-1']);
    expect(selfHeld.store.taskSnapshot()[0]?.status).toBe('IN_PROGRESS');
  });

  it('RSI_RECONCILE_RELEASED_LEASE：RELEASED/EXPIRED 的 lease + 仍 IN_PROGRESS → 直接续跑', async () => {
    const { plan, store } = await run({ tasks: [task()], leases: [lease({ status: 'EXPIRED' })] });
    expect(plan.expiredLeaseIds).toEqual([]);
    expect(plan.recoveredTaskIds).toEqual(['task-1']);
    expect(store.appliedOps()).toEqual(['requeueTask:task-1']);

    const released = await run({ tasks: [task()], leases: [lease({ status: 'RELEASED' })] });
    expect(released.plan.recoveredTaskIds).toEqual(['task-1']);
  });

  it('RSI_RECONCILE_ORPHAN_TASK：IN_PROGRESS 但没有 lease 行（崩溃窗口）→ 回 READY', async () => {
    const { plan, store } = await run({ tasks: [task()], leases: [] });
    expect(plan.recoveredTaskIds).toEqual(['task-1']);
    expect(store.taskSnapshot()[0]?.status).toBe('READY');
    expect(store.leaseSnapshot()).toEqual([]);
  });

  it('RSI_RECONCILE_TERMINAL_UNTOUCHED：终态任务不因 lease 过期而被复活', async () => {
    const { plan, store } = await run({ tasks: [task({ status: 'PROMOTED' })], leases: [lease()] });
    expect(plan.expiredLeaseIds).toEqual(['lease-1']);
    expect(plan.recoveredTaskIds).toEqual([]);
    expect(store.taskSnapshot()[0]?.status).toBe('PROMOTED');
  });

  it('RSI_RECONCILE_DEDUPE_REPORTED_ONLY：同一 dedupeKey 的重复任务只上报，不创建也不删除', async () => {
    const tasks = [
      task({ taskId: 'task-1', dedupeKey: 'dup-1', status: 'READY' }),
      task({ taskId: 'task-2', dedupeKey: 'dup-1', status: 'READY' }),
    ];
    const { plan, store } = await run({ tasks, leases: [] });
    expect(plan.duplicateDedupeKeys).toEqual(['dup-1']);
    expect(plan.recoveredTaskIds).toEqual([]);
    expect(store.taskSnapshot()).toHaveLength(2);
    expect(store.appliedOps()).toEqual([]);
  });

  it('RSI_RECONCILE_IDEMPOTENT：同一状态重复运行 → 第二次为空操作，且不重复写', async () => {
    const store = createRsiInMemoryReconcileStore({ tasks: [task()], leases: [lease()] });
    const first = await runRsiRestartReconcile({ store, ownerRef: 'runtime-b', now: () => NOW });
    expect(first.idempotentNoop).toBe(false);
    const opsAfterFirst = [...store.appliedOps()];

    const second = await runRsiRestartReconcile({ store, ownerRef: 'runtime-b', now: () => NOW });
    expect(second.idempotentNoop).toBe(true);
    expect(second.expiredLeaseIds).toEqual([]);
    expect(second.recoveredTaskIds).toEqual([]);
    expect([...store.appliedOps()]).toEqual(opsAfterFirst);
    expect(store.taskSnapshot()[0]?.status).toBe('READY');
    expect(store.leaseSnapshot()[0]?.status).toBe('EXPIRED');
  });

  it('RSI_RECONCILE_UNKNOWN_STATE_REPORTED_ONLY：未知任务状态只上报，绝不改写', async () => {
    const { plan, store } = await run({ tasks: [task({ status: 'WEIRD_STATE' })], leases: [] });
    expect(plan.unknownTaskIds).toEqual(['task-1']);
    expect(plan.recoveredTaskIds).toEqual([]);
    expect(store.taskSnapshot()[0]?.status).toBe('WEIRD_STATE');
  });

  it('RSI_RECONCILE_EXACTLY_ONCE：reconcile 只做状态收敛，任务集合大小恒定', () => {
    const store = createRsiInMemoryReconcileStore({
      tasks: [task(), task({ taskId: 'task-2', dedupeKey: 'dedupe-2', status: 'READY' })],
      leases: [lease(), lease({ leaseId: 'lease-2', taskId: 'task-2', status: 'RELEASED' })],
    });
    const before = store.taskSnapshot().length;

    return runRsiRestartReconcile({ store, ownerRef: 'runtime-b', now: () => NOW }).then((plan) => {
      expect(plan.recoveredTaskIds).toEqual(['task-1']);
      expect(store.taskSnapshot()).toHaveLength(before);
      expect(store.taskSnapshot().map((entry) => entry.taskId).sort()).toEqual(['task-1', 'task-2']);
      expect(RSI_RESTART_RECONCILE_BOUNDARY.createsTasks).toBe(false);
      expect(RSI_RESTART_RECONCILE_BOUNDARY.deletesTasks).toBe(false);
      expect(RSI_RESTART_RECONCILE_BOUNDARY.readsCredentials).toBe(false);
      expect(RSI_RESTART_RECONCILE_BOUNDARY.performsNetworkCalls).toBe(false);
      expect(RSI_RESTART_RECONCILE_BOUNDARY.transport).toBe(false);
      expect(RSI_RESTART_RECONCILE_BOUNDARY.idempotentByStoreGuard).toBe(true);
    });
  });

  it('RSI_RECONCILE_PLAN_IS_PURE：纯函数规划不产生任何写入', async () => {
    const store: RsiReconcileStore = {
      listLeases: async () => [lease()],
      listTasks: async () => [task()],
      markLeaseStatus: async () => {
        throw new Error('SHOULD_NOT_WRITE');
      },
      requeueTask: async () => {
        throw new Error('SHOULD_NOT_WRITE');
      },
    };
    const plan = planRsiReconcile({
      tasks: await store.listTasks(),
      leases: await store.listLeases(),
      at: NOW,
      ownerRef: 'runtime-b',
    });
    expect(plan.trigger).toBe('BOOT');
    expect(plan.scannedTasks).toBe(1);
    expect(plan.scannedLeases).toBe(1);
    expect(plan.recoveredTaskIds).toEqual(['task-1']);
  });
});
