
/**
 * Singleton runner lock（AUTOPILOT EXECUTION MODEL CORRECTION 2026-10-03）。
 *  · 同一时刻只允许一个 active runner（防止两个 runner 并发操作同一仓库）。
 *  · lock 文件：.autopilot/RUNNER.lock（JSON：pid / startedAt / host / mode）。
 *  · 判定：
 *      - lock 存在且 pid 存活且心跳新鲜 → 已有 active runner → 不启动第二实例；
 *      - lock 存在但 pid 不存在（或心跳过期）→ stale → 清理后恢复执行。
 */

import fs from 'node:fs';
import path from 'node:path';

export const LOCK_PATH = '.autopilot/RUNNER.lock';
export const HEARTBEAT_PATH = '.autopilot/HEARTBEAT.json';
export const STALE_MS = 10 * 60 * 1000; // 10 分钟无心跳视为 stale

export function readHeartbeatAgeMs(root) {
  try {
    const raw = fs.readFileSync(path.join(root, HEARTBEAT_PATH), 'utf8');
    const parsed = JSON.parse(raw);
    const at = Date.parse(parsed.tick_at ?? parsed.updated_at ?? parsed.last_tick_at ?? '');
    if (Number.isNaN(at)) return Number.POSITIVE_INFINITY;
    return Date.now() - at;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function readLock(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, LOCK_PATH), 'utf8'));
  } catch {
    return null;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

/** 返回 { acquired, reason, stale? }；acquired=false 表示已有 active runner。 */
export function acquireLock(root, { mode = 'CONTINUOUS', heartbeatAgeMs = readHeartbeatAgeMs(root) } = {}) {
  const existing = readLock(root);
  if (existing) {
    const alive = isPidAlive(Number(existing.pid));
    const fresh = heartbeatAgeMs < STALE_MS;
    if (alive && fresh) {
      return { acquired: false, reason: 'ACTIVE_RUNNER_PRESENT', existing };
    }
    if (alive && !fresh) {
      return { acquired: false, reason: 'RUNNER_ALIVE_BUT_HEARTBEAT_STALE', existing };
    }
    // stale → 清理
    fs.rmSync(path.join(root, LOCK_PATH), { force: true });
  }
  const lock = { pid: process.pid, startedAt: new Date().toISOString(), host: process.env.COMPUTERNAME ?? 'unknown', mode };
  fs.mkdirSync(path.dirname(path.join(root, LOCK_PATH)), { recursive: true });
  fs.writeFileSync(path.join(root, LOCK_PATH), JSON.stringify(lock, null, 2) + '\n', 'utf8');
  return { acquired: true, reason: 'LOCK_ACQUIRED', lock };
}

export function releaseLock(root, { onlyIfPid = process.pid } = {}) {
  const existing = readLock(root);
  if (!existing) return false;
  if (Number(existing.pid) !== Number(onlyIfPid)) return false;
  fs.rmSync(path.join(root, LOCK_PATH), { force: true });
  return true;
}
