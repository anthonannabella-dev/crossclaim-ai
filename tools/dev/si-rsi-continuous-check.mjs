#!/usr/bin/env node
/**
 * CrossClaim · SI/RSI 开发任务检测器（无人输入，由 Windows 计划任务每 180 秒触发）
 * ---------------------------------------------------------------
 * 设计边界：
 *   · **不调用任何模型**（成本有界）；只做状态检测、单实例互斥、日志与唤醒标记；
 *   · 真正的代码开发由 Codex 会话（心跳唤醒）执行，本脚本只负责「发现并标记」；
 *   · 不创建第二套产品 Runtime；不触碰生产；不 push；不修改封板分支。
 *
 * 产物：
 *   · tools/dev/continuous-execution-state.json —— 机器可读 checkpoint（下一次待执行单元）
 *   · tools/dev/WAKE_REQUIRED.flag               —— 存在即表示有未完成开发单元（供模型侧读取）
 *   · tools/dev/logs/continuous-check.log        —— 每次运行一行（UTC 时间 / 结果 / 退出码）
 *   · tools/dev/.continuous-check.lock           —— 单实例锁（含 PID 与时间；过期可接管）
 *
 * 用法：node tools/dev/si-rsi-continuous-check.mjs [--root <repo>] [--force]
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const ROOT = path.resolve(argValue('--root', path.resolve(process.cwd())));
const FORCE = args.includes('--force');

const DEV_DIR = path.join(ROOT, 'tools', 'dev');
const LOG_DIR = path.join(DEV_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'continuous-check.log');
const STATE_FILE = path.join(DEV_DIR, 'continuous-execution-state.json');
const FLAG_FILE = path.join(DEV_DIR, 'WAKE_REQUIRED.flag');
const LOCK_FILE = path.join(DEV_DIR, '.continuous-check.lock');
const LOCK_STALE_MS = 5 * 60 * 1000;

const utc = () => new Date().toISOString();

const DEFAULT_STATE = {
  version: 1,
  branch: 'feat/si-rsi-customer-autonomous-recovery-v1',
  headAtLastCheck: null,
  runCount: 0,
  lastCheckAt: null,
  lastResult: null,
  lastExitCode: null,
  openChanges: [
    


    { id: 'AUDIT-P2-FINAL', phase: 2, title: 'PHASE 2 FINAL 复审（AUDIT_PENDING：上轮发送动作失败，需重投）', priority: 'P0', status: 'OPEN' },
    { id: 'C5', phase: 2, title: 'PHASE 2：Recovery pack 生产装配', priority: 'P0', status: 'CODE_DONE_PENDING_AUDIT' },
  ],
  closedChanges: ['C1', 'C2', 'C3', 'C4', 'C6', 'C7', 'AUDIT-P1', 'P2-CHANGE1', 'P2-CHANGE2', 'P2-CHANGE3', 'P2-CHANGE4'],
  phases: { '1': 'CLOSED', '2': 'IN_PROGRESS', '3': 'NOT_STARTED', '4': 'NOT_STARTED', '5': 'NOT_STARTED', '6': 'NOT_STARTED' },
  lastAudit: { id: 'MSG-20261008-17', verdict: 'PASS_WITH_REVISE (PHASE1_CLOSED=PASS)', reviewedHead: 'cd555f26' },
};

const log = (line) => {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(LOG_FILE, line + '\n', 'utf8');
};

const readState = () => {
  if (!existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_STATE };
  }
};

/** 单实例锁：新鲜锁 ⇒ 直接退出（避免重复调度）；过期锁 ⇒ 接管 */
const acquireLock = () => {
  if (existsSync(LOCK_FILE)) {
    try {
      const age = Date.now() - statSync(LOCK_FILE).mtimeMs;
      if (age < LOCK_STALE_MS && !FORCE) return { ok: false, reason: 'LOCKED_FRESH', ageMs: age };
      unlinkSync(LOCK_FILE);
    } catch {
      /* 忽略：下一步会重新创建 */
    }
  }
  try {
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: utc() }), { encoding: 'utf8', flag: 'wx' });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'LOCKED_RACE' };
  }
};

const releaseLock = () => {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    /* 已释放 */
  }
};

const git = (gitArgs) => {
  try {
    return execFileSync('git', ['-c', `safe.directory=${ROOT}`, '-C', ROOT, ...gitArgs], { encoding: 'utf8' }).trim();
  } catch (error) {
    return 'GIT_ERROR:' + String(error && error.code ? error.code : error);
  }
};

const lock = acquireLock();
if (!lock.ok) {
  log(`${utc()} result=SKIPPED reason=${lock.reason} exitCode=0`);
  process.exit(0);
}

let exitCode = 0;
let result = 'OK';
try {
  mkdirSync(DEV_DIR, { recursive: true });
  const state = readState();
  const head = git(['rev-parse', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = git(['status', '--porcelain']);
  const next = (state.openChanges ?? []).find((c) => c.status !== 'CLOSED') ?? null;

  const updated = {
    ...state,
    branch,
    headAtLastCheck: head,
    runCount: (state.runCount ?? 0) + 1,
    lastCheckAt: utc(),
    lastResult: next === null ? 'ALL_CLOSED' : `NEXT=${next.id}`,
    lastExitCode: 0,
  };
  writeFileSync(STATE_FILE, JSON.stringify(updated, null, 2) + '\n', 'utf8');

  if (next === null) {
    if (existsSync(FLAG_FILE)) unlinkSync(FLAG_FILE);
    result = 'ALL_CLOSED';
  } else {
    writeFileSync(
      FLAG_FILE,
      JSON.stringify({ at: utc(), head, branch, nextUnit: next, dirty: dirty !== '' }, null, 2) + '\n',
      'utf8',
    );
    result = `NEXT=${next.id}`;
  }
  log(`${utc()} result=${result} head=${head.slice(0, 8)} branch=${branch} dirty=${dirty !== ''} run=${updated.runCount} exitCode=0`);
} catch (error) {
  exitCode = 1;
  result = 'ERROR';
  log(`${utc()} result=ERROR message=${String(error && error.message ? error.message : error).slice(0, 200)} exitCode=1`);
} finally {
  releaseLock();
}

process.exit(exitCode);
