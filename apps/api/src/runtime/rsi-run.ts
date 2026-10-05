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
import {
  runRsiRestartReconcile,
  type RsiReconcilePlan,
  type RsiReconcileStore,
  type RsiReconcileTrigger,
} from './rsi-restart-reconcile';
import {
  generateRsiWork,
  parseRsiSignals,
  type RsiGenerationResult,
} from '../services/autonomy/rsi-task-generator';
import {
  createRsiDomainPackRunner,
  describeRsiRuntimeMembers,
  type RsiDomainCapabilityPack,
} from './rsi-domain-pack';
import { createProductRecoverySiPack } from './recovery-si-product-composition';
import type { AppActionGuardDeps } from '../services/action-guard/runtime-guard-composition';
import type { RecoveryReadPorts } from '../services/intelligence/recovery-read-tools';
import type { RecoverySiTaskBinding } from './recovery-si-pack';

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
  /** 启动时运行一次重启/接管 reconcile；没有配置 store 时返回 null（NOT_CONFIGURED），不做任何事。 */
  reconcileNow(): Promise<RsiReconcilePlan | null>;
  /** RSI-P1-03：本次从信号 artifact 自动生成的任务（未配置或解析失败时为 null）。 */
  taskGeneration(): RsiGenerationResult | null;
  /** STEP_3：唯一产品运行时成员描述（架构回归用；`SECOND_RUNTIME = 0`）。 */
  runtimeMembers(): ReturnType<typeof describeRsiRuntimeMembers>;
  /** STEP_3：domain pack 派发记录（只读审计用）。 */
  domainDispatchLog(): readonly {
    taskId: string;
    packId: string;
    status: string;
    guardActions: readonly { action: string; decision: string }[];
  }[];
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
  /**
   * 可选：信号 artifact（RSI-P1-03 signal → incident/task）。缺失或畸形时**不生成任何任务**，
   * 绝不为了“有产出”而编造任务；OWNER 级（riskClass=HIGH）信号只登记，不进自动队列。
   */
  signalsPath?: string;
  /**
   * 可选：进程启动时先做一次 restart/接管 reconcile（lease 恢复 + 去重 + exactly-once）。
   * 没有 store 时不启用（默认 NOT_CONFIGURED），不会凭空写任何状态。
   */
  reconcile?: {
    store: RsiReconcileStore;
    ownerRef: string;
    trigger?: RsiReconcileTrigger;
  };
  /**
   * STEP_3（3A）：domain capability pack（例如 Recovery SI）。
   * 仅在**未显式注入 runner** 时作为唯一 runner 使用；未匹配任务判 BLOCK，绝不 PASS。
   */
  domainPacks?: readonly RsiDomainCapabilityPack[];
  /**
   * STEP 3 FINAL-4：**唯一 product 组装点** —— Recovery SI 固定接 shared guard adapter；
   * 只接受 shared guard 类型（RuntimeActionGuard / AppActionGuardDeps），不接受自定义 guard port。
   */
  productRecoveryPack?: {
    appActionGuardDeps: AppActionGuardDeps;
    readPorts: RecoveryReadPorts;
    bind: (task: { id: string; dedupeKey: string; priority: string }) => RecoverySiTaskBinding | null;
  };
}): Promise<RsiRuntimeComposition> {
  let tasks: readonly RsiSafeTask[] = [];
  if (input.tasksPath !== undefined) {
    try {
      tasks = parseTaskQueue(await input.readFile(input.tasksPath));
    } catch {
      tasks = []; // 缺失即空队列（静默）
    }
  }

  // RSI-P1-03：信号 artifact → 自动生成 incident/task（同因只建一次；OWNER 级只登记不自动执行）
  let generation: RsiGenerationResult | null = null;
  if (input.signalsPath !== undefined) {
    try {
      const signals = parseRsiSignals(await input.readFile(input.signalsPath));
      const known = tasks.flatMap((task) => [task.dedupeKey, `incident:${task.dedupeKey.replace(/^task:/, '')}`]);
      generation = generateRsiWork({ signals, knownDedupeKeys: known });
      const merged = [...tasks];
      for (const task of generation.tasks) {
        if (merged.some((existing) => existing.dedupeKey === task.dedupeKey)) continue;
        merged.push({ id: task.id, priority: task.priority, dedupeKey: task.dedupeKey });
      }
      tasks = merged;
    } catch {
      generation = null; // artifact 缺失/畸形 → fail-closed，不编造任务
    }
  }

  // STEP_3：domain pack 派发层（不创建第二个 runtime / scheduler）
  const productPack =
    input.productRecoveryPack === undefined
      ? null
      : createProductRecoverySiPack({
          appActionGuardDeps: input.productRecoveryPack.appActionGuardDeps,
          readPorts: input.productRecoveryPack.readPorts,
          bind: input.productRecoveryPack.bind as never,
        });
  const domainPackList = [
    ...(productPack === null ? [] : [productPack]),
    ...(input.domainPacks ?? []),
  ];
  // STEP 3 FINAL-5 CHANGE B：Recovery SI 为保留 pack id —— 只能经 productRecoveryPack 组装，
  // 通用 domainPacks 注入 'recovery-si' 一律拒绝（否则可用自定义 guard 绕过 Shared Action Guard）。
  const reservedPacks = (input.domainPacks ?? []).filter((pack) => pack.packId === 'recovery-si');
  if (reservedPacks.length > 0) {
    throw new Error(
      'RECOVERY_SI_RESERVED_PACK_ID_REJECTED:recovery-si（Recovery 只能经 productRecoveryPack 组装，禁止经 domainPacks 注入自定义 guard）',
    );
  }
  const domainRunner =
    domainPackList.length === 0 ? null : createRsiDomainPackRunner({ packs: domainPackList });
  const controller = attachContinuationToController({
    tasks,
    runner: input.runner ?? domainRunner ?? createUnconfiguredRunner(),
    // RSI-RT-05：runner 结果只作提案，任务停在等待裁决，由 verdict 收口（REVISE 才会产出修订任务）。
    // 默认 false：没有裁决来源时 park 会让任务永远停在等待裁决；需要时由调用方显式开启。
    // STEP 3 FINAL-2 CHANGE A：domainPacks 路径强制 park-for-judge（不可被 awaitVerdict=false 绕过）
    // STEP 3 FINAL-3 CHANGE A：domainPacks 路径**强制** park-for-judge（awaitVerdict:false 也不可绕过）
    awaitVerdict:
      input.domainPacks !== undefined && input.domainPacks.length > 0
        ? true
        : (input.awaitVerdict ?? false),
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

  const reconcileSpec = input.reconcile;
  return {
    loop,
    controller,
    publisher,
    verdictWatcher,
    taskGeneration: () => generation,
    runtimeMembers: () => describeRsiRuntimeMembers(domainPackList),
    domainDispatchLog: () => domainRunner?.dispatchLog() ?? [],
    async reconcileNow(): Promise<RsiReconcilePlan | null> {
      if (reconcileSpec === undefined) return null;
      return runRsiRestartReconcile({
        store: reconcileSpec.store,
        ownerRef: reconcileSpec.ownerRef,
        trigger: reconcileSpec.trigger ?? 'BOOT',
      });
    },
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
  /** FINAL-3：domainPacks 路径强制 park-for-judge，不可被 awaitVerdict=false 绕过 */
  domainPackAlwaysParksForJudge: true,
  verdictValueFromArtifact: true,
  restartReconcileSupported: true,
  signalDrivenTaskGeneration: true,
  ownerGatedTasksAutoExecuted: false,
  restartReconcileDefault: 'NOT_CONFIGURED',
  /** STEP_3：domain capability pack 由同一 runtime 消费（不新建 Recovery runtime） */
  domainCapabilityPacks: 'STATIC_COMPOSITION_ONLY（Recovery SI = domain pack）',
  /** FINAL-4：产品路径的 Recovery SI 只能经唯一 product 组装点（shared guard adapter 固定） */
  productRecoveryPackGuardWiring: 'SHARED_ACTION_GUARD_ADAPTER（FORBIDDEN: caller-supplied guard port）',
  /** FINAL-5：'recovery-si' 为保留 pack id；经通用 domainPacks 注入一律拒绝 */
  reservedRecoveryPackIdViaDomainPacks: 'REJECTED（RECOVERY_SI_RESERVED_PACK_ID_REJECTED）',
  /** FINAL-5：product/domainPack 任一存在即强制 park-for-judge（按最终组装列表判定） */
  parkForJudgeBasis: 'domainPackList.length > 0',
  secondRuntime: 0,
  domainPackUnmatchedYieldsBlock: true,
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
      signalsPath: process.env.RSI_SIGNALS_PATH,
      ciResultsPath: process.env.RSI_CI_RESULTS_PATH,
      verdictPath: process.env.RSI_VERDICT_PATH,
      testResultsPath: process.env.RSI_TEST_RESULTS_PATH,
      runner: await resolveRunnerFromEnv(),
      intervalMs: Number(process.env.RSI_WATCHDOG_INTERVAL_MS ?? 60_000),
    });
    const reconcile = await composition.reconcileNow();
    console.log(
      'RSI_RECONCILE=' +
        (reconcile === null
          ? 'NOT_CONFIGURED'
          : 'expiredLeases=' + reconcile.expiredLeaseIds.length +
            ' recoveredTasks=' + reconcile.recoveredTaskIds.length +
            ' heldActiveLeases=' + reconcile.heldActiveLeaseIds.length +
            ' idempotentNoop=' + reconcile.idempotentNoop),
    );
    const generated = composition.taskGeneration();
    console.log(
      'RSI_TASK_GENERATION=' +
        (generated === null
          ? 'NOT_CONFIGURED'
          : 'tasks=' + generated.tasks.length +
            ' ownerGated=' + generated.ownerGatedTasks.length +
            ' duplicates=' + generated.duplicates.length +
            ' truncated=' + generated.truncated),
    );
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
