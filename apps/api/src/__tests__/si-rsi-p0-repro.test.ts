/**
 * PHASE 0 · P0 风险真实复现（指令 3.「PHASE 0」）
 * ---------------------------------------------------------------
 * P0-A 动态任务队列：服务启动后新入队的客户任务，能否被**不重启**的 RSI 领取？
 * P0-B Recovery 正式装配：生产启动链（rsi-run 直跑）下 `task:recovery:*` 的真实结局？
 *
 * 复现原则（指令要求「不得预设结论」）：
 *   · 使用**真实** runtime 模块（composeRsiRuntime / 真实事件循环 / 真实 continuation 引擎）；
 *   · 使用**真实**文件 IO（真实 tasks.json 与真实 JSON 队列端口实现）；
 *   · 只有 runner 用探针（记录「哪些任务真的被交到执行器」），不替换任何被测逻辑。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeRsiRuntime } from '../runtime/rsi-run';
import { createJsonTaskQueuePort } from '../services/agent-goal/goal-admission';
import type { RsiTaskRunner } from '../runtime/rsi-controller-continuation';
import type { GoalTaskDraft } from '../services/agent-goal/goal-task-planner';

const readFileUtf8 = async (p: string): Promise<string> => readFileSync(p, 'utf8');

let dir: string;
let tasksPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cc-p0-'));
  tasksPath = path.join(dir, 'tasks.json');
  writeFileSync(tasksPath, '[]\n', 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const probe = (): { seen: string[]; runner: RsiTaskRunner } => {
  const seen: string[] = [];
  return {
    seen,
    runner: {
      async run(task) {
        seen.push(task.dedupeKey);
        return { status: 'PASS' };
      },
    },
  };
};

const readQueue = (): Array<{ id: string; dedupeKey: string; priority: string }> =>
  JSON.parse(readFileSync(tasksPath, 'utf8')) as Array<{ id: string; dedupeKey: string; priority: string }>;

/** 构造一个合法的最小 GoalTaskDraft（走真实队列端口时使用） */
const draft = (dedupeKey: string): GoalTaskDraft => ({
  domain: 'LOGISTICS',
  dedupeKey,
  candidateActions: [],
  autoExecutableActions: [],
  blockedActions: [],
  executionMode: 'AUTO_WHEN_AUTHORIZED',
  requiresStandingAuthorizationForAutoExecution: true,
});

/** 模拟运行中的 RSI：事件轮询 + 60s 兜底 tick（与 rsi-event-loop 的 start() 行为一致） */
const pump = async (
  composition: Awaited<ReturnType<typeof composeRsiRuntime>>,
  rounds: number,
): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await composition.loop.pollOnce();
    await composition.controller.tick();
  }
};

describe('PHASE 0 · P0-A 动态任务队列', () => {
  it('A1 复现：服务启动后入队的客户任务不会被运行中的 RSI 领取（需要重启）', async () => {
    const { seen, runner } = probe();
    const composition = await composeRsiRuntime({
      readFile: readFileUtf8,
      tasksPath,
      runner,
      intervalMs: 50,
    });
    composition.start();
    try {
      await pump(composition, 3);
      expect(seen).toEqual([]);

      // 真实客户 Goal 入队路径 = server.ts 使用的同一端口实现
      const port = createJsonTaskQueuePort({ tasksPath });
      const admitted = await port.admit({
        organizationId: 'org-A',
        tasks: [draft('task:recovery:scan:v1:goal-1')],
      });
      expect(admitted.admitted).toEqual(['task:recovery:scan:v1:goal-1']);
      expect(readQueue().map((row) => row.dedupeKey)).toContain('task:recovery:scan:v1:goal-1');

      // 给运行中的实例充分机会（事件轮询 + 兜底 tick）
      await pump(composition, 8);

      // 复现结论：任务已 durable 落盘，但运行中的 runtime 从未看到它
      expect(seen).toEqual([]);
      expect(composition.controller.state().queueLength).toBe(0);
      expect(readQueue()).toHaveLength(1);
    } finally {
      composition.stop();
    }
  });

  it('A2 对照：启动前已在队列文件中的任务会被领取（差异确实在「启动后入队」）', async () => {
    writeFileSync(
      tasksPath,
      JSON.stringify([{ id: 'pre-1', priority: 'P2', dedupeKey: 'task:demo:pre-1' }]) + '\n',
      'utf8',
    );
    const { seen, runner } = probe();
    const composition = await composeRsiRuntime({
      readFile: readFileUtf8,
      tasksPath,
      runner,
      intervalMs: 50,
    });
    try {
      await composition.controller.tick();
      expect(seen).toEqual(['task:demo:pre-1']);
    } finally {
      composition.stop();
    }
  });

  it('A3 复现：JSON 队列读-改-写无并发保护 → 并发入队会丢任务', async () => {
    const port = createJsonTaskQueuePort({ tasksPath });
    const [r1, r2] = await Promise.all([
      port.admit({
        organizationId: 'org-A',
        tasks: [draft('task:recovery:scan:v1:a')],
      }),
      port.admit({
        organizationId: 'org-A',
        tasks: [draft('task:recovery:scan:v1:b')],
      }),
    ]);
    // 两个调用都自称 admit 成功
    expect([...r1.admitted, ...r2.admitted].sort()).toEqual([
      'task:recovery:scan:v1:a',
      'task:recovery:scan:v1:b',
    ]);
    // 但落盘结果只保留最后一次写入 ⇒ 丢任务
    const onDisk = readQueue().map((row) => row.dedupeKey);
    expect(onDisk.length).toBe(1);
    expect(onDisk.length).toBeLessThan(2);
  });
});

describe('PHASE 0 · P0-B Recovery 生产装配', () => {
  it('B1 复现：生产直跑入口未装配 Recovery pack 时，recovery 任务被 BLOCK 且不落到任何执行器', async () => {
    writeFileSync(
      tasksPath,
      JSON.stringify([{ id: 'rec-1', priority: 'P2', dedupeKey: 'task:recovery:scan:v1:rec-1' }]) + '\n',
      'utf8',
    );
    const { seen, runner } = probe();
    // 与 dist/src/runtime/rsi-run.js 直跑入口等价：不传 productRecoveryPack / domainPacks
    const composition = await composeRsiRuntime({
      readFile: readFileUtf8,
      tasksPath,
      runner,
      intervalMs: 50,
    });
    try {
      const first = await composition.controller.tick();
      expect(first.claimed?.dedupeKey).toBe('task:recovery:scan:v1:rec-1');
      // Recovery 命名空间**不会**回退给 caller runner
      expect(seen).toEqual([]);
      // 没有任何 domain pack 被派发（即没有 Recovery SI 组装）
      expect(composition.domainDispatchLog()).toEqual([]);
      // 被 BLOCK 的任务不会被重复领取
      const second = await composition.controller.tick();
      expect(second.claimed).toBeNull();
      expect(seen).toEqual([]);
    } finally {
      composition.stop();
    }
  });

  it('B2 对照：同一组合下非 recovery 任务会正常交给注入 runner（差异仅限 recovery 命名空间）', async () => {
    writeFileSync(
      tasksPath,
      JSON.stringify([{ id: 'demo-1', priority: 'P2', dedupeKey: 'task:demo:demo-1' }]) + '\n',
      'utf8',
    );
    const { seen, runner } = probe();
    const composition = await composeRsiRuntime({
      readFile: readFileUtf8,
      tasksPath,
      runner,
      intervalMs: 50,
    });
    try {
      const outcome = await composition.controller.tick();
      expect(outcome.claimed?.dedupeKey).toBe('task:demo:demo-1');
      expect(seen).toEqual(['task:demo:demo-1']);
    } finally {
      composition.stop();
    }
  });
});
