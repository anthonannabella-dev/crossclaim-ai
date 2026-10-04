/**
 * RSI Task Runner（真实可注入执行器）
 * ---------------------------------------------------------------
 * 修复的核心缺陷：此前未注入 runner 时使用 **no-op runner** 且直接返回 `PASS`，
 * 直接运行路径也只是写一行日志后返回 `PASS` —— 任务「仅被 claimed 就 PASS」，等于伪造成功。
 *
 * 本模块提供三种 runner：
 *   1) createUnconfiguredRunner() —— 未配置执行器时返回 `BLOCK`（绝不 PASS）；
 *   2) createCommandRunner()      —— 真实执行一条**受白名单约束**的命令，按退出码判定 PASS/BLOCK，
 *                                    并把 stdout/stderr 摘要（sha256）+ 退出码 + 耗时作为证据返回；
 *   3) loadRunnerFromModule()     —— 从宿主指定的模块路径注入自定义 runner（可注入执行 Runner）。
 *
 * 安全边界：
 *   · 命令与参数来自**配置**（环境变量/组合根），绝不来自 task 数据；
 *   · 仅允许白名单可执行文件（node/npx/npm/git/bash/sh/psql），其余一律 BLOCK；
 *   · 不使用 shell（shell:false），避免注入；
 *   · 超时即 BLOCK；不读凭据、不写库、不做任何外部写（由被执行的命令自身负责其边界）；
 *   · 证据摘要只含 hash 与元数据，不落完整 stdout/stderr（避免把敏感内容写进日志）。
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

import type { RsiTaskRunner } from './rsi-controller-continuation';
import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';

export type RsiRunnerStatus = 'PASS' | 'REVISE' | 'BLOCK';

export interface RsiRunnerEvidence {
  status: RsiRunnerStatus;
  /** 证据引用：`cmd:<sha256:12>` 或 `unconfigured` / `timeout` / `not-allowed` 等稳定 token。 */
  evidenceRef: string;
  exitCode?: number | null;
  durationMs?: number;
  stdoutDigest?: string;
  stderrDigest?: string;
}

export interface RsiEvidenceRunner extends RsiTaskRunner {
  run(task: RsiSafeTask): Promise<RsiRunnerEvidence>;
}

/** 允许被执行的命令白名单（basename）。任何不在其中的命令一律拒绝。 */
export const RSI_RUNNER_ALLOWED_COMMANDS = ['node', 'npx', 'npm', 'git', 'bash', 'sh', 'psql'] as const;

export const RSI_RUNNER_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** 未配置执行器：诚实返回 BLOCK，绝不把「已领取」当成「已成功」。 */
export function createUnconfiguredRunner(log?: (line: string) => void): RsiEvidenceRunner {
  return {
    async run(task) {
      log?.(`RSI_RUNNER_UNCONFIGURED claimed=${task.id} -> BLOCK（未配置真实执行器，不判定 PASS）`);
      return { status: 'BLOCK', evidenceRef: 'unconfigured' };
    },
  };
}

export interface RsiCommandRunnerInput {
  command: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * 真实执行器：按退出码判定。0 → PASS；非 0 → REVISE（可重试的失败）；
 * 超时/无法启动 → BLOCK。证据只回摘要。
 */
export function createCommandRunner(input: RsiCommandRunnerInput): RsiEvidenceRunner {
  const basename = (String(input.command ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() ?? '')
    .replace(/\.(exe|cmd|bat)$/i, '')
    .toLowerCase();
  const allowed = (RSI_RUNNER_ALLOWED_COMMANDS as readonly string[]).includes(basename);

  return {
    async run(task: RsiSafeTask): Promise<RsiRunnerEvidence> {
      if (!allowed) {
        input.log?.(`RSI_RUNNER_NOT_ALLOWED command=${basename || '(empty)'} claimed=${task.id} -> BLOCK`);
        return { status: 'BLOCK', evidenceRef: 'not-allowed' };
      }
      const timeoutMs = input.timeoutMs ?? RSI_RUNNER_DEFAULT_TIMEOUT_MS;
      const started = Date.now();
      return await new Promise<RsiRunnerEvidence>((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const child = spawn(input.command, [...(input.args ?? [])], {
          cwd: input.cwd,
          shell: false,
          // 不额外注入任何凭据；继承宿主环境由运行者自行负责其最小权限。
          env: process.env,
        });
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          input.log?.(`RSI_RUNNER_TIMEOUT claimed=${task.id} timeoutMs=${timeoutMs} -> BLOCK`);
          resolve({ status: 'BLOCK', evidenceRef: 'timeout', durationMs: Date.now() - started });
        }, timeoutMs);
        const finish = (status: RsiRunnerStatus, evidenceRef: string, exitCode: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const stdoutDigest = digest(stdout);
          const stderrDigest = digest(stderr);
          input.log?.(
            `RSI_RUNNER_RESULT claimed=${task.id} status=${status} exit=${exitCode} ` +
              `stdout=${stdoutDigest.slice(0, 12)} stderr=${stderrDigest.slice(0, 12)}`,
          );
          resolve({
            status,
            evidenceRef: `${evidenceRef}:${stdoutDigest.slice(0, 12)}`,
            exitCode,
            durationMs: Date.now() - started,
            stdoutDigest,
            stderrDigest,
          });
        };
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', () => finish('BLOCK', 'spawn-failed', null));
        child.on('close', (code) => finish(code === 0 ? 'PASS' : 'REVISE', code === 0 ? 'exit-0' : 'exit-nonzero', code));
      });
    },
  };
}

/** 从宿主指定模块注入自定义 runner（模块需导出 `createRsiTaskRunner` 或 `rsiTaskRunner`）。 */
export async function loadRunnerFromModule(
  spec: string,
  log?: (line: string) => void,
): Promise<RsiEvidenceRunner | null> {
  try {
    const mod = (await import(spec)) as Record<string, unknown>;
    const candidate =
      typeof mod.createRsiTaskRunner === 'function'
        ? (mod.createRsiTaskRunner as () => RsiTaskRunner)()
        : (mod.rsiTaskRunner as RsiTaskRunner | undefined);
    if (candidate === undefined || typeof candidate.run !== 'function') {
      log?.(`RSI_RUNNER_MODULE_INVALID spec=${spec} -> BLOCK`);
      return null;
    }
    log?.(`RSI_RUNNER_MODULE_LOADED spec=${spec}`);
    return candidate as RsiEvidenceRunner;
  } catch {
    log?.(`RSI_RUNNER_MODULE_LOAD_FAILED spec=${spec} -> BLOCK`);
    return null;
  }
}

export const RSI_TASK_RUNNER_BOUNDARY = {
  noopAutoPass: false,
  unconfiguredYieldsBlock: true,
  commandAllowlistOnly: true,
  shellDisabled: true,
  taskDataNeverBecomesCommand: true,
  evidenceIsDigestOnly: true,
  readsCredentials: false,
  writesDatabase: false,
  performsExternalWrite: false,
} as const;
