/**
 * 真实执行器验收：未配置即 BLOCK（绝不 auto-PASS）；命令按退出码判定 PASS/REVISE；
 * 白名单与超时一律 BLOCK；证据只回摘要。
 */

import { describe, expect, it } from 'vitest';

import {
  createCommandRunner,
  createUnconfiguredRunner,
  RSI_TASK_RUNNER_BOUNDARY,
} from '../runtime/rsi-task-runner';
import type { RsiSafeTask } from '../services/autonomy/rsi-continuation-engine';

const task: RsiSafeTask = { id: 'A', priority: 'P1', dedupeKey: 'd:A' };
const node = process.execPath;
const HEX64 = /^[0-9a-f]{64}$/;

describe('RSI 真实执行器（rsi-task-runner）', () => {
  it('UNCONFIGURED_YIELDS_BLOCK：未配置执行器绝不返回 PASS', async () => {
    const log: string[] = [];
    const result = await createUnconfiguredRunner((line) => log.push(line)).run(task);
    expect(result.status).toBe('BLOCK');
    expect(result.evidenceRef).toBe('unconfigured');
    expect(log[0]).toContain('RSI_RUNNER_UNCONFIGURED');
    expect(log[0]).toContain('BLOCK');
    expect(log[0]).not.toContain('-> PASS');
  });

  it('EXIT_ZERO_IS_PASS_WITH_DIGEST_EVIDENCE：退出码 0 → PASS，证据为摘要而非原文', async () => {
    const result = await createCommandRunner({ command: node, args: ['-e', 'console.log("ok")'] }).run(task);
    expect(result.status).toBe('PASS');
    expect(result.exitCode).toBe(0);
    expect(result.evidenceRef.startsWith('exit-0:')).toBe(true);
    expect(result.stdoutDigest).toMatch(HEX64);
    expect(result.stderrDigest).toMatch(HEX64);
    expect(JSON.stringify(result)).not.toContain('ok'); // 原文不落证据
  });

  it('EXIT_NONZERO_IS_REVISE：非 0 退出 → REVISE（可重试失败，而非 PASS）', async () => {
    const result = await createCommandRunner({ command: node, args: ['-e', 'process.exit(3)'] }).run(task);
    expect(result.status).toBe('REVISE');
    expect(result.exitCode).toBe(3);
  });

  it('COMMAND_ALLOWLIST：白名单外的命令一律 BLOCK', async () => {
    const result = await createCommandRunner({ command: 'curl', args: ['http://example.invalid'] }).run(task);
    expect(result.status).toBe('BLOCK');
    expect(result.evidenceRef).toBe('not-allowed');
  });

  it('TIMEOUT_IS_BLOCK：超时 → BLOCK，不算 PASS', async () => {
    const result = await createCommandRunner({
      command: node,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      timeoutMs: 50,
    }).run(task);
    expect(result.status).toBe('BLOCK');
    expect(result.evidenceRef).toBe('timeout');
  });

  it('BOUNDARY：无 no-op auto-PASS、无 shell、证据只摘要', () => {
    expect(RSI_TASK_RUNNER_BOUNDARY.noopAutoPass).toBe(false);
    expect(RSI_TASK_RUNNER_BOUNDARY.unconfiguredYieldsBlock).toBe(true);
    expect(RSI_TASK_RUNNER_BOUNDARY.commandAllowlistOnly).toBe(true);
    expect(RSI_TASK_RUNNER_BOUNDARY.shellDisabled).toBe(true);
    expect(RSI_TASK_RUNNER_BOUNDARY.taskDataNeverBecomesCommand).toBe(true);
    expect(RSI_TASK_RUNNER_BOUNDARY.evidenceIsDigestOnly).toBe(true);
    expect(RSI_TASK_RUNNER_BOUNDARY.performsExternalWrite).toBe(false);
  });
});
