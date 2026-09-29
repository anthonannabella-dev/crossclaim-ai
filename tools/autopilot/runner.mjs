#!/usr/bin/env node
/**
 * CrossClaim AUTOPILOT RUNNER（.autopilot 状态机的实际执行器）
 * 每轮：load STATE → inspect git HEAD → reconcile → 取下一个未完成 TASK → 写 HEARTBEAT → 输出下一步动作
 * 幂等、可恢复：可被任意调度器（含 Codex 心跳）无状态重复调用；崩溃后直接重跑。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = process.env.AUTOPILOT_ROOT ?? 'D:/crossclaim-ai';
const AP = ROOT + '/.autopilot';
const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};

const state = readJson(AP + '/STATE.json', { gate: 'UNKNOWN', status: 'UNKNOWN', head: null });
const tasksText = fs.readFileSync(AP + '/TASKS.md', 'utf8');
const pending = tasksText
  .split(/\r?\n/)
  .filter((line) => line.startsWith('- [ ]'))
  .map((line) => line.replace('- [ ] ', '').trim());

let head = 'UNKNOWN';
try {
  head = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
} catch (error) {
  head = 'GIT_UNAVAILABLE';
  state.last_error = String(error).slice(0, 300);
}

const reconcile = state.head === head ? 'IN_SYNC' : 'RECONCILE_REQUIRED';
if (reconcile === 'RECONCILE_REQUIRED' && head !== 'GIT_UNAVAILABLE') {
  // 不盲目覆盖：保留原值供审计，再对齐到实际 HEAD
  state.previous_head = state.head;
  state.head = head;
  state.status = 'RECONCILED';
  fs.writeFileSync(AP + '/STATE.json', JSON.stringify(state, null, 2) + '\n', 'utf8');
}

const heartbeat = {
  runner_status: pending.length > 0 ? 'RUNNING' : 'IDLE',
  current_gate: state.gate,
  current_task: state.current_task ?? pending[0] ?? null,
  current_head: head,
  last_action: state.last_action ?? 'resume-from-state',
  last_action_at: new Date().toISOString(),
  next_action: pending[0] ?? 'READY_FOR_REVIEW（队列清空→进入审计循环）',
  retry_count: Number(state.retry_count ?? 0),
  last_error: state.last_error ?? null,
  reconcile,
  remaining_tasks: pending.length,
  boundary: {
    production_enabled: false,
    external_write_enabled: false,
    real_money: false,
    customer_submission: false,
    production_credentials: 'HOST_ONLY',
  },
};
fs.writeFileSync(AP + '/HEARTBEAT.json', JSON.stringify(heartbeat, null, 2) + '\n', 'utf8');

// 恢复语义：STATE 与实际不一致时以 Git 为准，并把下一个任务写回 STATE.current_task
if (pending.length > 0) {
  state.current_task = pending[0];
  state.status = state.status === 'RECONCILED' ? 'RECONCILED' : 'IMPLEMENTING';
  fs.writeFileSync(AP + '/STATE.json', JSON.stringify(state, null, 2) + '\n', 'utf8');
}

process.stdout.write(JSON.stringify(heartbeat, null, 2) + '\n');
