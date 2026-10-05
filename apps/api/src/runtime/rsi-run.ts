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

import { attachContinuationToController, type RsiTaskRunner } from './rsi-controller-continuation';
import { createRsiEventLoop, type RsiEventSources, type RsiEventLoopHandle } from './rsi-event-loop';
import { createLocalEventSources, type RsiReadFile } from './rsi-local-sources';
import {
  createCommandRunner,
  createUnconfiguredRunner,
  loadRunnerFromModule,
  type RsiEvidenceRunner,
} from './rsi-task-runner';
import {
  createAdminSnapshotPublisher,
  type RsiSnapshotPublisher,
} from './rsi-admin-snapshot-publisher';
import { createVerdictWatcher, type RsiVerdictWatcher } from './rsi-verdict-watcher';
import type { RsiAdminHealth } from './rsi-admin-snapshot';
import type { RsiCostLedger } from '../services/autonomy/rsi-cost-ledger';
import type { RsiCostUsage } from '../services/autonomy/rsi-cost-policy';
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
/**
 * 直接运行路径的真实执行器解析：
 *   1) RSI_RUNNER_MODULE 指定模块（导出 createRsiTaskRunner 或 rsiTaskRunner）；
 *   2) RSI_RUNNER_COMMAND + RSI_RUNNER_ARGS 指定受白名单约束的命令；
 *   3) 都没有 → 未配置执行器，任务只会被判 BLOCK（绝不 auto-PASS）。
 */
export async function resolveRunnerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.log(line),
): Promise<RsiEvidenceRunner> {
  const spec = env.RSI_RUNNER_MODULE;
  if (spec !== undefined && spec.trim() !== '') {
    const loaded = await loadRunnerFromModule(spec, log);
    if (loaded !== null) return loaded;
  }
  const command = env.RSI_RUNNER_COMMAND;
  if (command !== undefined && command.trim() !== '') {
    const args = (env.RSI_RUNNER_ARGS ?? '').split(' ').map((part) => part.trim()).filter((part) => part !== '');
    const timeoutMs = Number(env.RSI_RUNNER_TIMEOUT_MS ?? '');
    return createCommandRunner({
      command,
      args,
      cwd: env.RSI_RUNNER_CWD,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
      log,
    });
  }
  log('RSI_RUNNER=UNCONFIGURED（未配置执行器：任务只会 BLOCK，不会 PASS）');
  return createUnconfiguredRunner(log);
}

/**
 * 把 verdict artifact 归一化为续跑引擎接受的取值。
 * 接受 `"PASS" | "REVISE" | "BLOCK"` 或 `{ verdict | status }`；无法识别 → null（不猜）。
 */
export function normalizeRsiVerdict(value: unknown): 'PASS' | 'REVISE' | 'BLOCK' | null {
  const raw = typeof value === 'string' ? value : (value as { verdict?: unknown; status?: unknown } | null)?.verdict ?? (value as { status?: unknown } | null)?.status;
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  return upper === 'PASS' || upper === 'REVISE' || upper === 'BLOCK' ? (upper as 'PASS' | 'REVISE' | 'BLOCK') : null;
}

export interface RsiRuntimeComposition {
  loop: RsiEventLoopHandle;
  controller: ReturnType<typeof attachContinuationToController>;
  publisher: RsiSnapshotPublisher | null;
  verdictWatcher: RsiVerdictWatcher | null;
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
  /** 默认 true：等裁决收口；测试可显式关闭以走「立即完成」。 */
  awaitVerdict?: boolean;
  intervalMs?: number;
  /** 配置后：周期性把健康 + 台账写成功 artifact（供 /admin/autonomy 只读）。 */
  adminSnapshot?: {
    path: string;
    write: (path: string, content: string) => Promise<void>;
    ledger: RsiCostLedger;
    healthProvider: () => RsiAdminHealth;
    usageProvider: () => RsiCostUsage;
  };
  /** 配置后：仅当运行时等待裁决时，短轮询 verdict artifact 并驱动续跑。 */
  verdictWatch?: { intervalMs?: number };
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
    runner: input.runner ?? createUnconfiguredRunner(),
    // RSI-RT-05：runner 结果只作提案，任务停在等待裁决，由 verdict 收口（REVISE 才会产出修订任务）。
    // 默认 false：没有裁决来源时 park 会让任务永远停在等待裁决；需要时由调用方显式开启。
    awaitVerdict: input.awaitVerdict ?? false,
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

  const publisher =
    input.adminSnapshot === undefined
      ? null
      : createAdminSnapshotPublisher({
          path: input.adminSnapshot.path,
          write: input.adminSnapshot.write,
          ledger: input.adminSnapshot.ledger,
          healthProvider: input.adminSnapshot.healthProvider,
          usageProvider: input.adminSnapshot.usageProvider,
          intervalMs: input.intervalMs ?? 60_000,
        });

  const verdictWatcher =
    input.verdictWatch === undefined
      ? null
      : createVerdictWatcher({
          readVerdict: async () => (await localSources.readVerdict?.()) ?? undefined,
          isWaiting: () => controller.state().waitingForVerdict,
          onVerdict: async () => {
            // 真实取值来自 artifact；无法识别则不设置（引擎会保持当前裁决，不会瞎猜）。
            const raw = await localSources.readVerdict?.();
            const parsed = normalizeRsiVerdict(raw);
            if (parsed !== null) controller.markWaitingForVerdict(parsed);
            await controller.emit('JUDGE_VERDICT_RECEIVED');
          },
          intervalMs: input.verdictWatch.intervalMs ?? 15_000,
        });

  return {
    loop,
    controller,
    publisher,
    verdictWatcher,
    start: () => {
      loop.start();
      publisher?.start();
      verdictWatcher?.start();
    },
    stop: () => {
      verdictWatcher?.stop();
      loop.stop();
      publisher?.stop();
    },
  };
}

export const RSI_RUNTIME_COMPOSITION_BOUNDARY = {
  eventDriven: true,
  watchdogFallbackOnly: true,
  defaultRunnerYieldsBlock: true,
  noopAutoPass: false,
  adminSnapshotIsReadOnlyArtifact: true,
  verdictPollOnlyWhileWaiting: true,
  parkForJudgeDefault: false,
  verdictValueFromArtifact: true,
  readsCredentials: false,
  writesDatabase: false,
  performsExternalWrite: false,
} as const;

const isDirectRun = process.argv[1] !== undefined && process.argv[1].includes('rsi-run');
if (isDirectRun) {
  void (async () => {
    const fsPromises = await import('node:fs/promises');
    const composition = await composeRsiRuntime({
      readFile: async (path) => fsPromises.readFile(path, 'utf8'),
      tasksPath: process.env.RSI_TASKS_PATH,
      ciResultsPath: process.env.RSI_CI_RESULTS_PATH,
      verdictPath: process.env.RSI_VERDICT_PATH,
      testResultsPath: process.env.RSI_TEST_RESULTS_PATH,
      runner: await resolveRunnerFromEnv(),
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
