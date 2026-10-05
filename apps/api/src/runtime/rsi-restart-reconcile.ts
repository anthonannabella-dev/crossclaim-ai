/**
 * RSI-RT-06 重启 / 接管 reconcile（lease 恢复 + 去重 + exactly-once）
 * ---------------------------------------------------------------
 * 裁定依据：MSG-20261005-02（RSI-RT-06 migration SQL = PASS；lease 需 renewedAt / ownerRef /
 * status ACTIVE|EXPIRED|RELEASED，judge 分离，证据 append-only）。
 *
 * 目标：进程重启（或接管）后，把「上次运行留下的半成品」收敛回可继续执行的状态，
 * 且**绝不重复创建任务**：
 *   · ACTIVE 且未过期的 lease → 不动（可能是另一个仍在运行的 runtime）；
 *   · ACTIVE 但已过期 → 标 EXPIRED，并把仍处于 IN_PROGRESS 的任务放回 READY；
 *   · EXPIRED / RELEASED 的 lease + 仍 IN_PROGRESS 的任务 → 放回 READY（续跑）；
 *   · IN_PROGRESS 但没有 lease 行（claim 与 lease 之间的崩溃窗口）→ 放回 READY；
 *   · 终态（PROMOTED / REJECTED）与未知状态 → 一律不动，只如实上报；
 *   · 同一 dedupeKey 出现多个未终态任务 → 只上报重复，不在 reconcile 里创建/删除任何东西。
 *
 * 本模块只做**状态收敛**：不读凭据、不发网络、不做 External Write / Payment / Transport，
 * 也不触碰客户数据；所有落库操作都经由注入的 `RsiReconcileStore`，便于在无 DB 环境验证契约。
 * 幂等性由 store 侧的「带状态前置条件的 update」保证（重复运行 = 0 行更新）。
 */

import { RSI_LEASE_STATES, RSI_TASK_STATES } from '../services/autonomy/rsi-lifecycle';

export type RsiReconcileTrigger = 'BOOT' | 'RESTART' | 'MANUAL';
export type RsiLeaseStatus = (typeof RSI_LEASE_STATES)[number];

/** 终止态：不再需要续跑（与 rsi-lifecycle 的 TASK 迁移表一致） */
export const RSI_TERMINAL_TASK_STATES = ['PROMOTED', 'REJECTED'] as const;
/** 唯一会被 reconcile 放回 READY 的状态 */
export const RSI_RECOVERABLE_TASK_STATE = 'IN_PROGRESS';

export interface RsiPersistedLease {
  leaseId: string;
  taskId: string;
  ownerRef: string;
  status: RsiLeaseStatus;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}

export interface RsiPersistedTask {
  taskId: string;
  dedupeKey: string;
  status: string;
  createdAt: string;
}

export interface RsiReconcileStore {
  listLeases(): Promise<readonly RsiPersistedLease[]>;
  listTasks(): Promise<readonly RsiPersistedTask[]>;
  /** 幂等：仅当 lease 仍为 ACTIVE 时才改状态 */
  markLeaseStatus(input: { leaseId: string; status: 'EXPIRED'; at: string }): Promise<void>;
  /** 幂等：仅当任务仍为 IN_PROGRESS 时才放回 READY */
  requeueTask(input: { taskId: string; at: string }): Promise<void>;
}

export interface RsiReconcilePlan {
  at: string;
  ownerRef: string;
  trigger: RsiReconcileTrigger;
  scannedTasks: number;
  scannedLeases: number;
  expiredLeaseIds: readonly string[];
  recoveredTaskIds: readonly string[];
  heldActiveLeaseIds: readonly string[];
  duplicateDedupeKeys: readonly string[];
  unknownTaskIds: readonly string[];
  /** 重复运行时应为 true：没有任何需要收敛的差异 */
  idempotentNoop: boolean;
}

const TERMINAL = new Set<string>(RSI_TERMINAL_TASK_STATES);
const KNOWN_TASK_STATES = new Set<string>(RSI_TASK_STATES);
const KNOWN_LEASE_STATES = new Set<string>(RSI_LEASE_STATES);

const isExpired = (lease: RsiPersistedLease, nowMs: number): boolean => {
  const expiresAt = Date.parse(lease.expiresAt);
  // 解析失败按「已过期」处理：宁可收敛一次，也不要留下永不释放的 lease
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs;
};

/** 纯函数：只根据当前落库状态推导收敛计划，不做任何写入 */
export function planRsiReconcile(input: {
  tasks: readonly RsiPersistedTask[];
  leases: readonly RsiPersistedLease[];
  at: string;
  ownerRef: string;
  trigger?: RsiReconcileTrigger;
}): RsiReconcilePlan {
  const nowMs = Date.parse(input.at);
  const byTaskId = new Map(input.tasks.map((task) => [task.taskId, task]));
  const expiredLeaseIds: string[] = [];
  const recovered = new Set<string>();
  const held: string[] = [];
  const unknownTaskIds: string[] = [];

  const taskIsRecoverable = (task: RsiPersistedTask | undefined): boolean =>
    task !== undefined && !TERMINAL.has(task.status) && task.status === RSI_RECOVERABLE_TASK_STATE;

  const leasesByTaskId = new Map<string, RsiPersistedLease[]>();
  for (const lease of input.leases) {
    const bucket = leasesByTaskId.get(lease.taskId);
    if (bucket === undefined) leasesByTaskId.set(lease.taskId, [lease]);
    else bucket.push(lease);
  }

  for (const lease of input.leases) {
    if (!KNOWN_LEASE_STATES.has(lease.status)) continue;
    const task = byTaskId.get(lease.taskId);
    if (lease.status === 'ACTIVE') {
      if (!isExpired(lease, nowMs)) {
        held.push(lease.leaseId);
        continue;
      }
      expiredLeaseIds.push(lease.leaseId);
      if (taskIsRecoverable(task)) recovered.add(lease.taskId);
      continue;
    }
    // EXPIRED / RELEASED：任务若仍卡在 IN_PROGRESS，说明上次没写完收尾动作
    if (taskIsRecoverable(task)) recovered.add(lease.taskId);
  }

  // 孤儿任务：IN_PROGRESS 但根本没有 lease 行（claim 与 lease 之间的崩溃窗口）
  for (const task of input.tasks) {
    if (!KNOWN_TASK_STATES.has(task.status)) {
      unknownTaskIds.push(task.taskId);
      continue;
    }
    if (TERMINAL.has(task.status)) continue;
    if (task.status === RSI_RECOVERABLE_TASK_STATE && !leasesByTaskId.has(task.taskId)) {
      recovered.add(task.taskId);
    }
  }

  const activeByDedupeKey = new Map<string, number>();
  for (const task of input.tasks) {
    if (TERMINAL.has(task.status)) continue;
    activeByDedupeKey.set(task.dedupeKey, (activeByDedupeKey.get(task.dedupeKey) ?? 0) + 1);
  }
  const duplicateDedupeKeys = [...activeByDedupeKey.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();

  const expired = [...new Set(expiredLeaseIds)].sort();
  const recoveredTaskIds = [...recovered].sort();
  return {
    at: input.at,
    ownerRef: input.ownerRef,
    trigger: input.trigger ?? 'BOOT',
    scannedTasks: input.tasks.length,
    scannedLeases: input.leases.length,
    expiredLeaseIds: expired,
    recoveredTaskIds,
    heldActiveLeaseIds: [...held].sort(),
    duplicateDedupeKeys,
    unknownTaskIds: [...unknownTaskIds].sort(),
    idempotentNoop: expired.length === 0 && recoveredTaskIds.length === 0,
  };
}

/** 执行计划：先释放过期 lease，再把任务放回 READY（两步各自幂等） */
export async function runRsiRestartReconcile(input: {
  store: RsiReconcileStore;
  ownerRef: string;
  trigger?: RsiReconcileTrigger;
  now?: () => string;
}): Promise<RsiReconcilePlan> {
  const at = (input.now ?? (() => new Date().toISOString()))();
  const [tasks, leases] = await Promise.all([input.store.listTasks(), input.store.listLeases()]);
  const plan = planRsiReconcile({ tasks, leases, at, ownerRef: input.ownerRef, trigger: input.trigger });
  for (const leaseId of plan.expiredLeaseIds) {
    await input.store.markLeaseStatus({ leaseId, status: 'EXPIRED', at });
  }
  for (const taskId of plan.recoveredTaskIds) {
    await input.store.requeueTask({ taskId, at });
  }
  return plan;
}

/** 内存 store：用于契约验收与无 DB 环境；语义与 DB 实现一致（带状态前置条件的更新） */
export function createRsiInMemoryReconcileStore(input: {
  tasks?: readonly RsiPersistedTask[];
  leases?: readonly RsiPersistedLease[];
} = {}): RsiReconcileStore & {
  appliedOps(): readonly string[];
  taskSnapshot(): readonly RsiPersistedTask[];
  leaseSnapshot(): readonly RsiPersistedLease[];
} {
  const tasks = [...(input.tasks ?? [])];
  const leases = [...(input.leases ?? [])];
  const applied: string[] = [];
  return {
    async listLeases() {
      return leases.map((lease) => ({ ...lease }));
    },
    async listTasks() {
      return tasks.map((task) => ({ ...task }));
    },
    async markLeaseStatus({ leaseId, status, at }) {
      applied.push(`markLeaseStatus:${leaseId}:${status}`);
      for (const lease of leases) {
        if (lease.leaseId !== leaseId) continue;
        if (lease.status !== 'ACTIVE') continue; // 幂等：只有 ACTIVE 才能被改
        lease.status = status;
        lease.renewedAt = at;
      }
    },
    async requeueTask({ taskId, at }) {
      applied.push(`requeueTask:${taskId}`);
      for (const task of tasks) {
        if (task.taskId !== taskId) continue;
        if (task.status !== RSI_RECOVERABLE_TASK_STATE) continue; // 幂等：只有 IN_PROGRESS 才能被放回
        task.status = 'READY';
        void at; // createdAt 保持不变，保证时间单调
      }
    },
    appliedOps: () => applied,
    taskSnapshot: () => tasks.map((task) => ({ ...task })),
    leaseSnapshot: () => leases.map((lease) => ({ ...lease })),
  };
}

export const RSI_RESTART_RECONCILE_BOUNDARY = {
  createsTasks: false,
  deletesTasks: false,
  readsCredentials: false,
  performsNetworkCalls: false,
  externalWrite: false,
  payment: false,
  transport: false,
  writesCustomerData: false,
  terminalStatesUntouched: true,
  unknownStatesReportedOnly: true,
  idempotentByStoreGuard: true,
} as const;
