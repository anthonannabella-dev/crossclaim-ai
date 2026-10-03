#!/usr/bin/env node
/**
 * GLOBAL BACKLOG DISPATCHER（AUTOPILOT FINAL GAP 2026-10-03）
 * ---------------------------------------------------------------
 * · 静态单元（tools/autopilot/units/index.json）耗尽时，从 tools/autopilot/backlog.json
 *   自动选择「最高优先级、未完成、当前安全可执行」的下一项并 materialize 为可执行单元。
 * · HOST_ACTION_REQUIRED / ARCH_REVIEW 项：登记后跳过，继续寻找其它安全任务。
 * · 选择顺序：P0/P1 未关闭 → 当前 Gate 未关闭 → 已批准 GLOBAL GAP →
 *   平台/Carrier/Customs/Independent-site/Settlement-Billing 内部链 → 回归/文档/发布证据。
 * 用法：node tools/autopilot/dispatcher.mjs [--peek]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const STATE = path.join(ROOT, '.autopilot', 'STATE.json');
const BACKLOG = path.join(ROOT, 'tools', 'autopilot', 'backlog.json');
const MATERIALIZED = path.join(ROOT, '.autopilot', 'units-materialized');

const peek = process.argv.includes('--peek');

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

function priorityRank(priority) {
  return priority === 'P0' ? 0 : priority === 'P1' ? 1 : priority === 'P2' ? 2 : 3;
}

const state = readJson(STATE, {});
const done = new Set([...(state.units_completed ?? []), ...(state.dispatched_completed ?? []), ...(state.host_action_required ?? [])]);
const backlogFile = readJson(BACKLOG, { items: [] });

const candidates = backlogFile.items
  .filter((item) => !done.has(item.id))
  .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority));

const safe = candidates.filter((item) => item.HOST_ACTION_REQUIRED !== true);
const hostOnly = candidates.filter((item) => item.HOST_ACTION_REQUIRED === true);

if (peek) {
  console.log(JSON.stringify({ ok: true, next: safe[0]?.id ?? null, hostPending: hostOnly.map((item) => item.id) }));
  process.exit(0);
}

if (safe.length === 0) {
  const registered = [...new Set([...(state.host_action_required ?? []), ...hostOnly.map((item) => item.id)])];
  state.host_action_required = registered;
  writeJson(STATE, state);
  if (hostOnly.length > 0) {
    console.log('DISPATCHER_HOST_ACTION_REQUIRED_PENDING=' + hostOnly.map((item) => item.id).join(','));
  } else {
    console.log('DISPATCHER_BACKLOG_EMPTY');
  }
  console.log(JSON.stringify({ ok: false, reason: hostOnly.length > 0 ? 'HOST_ACTION_REQUIRED_ONLY' : 'BACKLOG_EMPTY', hostPending: hostOnly.map((item) => item.id) }));
  process.exit(0);
}

const selected = safe[0];
const metadata = {
  id: selected.id,
  source_backlog_id: selected.source_backlog_id,
  title: selected.title,
  scope: selected.scope,
  acceptance_criteria: selected.acceptance_criteria,
  dependencies: selected.dependencies,
  risk_class: selected.risk_class,
  ARCH_REVIEW_REQUIRED: selected.ARCH_REVIEW_REQUIRED,
  HOST_ACTION_REQUIRED: selected.HOST_ACTION_REQUIRED,
  HOLD_EXTERNAL: selected.HOLD_EXTERNAL,
  allowed_files: selected.allowed_files,
  boundary: selected.boundary,
  required_tests: selected.required_tests,
  priority: selected.priority,
  template: selected.template,
  filters: selected.filters ?? [],
};

const templateName = selected.template === "doc-sync" ? "doc-sync" : selected.template === "host-required-register" ? "host-required-register" : "suite-evidence";
fs.mkdirSync(MATERIALIZED, { recursive: true });
const unitPath = path.join(MATERIALIZED, selected.id + '.mjs');
const header = [
  "/** materialized by GLOBAL BACKLOG DISPATCHER（source_backlog_id=" + metadata.source_backlog_id + "） */",
  "import { run as templateRun } from \"../../tools/autopilot/unit-templates/" + templateName + ".mjs\";",
  "export const metadata = " + JSON.stringify(metadata, null, 2) + ";",
  "export async function run(context) { return templateRun({ ...context, metadata }); }",
  "",
].join("\n");
fs.writeFileSync(unitPath, header, "utf8");

state.dispatched_units = [...new Set([...(state.dispatched_units ?? []), selected.id])];
writeJson(STATE, state);

console.log('DISPATCHER_MATERIALIZED=' + selected.id + ' template=' + templateName);
console.log(JSON.stringify({ ok: true, id: selected.id, unitPath, metadata }));
