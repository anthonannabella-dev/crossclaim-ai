/**
 * RSI Runtime 组装入口（可被 crossclaim-rsi.service 托管）
 * ---------------------------------------------------------------
 * 把四件东西接起来：本地只读事件源 → 事件循环（事件驱动 + 60s 兜底）→ 续跑引擎 → runner。
 *
 * 安全默认：
 *   · 队列从只读 artifact 读取（`RSI_TASKS_PATH`）；缺失即空队列（静默，不猜任务）；
 *   · runner 由宿主注入；未注入时使用 **no-op runner**（只记录被领取的任务 id，不执行任何动作），
 *     保证「骨架运行」不会误触外部系统；
 *   · 本进程不读凭据、不写库、不外写；只可选写自己的日志（state 目录）。
 *
 * 运行：`npm run rsi:dev`（控制器骨架）或 `npm run rsi:run`（组装入口，事件驱动 + 兜底）。
 */

import { appendFile } from 'node:fs/promises';

import { attachContinuationToController, type RsiTaskRunner } from './rsi-controller-continuation';
import { createRsiEventLoop, type RsiEventSources, type RsiEventLoopHandle } from './rsi-event-loop';
import { createLocalEventSources, type RsiReadFile } from './rsi-local-sources';
import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';

export function parseTaskQueue(raw: string): readonly RsiSafeTask[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const tasks: RsiSafeTask[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.id !== 'string' || typeof row.dedupeKey !== 'string') continue;
      const priority = row.priority;
      if (priority !== 'P0' && priority !== 'P1' && priority !== 'P2' && priority !== 'P3' && priority !== 'P4') continue;
      tasks.push({ id: row.id, dedupeKey: row.dedupeKey, priority });
    }
    return tasks;
  } catch {
    return [];
  }
}

/** 未注入 runner 时的安全默认：只记录，不执行任何外部动作。 */
export function createNoopRunner(log?: (line: string) => void): RsiTaskRunner {
  return {
    async run(task) {
      log?.(`RSI_NOOP_RUNNER claimed=${task.id} priority=${task.priority}`);
      return { status: 'PASS' };
    },
  };
}

export interface RsiRuntimeComposition {
  loop: RsiEventLoopHandle;
  controller: ReturnType<typeof attachContinuationToController>;
  start(): void;
  stop(): void;
}

export async function composeRsiRuntime(input: {
  readFile: RsiReadFile;
  tasksPath?: string;
  ciResultsPath?: string;
  verdictPath?: string;
  testResultsPath?: string;
  runner?: RsiTaskRunner;
  intervalMs?: number;
}): Promise<RsiRuntimeComposition> {
  let tasks: readonly RsiSafeTask[] = [];
  if (input.tasksPath !== undefined) {
    try {
      tasks = parseTaskQueue(await input.readFile(input.tasksPath));
    } catch {
      tasks = []; // 缺失即空队列（静默）
    }
  }

  const controller = attachContinuationToController({
    tasks,
    runner: input.runner ?? createNoopRunner(),
  });

  const localSources: RsiEventSources = createLocalEventSources({
    readFile: input.readFile,
    paths: {
      ciResultsPath: input.ciResultsPath,
      verdictPath: input.verdictPath,
      testResultsPath: input.testResultsPath,
    },
  });

  const loop = createRsiEventLoop({
    controller,
    sources: localSources,
    intervalMs: input.intervalMs ?? 60_000,
  });

  return {
    loop,
    controller,
    start: () => loop.start(),
    stop: () => loop.stop(),
  };
}

export const RSI_RUNTIME_COMPOSITION_BOUNDARY = {
  eventDriven: true,
  watchdogFallbackOnly: true,
  defaultRunnerIsNoop: true,
  readsCredentials: false,
  writesDatabase: false,
  performsExternalWrite: false,
} as const;

const isDirectRun = process.argv[1] !== undefined && process.argv[1].includes('rsi-run');
if (isDirectRun) {
  void (async () => {
    const stateFile = process.env.RSI_STATE_FILE ?? 'rsi-run.log';
    const fsPromises = await import('node:fs/promises');
    const composition = await composeRsiRuntime({
      readFile: async (path) => fsPromises.readFile(path, 'utf8'),
      tasksPath: process.env.RSI_TASKS_PATH,
      ciResultsPath: process.env.RSI_CI_RESULTS_PATH,
      verdictPath: process.env.RSI_VERDICT_PATH,
      testResultsPath: process.env.RSI_TEST_RESULTS_PATH,
      runner: {
        async run(task) {
          await appendFile(stateFile, `${new Date().toISOString()} claimed=${task.id} priority=${task.priority}\n`, 'utf8');
          return { status: 'PASS' };
        },
      },
      intervalMs: Number(process.env.RSI_WATCHDOG_INTERVAL_MS ?? 60_000),
    });
    composition.start();
    console.log(
      'RSI_RUN_STARTED eventDriven=true watchdogIntervalMs=' + (process.env.RSI_WATCHDOG_INTERVAL_MS ?? 60_000),
    );
    const shutdown = (): void => {
      composition.stop();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })();
}
