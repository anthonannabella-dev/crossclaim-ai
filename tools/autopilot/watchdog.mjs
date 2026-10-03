#!/usr/bin/env node
/**
 * WATCHDOG（AUTOPILOT EXECUTION MODEL CORRECTION 2026-10-03）— RECOVERY_ONLY。
 * 职责：liveness 检查 + 崩溃恢复；**不做任务调度**。
 *   · runner 正常（lock 有效 + pid 存活 + 心跳新鲜）→ 不启动第二个 runner；
 *   · runner 死亡（pid 不存在）或心跳 stale 且仍有剩余任务 → 清理 stale lock 并恢复 runner；
 *   · 无剩余任务 → 不恢复。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { acquireLock, isPidAlive, readHeartbeatAgeMs, readLock, releaseLock, STALE_MS } from './lib/lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const STATE = path.join(ROOT, '.autopilot', 'STATE.json');
const UNITS_INDEX = path.join(ROOT, 'tools', 'autopilot', 'units', 'index.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const state = readJson(STATE, {});
const done = new Set(state.units_completed ?? []);
const units = readJson(UNITS_INDEX, { units: [] }).units.filter((unit) => !done.has(unit.id));
const lock = readLock(ROOT);
const heartbeatAgeMs = readHeartbeatAgeMs(ROOT);

const alive = lock ? isPidAlive(Number(lock.pid)) : false;
const fresh = heartbeatAgeMs < STALE_MS;

if (units.length === 0) {
  console.log('WATCHDOG=NO_REMAINING_TASKS (no restart)');
} else if (alive && fresh) {
  console.log('WATCHDOG=RUNNER_HEALTHY pid=' + lock.pid + ' heartbeatAgeMs=' + heartbeatAgeMs + ' (no second runner started)');
} else {
  console.log(
    'WATCHDOG=RUNNER_DEAD_OR_STALE alive=' + String(alive) + ' heartbeatAgeMs=' + heartbeatAgeMs + ' remainingUnits=' + units.length + ' → recovering',
  );
  if (lock && Number(lock.pid) !== process.pid) releaseLock(ROOT, { onlyIfPid: Number(lock.pid) });
  const child = spawn(process.execPath, [path.join(HERE, 'continuous-runner.mjs')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  console.log('WATCHDOG=RECOVERY_STARTED pid=' + child.pid);
}

void acquireLock;
