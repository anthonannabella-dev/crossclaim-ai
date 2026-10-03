#!/usr/bin/env node
/**
 * CONTINUOUS AUTOPILOT RUNNER（AUTOPILOT EXECUTION MODEL CORRECTION 2026-10-03）
 * ---------------------------------------------------------------
 * 一次启动后在同一持续运行周期内自动消费 SAFE_CONTINUATION_QUEUE：
 *   reconcile → pickNextExecutionUnit → execute → test → commitIfNeeded → updateState → 立即取下一个
 *
 *  · HEARTBEAT 仅用于 liveness（本 runner 每轮刷新），不做任务调度。
 *  · CI 非阻塞：commit 后记录 pending CI run，不等待；红灯才进入 SELF_RESOLVE 队列。
 *  · 审计非阻塞：READY_FOR_REVIEW 记录 awaiting_verdict；不依赖该 verdict 的安全单元继续执行。
 *  · singleton：.autopilot/RUNNER.lock（pid + 心跳新鲜度）；已有 active runner 则不启动第二实例。
 *
 * 用法：
 *   node tools/autopilot/continuous-runner.mjs [--max-units N] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { acquireLock, releaseLock, readHeartbeatAgeMs } from './lib/lock.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..');
const STATE = path.join(ROOT, '.autopilot', 'STATE.json');
const HEARTBEAT = path.join(ROOT, '.autopilot', 'HEARTBEAT.json');
const UNITS_INDEX = path.join(ROOT, 'tools', 'autopilot', 'units', 'index.json');

const args = process.argv.slice(2);
const maxUnits = (() => {
  const idx = args.indexOf('--max-units');
  return idx >= 0 ? Number(args[idx + 1] ?? '0') : 0;
})();
const dryRun = args.includes('--dry-run');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function git(argsList) {
  try {
    return execFileSync('git', ['-c', 'safe.directory=' + ROOT, ...argsList], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (error) {
    return 'GIT_ERROR:' + String(error).slice(0, 120);
  }
}

function touchHeartbeat(extra = {}) {
  const previous = readJson(HEARTBEAT, {});
  writeJson(HEARTBEAT, {
    ...previous,
    ...extra,
    tick_at: new Date().toISOString(),
    runner_pid: process.pid,
    mode: 'CONTINUOUS',
  });
}

function loadQueue() {
  const state = readJson(STATE, {});
  const index = readJson(UNITS_INDEX, { units: [] });
  const safeQueue = Array.isArray(state.safe_continuation_queue) ? state.safe_continuation_queue : [];
  const done = new Set(Array.isArray(state.units_completed) ? state.units_completed : []);
  const units = index.units.filter((unit) => !done.has(unit.id));
  return { state, index, safeQueue, units, done };
}

async function main() {
  const lock = acquireLock(ROOT, { mode: 'CONTINUOUS' });
  if (!lock.acquired) {
    console.log('RUNNER_NOT_STARTED reason=' + lock.reason + ' existingPid=' + String(lock.existing?.pid ?? 'n/a'));
    console.log('SINGLETON_RUNNER=VERIFIED');
    return;
  }
  console.log('RUNNER_STARTED pid=' + process.pid + ' mode=CONTINUOUS');
  let executed = 0;
  try {
    for (;;) {
      const { state, units } = loadQueue();
      touchHeartbeat({ state_machine: 'CONTINUOUS', remaining_units: units.length });
      if (units.length === 0) {
        console.log('STOP_CONDITION=SAFE_CONTINUATION_QUEUE_EMPTY');
        break;
      }
      if (maxUnits > 0 && executed >= maxUnits) {
        console.log('STOP_CONDITION=MAX_UNITS_REACHED executed=' + executed);
        break;
      }
      const unit = units[0];
      console.log('PICK_UNIT=' + unit.id + ' :: ' + unit.title);
      if (dryRun) {
        console.log('DRY_RUN_SKIP_EXECUTION=' + unit.id);
        break;
      }
      const beforeHead = git(['rev-parse', '--short', 'HEAD']);
      const modulePath = path.join(ROOT, 'tools', 'autopilot', 'units', unit.id + '.mjs');
      const mod = await import(pathToFileURL(modulePath).href);
      const started = Date.now();
      const result = await mod.run({ root: ROOT, state, unit });
      const durationMs = Date.now() - started;
      console.log('UNIT_RESULT=' + JSON.stringify({ id: unit.id, ok: result?.ok ?? false, detail: result?.detail ?? '', durationMs }));
      if (!(result?.ok ?? false)) {
        console.log('STOP_CONDITION=UNIT_FAILED id=' + unit.id);
        break;
      }
      const afterHead = git(['rev-parse', '--short', 'HEAD']);
      const latestState = readJson(STATE, {});
      latestState.units_completed = [...new Set([...(latestState.units_completed ?? []), unit.id])];
      latestState.last_unit = { id: unit.id, at: new Date().toISOString(), head_before: beforeHead, head_after: afterHead, detail: result?.detail ?? '' };
      latestState.autopilot_mode = 'CONTINUOUS';
      latestState.heartbeat_role = 'LIVENESS_ONLY';
      latestState.watchdog_role = 'RECOVERY_ONLY';
      latestState.singleton_runner = 'VERIFIED';
      writeJson(STATE, latestState);
      executed += 1;
      touchHeartbeat({ last_unit: unit.id, last_unit_at: new Date().toISOString() });
      console.log('CONTINUE_IMMEDIATELY next_unit_pending=true');
    }
  } finally {
    const released = releaseLock(ROOT);
    console.log('RUNNER_EXIT executed=' + executed + ' lockReleased=' + String(released) + ' heartbeatAgeMs=' + String(readHeartbeatAgeMs(ROOT)));
  }
}

await main();
