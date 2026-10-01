#!/usr/bin/env node
/**
 * CrossClaim AUTOPILOT RUNNER（.autopilot 状态机的实际执行器）
 * 每轮：load STATE → inspect git HEAD → reconcile → 取下一个未完成 TASK → 写 HEARTBEAT → 输出下一步动作
 * 幂等、可恢复：可被任意调度器（含 Codex 心跳）无状态重复调用；崩溃后直接重跑。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = process.env.AUTOPILOT_ROOT ?? 'D:/crossclaim-ai';

/** 调度自检（宿主 2026-10-01）：tick 间隔与 stale 判定；不新建第二套 runner。 */
const AUTOPILOT_INTERVAL_MINUTES = Number(process.env.AUTOPILOT_INTERVAL_MINUTES ?? 5);
const STALE_AFTER_MS = 2 * AUTOPILOT_INTERVAL_MINUTES * 60_000;
const AP = ROOT + '/.autopilot';
const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};

const state = readJson(AP + '/STATE.json', { gate: 'UNKNOWN', status: 'UNKNOWN', head: null });
/** .autopilot 持久自治规则（宿主 Directive 2026-10-01）：缺失即视为规则丢失，必须显式回执 */
const AUTOPILOT_RULES = readJson(AP + '/rules.json', null);
if (!AUTOPILOT_RULES) state.rules_missing = true;
else delete state.rules_missing;
const tasksText = fs.readFileSync(AP + '/TASKS.md', 'utf8');
const pending = tasksText
  .split(/\r?\n/)
  .filter((line) => line.startsWith('- [ ]'))
  .map((line) => line.replace('- [ ] ', '').trim());

let head = 'UNKNOWN';
try {
  head = execSync(`git -c safe.directory=${ROOT} rev-parse --short HEAD`, { cwd: ROOT }).toString().trim();
  if (state.last_error) delete state.last_error; // 成功即清除陈旧错误（watchdog 语义）
} catch (error) {
  head = 'GIT_UNAVAILABLE';
  state.last_error = String(error).slice(0, 300);
}

const reconcile = state.head === head ? 'IN_SYNC' : 'RECONCILE_REQUIRED';

/** stale 判定：距上次真实 tick 超过 2×INTERVAL → 判定调度器停摆（不静默）。 */
const nowIso = new Date().toISOString();
const lastTickAt = typeof state.last_tick_at === 'string' ? Date.parse(state.last_tick_at) : Number.NaN;
const tickGapMs = Number.isFinite(lastTickAt) ? Date.now() - lastTickAt : Number.POSITIVE_INFINITY;
const scheduleStale = tickGapMs > STALE_AFTER_MS;
state.automation_status = 'ACTIVE';
state.last_tick_at = nowIso;
state.schedule_check = {
  intervalMinutes: AUTOPILOT_INTERVAL_MINUTES,
  staleAfterMinutes: AUTOPILOT_INTERVAL_MINUTES * 2,
  previousTickAt: Number.isFinite(lastTickAt) ? new Date(lastTickAt).toISOString() : null,
  gapMs: Number.isFinite(tickGapMs) ? tickGapMs : null,
  stale: scheduleStale,
  checkedAt: nowIso,
};
if (scheduleStale) {
  state.stale_recovered_at = nowIso;
  state.last_action = `SCHEDULER_STALE_RECOVERED（gap=${Number.isFinite(tickGapMs) ? Math.round(tickGapMs / 60000) + 'min' : 'unknown'}）→ 本轮已恢复执行`;
}
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
  automation_status: 'ACTIVE',
  interval_minutes: AUTOPILOT_INTERVAL_MINUTES,
  tick_at: nowIso,
  schedule_stale_previous: scheduleStale,
  state_machine: state.state ?? null,
  next_action: state.next_action ?? pending[0] ?? null,
  continue_required: (state.state ?? '') === 'IMPLEMENT' && Boolean(state.next_action),
  rules_loaded: Boolean(AUTOPILOT_RULES),
  platform_readiness_policy: {
    track: AUTOPILOT_RULES?.platform_api_approval_readiness?.track ?? null,
    dir: AUTOPILOT_RULES?.platform_api_approval_readiness?.dir ?? null,
    v1_policy: AUTOPILOT_RULES?.platform_api_approval_readiness?.v1_policy ?? null,
    priority_p1: AUTOPILOT_RULES?.platform_api_approval_readiness?.priorities?.P1 ?? [],
    priority_p2: AUTOPILOT_RULES?.platform_api_approval_readiness?.priorities?.P2 ?? [],
    priority_p3_later: AUTOPILOT_RULES?.platform_api_approval_readiness?.priorities?.P3_LATER ?? [],
    evidence_rule: AUTOPILOT_RULES?.platform_api_approval_readiness?.evidence_rule ?? null,
    host_approval_required: AUTOPILOT_RULES?.platform_api_approval_readiness?.host_approval_required ?? [],
    status_fields: AUTOPILOT_RULES?.platform_api_approval_readiness?.platform_status_fields ?? [],
  },
  customs_broker_policy: {
    directive: AUTOPILOT_RULES?.customs_broker_connector?.directive ?? null,
    contract_doc: AUTOPILOT_RULES?.customs_broker_connector?.contract_doc ?? null,
    abstraction: AUTOPILOT_RULES?.customs_broker_connector?.abstraction ?? null,
    transports: AUTOPILOT_RULES?.customs_broker_connector?.transports ?? [],
    crossclaim_is_customs_broker:
      AUTOPILOT_RULES?.customs_broker_connector?.licensed_boundary?.crossclaim_is_customs_broker ?? null,
    authorization_domains:
      AUTOPILOT_RULES?.customs_broker_connector?.authorization_domains?.domains ?? [],
    refund_funds: AUTOPILOT_RULES?.customs_broker_connector?.refund_funds ?? null,
    queue_impact: AUTOPILOT_RULES?.customs_broker_connector?.queue_impact ?? null,
  },
  payment_authorization_policy: {
    directive: AUTOPILOT_RULES?.payment_authorization_separation?.directive ?? null,
    contract_doc: AUTOPILOT_RULES?.payment_authorization_separation?.contract_doc ?? null,
    headline: AUTOPILOT_RULES?.payment_authorization_separation?.headline ?? null,
    onboarding_flow: AUTOPILOT_RULES?.payment_authorization_separation?.onboarding_flow ?? [],
    auto_charge_chain: AUTOPILOT_RULES?.payment_authorization_separation?.auto_charge_chain ?? [],
    without_authorization: AUTOPILOT_RULES?.payment_authorization_separation?.without_authorization ?? null,
    activation_gate: AUTOPILOT_RULES?.payment_authorization_separation?.activation_gate ?? null,
    queue_impact: AUTOPILOT_RULES?.payment_authorization_separation?.queue_impact ?? null,
  },
  billing_redline_policy: {
    directive: AUTOPILOT_RULES?.success_fee_billing_redline?.directive ?? null,
    doc: AUTOPILOT_RULES?.success_fee_billing_redline?.doc ?? null,
    headline: AUTOPILOT_RULES?.success_fee_billing_redline?.headline ?? null,
    allowed_chain: AUTOPILOT_RULES?.success_fee_billing_redline?.allowed_chain ?? [],
    billable_predicate: AUTOPILOT_RULES?.success_fee_billing_redline?.billable_predicate ?? [],
    forbidden: AUTOPILOT_RULES?.success_fee_billing_redline?.forbidden ?? [],
    auto_debit_gate: AUTOPILOT_RULES?.success_fee_billing_redline?.auto_debit_gate ?? null,
    queue_impact: AUTOPILOT_RULES?.success_fee_billing_redline?.queue_impact ?? null,
  },
  reuse_policy: {
    matrix_path: AUTOPILOT_RULES?.open_source_reuse?.matrix_path ?? null,
    registry_path: AUTOPILOT_RULES?.open_source_reuse?.registry_path ?? null,
    classes: AUTOPILOT_RULES?.open_source_reuse?.classes ?? [],
    license_levels: Object.keys(AUTOPILOT_RULES?.open_source_reuse?.license_levels ?? {}),
    status_fields: AUTOPILOT_RULES?.open_source_reuse?.module_output_fields ?? [],
    llm_forbidden_decisions: AUTOPILOT_RULES?.open_source_reuse?.llm_forbidden_decisions ?? [],
  },
  arch_review_policy: {
    rules_file: AUTOPILOT_RULES?.rules_file ?? '.autopilot/RULES.md',
    incremental_audit: AUTOPILOT_RULES?.incremental_audit ?? null,
    continue_when_no_new_risk: AUTOPILOT_RULES?.continue_when_arch_review_required_false ?? null,
    no_verdict_is_not_stop: AUTOPILOT_RULES?.no_verdict_is_not_stop ?? null,
    frozen_foundation_count: Array.isArray(AUTOPILOT_RULES?.frozen_foundation)
      ? AUTOPILOT_RULES.frozen_foundation.length
      : 0,
    arch_review_triggers: AUTOPILOT_RULES?.arch_review_triggers ?? [],
    allowed_stop_conditions: AUTOPILOT_RULES?.allowed_stop_conditions ?? [],
    forbidden_stop_reasons: AUTOPILOT_RULES?.forbidden_stop_reasons ?? [],
    status_fields: AUTOPILOT_RULES?.status_fields ?? [],
  },
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
if (state.state === 'IMPLEMENT' && state.next_action) {
  // 宿主规则：IMPLEMENT 且有 next_action → 本轮必须继续执行，不得停在「下一轮执行」
  heartbeat.continue_required = true;
}
fs.writeFileSync(AP + '/STATE.json', JSON.stringify(state, null, 2) + '\n', 'utf8');

if (pending.length > 0) {
  state.current_task = pending[0];
  state.status = state.status === 'RECONCILED' ? 'RECONCILED' : 'IMPLEMENTING';
  fs.writeFileSync(AP + '/STATE.json', JSON.stringify(state, null, 2) + '\n', 'utf8');
}

process.stdout.write(JSON.stringify(heartbeat, null, 2) + '\n');
