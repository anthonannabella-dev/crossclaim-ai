/**
 * RSI Runtime —— 独立 Controller 进程入口（RSI-RT-01）
 * ---------------------------------------------------------------
 * 目标（OWNER《RSI Runtime》）：
 *   · 可独立启动 / 停止 / 健康检查 / 安全重启，**不依赖聊天窗口**；
 *   · 与 api / web 进程解耦：RSI 挂了主业务照常；
 *   · Kill Switch / 总开关关闭时**保持存活但空转**（不产生新任务），不退出、不影响主系统；
 *   · 无异常时静默（不打印噪声状态、不写库）。
 *
 * 本进程当前只做「只读扫描 + 健康暴露」：不写库、不调 provider、不读凭据。
 * 运行：`npm run rsi:dev`（tsx）或 `npm run rsi:start`（编译产物）。
 */

import { createServer, type Server } from 'node:http';

import {
  deriveHealthState,
  resolveRsiFlags,
  type RsiFlags,
  type RsiHealthState,
} from '../services/autonomy/rsi-runtime-config';

export interface RsiControllerState {
  health: RsiHealthState;
  startedAt: string;
  lastScanAt: string | null;
  scanCount: number;
  activeTasks: number;
  failedTasks: number;
  pendingOwnerApprovals: number;
}

export function rsiHealthPayload(flags: RsiFlags, state: RsiControllerState): Record<string, unknown> {
  return {
    service: 'crossclaim-rsi-controller',
    health: state.health,
    rsiEnabled: flags.enabled,
    killSwitch: flags.paused,
    stages: flags.stages,
    startedAt: state.startedAt,
    lastScanAt: state.lastScanAt,
    scanCount: state.scanCount,
    activeTasks: state.activeTasks,
    failedTasks: state.failedTasks,
    pendingOwnerApprovals: state.pendingOwnerApprovals,
    boundary: {
      externalWritePerformed: false,
      transportEnabled: false,
      productionCredentials: 'ABSENT',
      writesDatabase: false,
    },
  };
}

export interface RsiControllerHandle {
  state: RsiControllerState;
  healthServer: Server;
  stop: () => Promise<void>;
}

export function createRsiController(
  options: {
    env?: Record<string, string | undefined>;
    scanIntervalMs?: number;
    healthPort?: number;
    /** 只读扫描钩子（默认空转：无异常即静默）。可注入以做测试或接 Observer。 */
    onScan?: (state: RsiControllerState) => void | Promise<void>;
    now?: () => Date;
  } = {},
): RsiControllerHandle {
  const env = options.env ?? process.env;
  const flags = resolveRsiFlags(env);
  const now = options.now ?? (() => new Date());
  const scanIntervalMs = options.scanIntervalMs ?? 60_000;
  const healthPort = options.healthPort ?? Number(env.RSI_HEALTH_PORT ?? 4319);

  const state: RsiControllerState = {
    health: deriveHealthState(flags),
    startedAt: now().toISOString(),
    lastScanAt: null,
    scanCount: 0,
    activeTasks: 0,
    failedTasks: 0,
    pendingOwnerApprovals: 0,
  };

  const tick = async (): Promise<void> => {
    // Kill Switch / 总开关关闭 → 保持存活但空转（不建任务、不产生信号）。
    if (flags.paused || !flags.enabled) {
      state.health = 'PAUSED';
      return;
    }
    await options.onScan?.(state);
    state.lastScanAt = now().toISOString();
    state.scanCount += 1;
    state.health = deriveHealthState(flags);
  };

  const timer = setInterval(() => {
    void tick();
  }, scanIntervalMs);
  timer.unref?.();
  (state as RsiControllerState & { tick?: () => Promise<void> }).tick = tick;

  const healthServer = createServer((req, res) => {
    if (req.method !== 'GET' || (req.url ?? '') !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOT_FOUND' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(rsiHealthPayload(flags, state)));
  });
  // 只绑回环：健康检查不对外暴露，也不构成公开 API 面。
  healthServer.listen(healthPort, '127.0.0.1');

  const stop = async (): Promise<void> => {
    clearInterval(timer);
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  };

  return { state, healthServer, stop };
}

const isDirectRun = process.argv[1] !== undefined && process.argv[1].includes('rsi-controller');
if (isDirectRun) {
  const flags = resolveRsiFlags(process.env);
  const controller = createRsiController();
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`RSI_CONTROLLER_STOPPING signal=${signal}`);
    await controller.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  console.log(
    `RSI_CONTROLLER_STARTED health=${controller.state.health} enabled=${flags.enabled} paused=${flags.paused} ` +
      `healthPort=127.0.0.1:${process.env.RSI_HEALTH_PORT ?? 4319}`,
  );
}
