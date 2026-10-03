#!/usr/bin/env node
/**
 * FINAL-ACCEPTANCE-REPORT 生成器（协议六）· CHANGE B（MSG-20261003-135）
 * ---------------------------------------------------------------
 * 本文件不再是「手写矩阵」：所有验收行都从单一权威矩阵
 * `docs/releases/ACCEPTANCE-MATRIX.json` 派生，杜绝报告与 STATE 自相矛盾。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..');
const STATE = path.join(ROOT, '.autopilot', 'STATE.json');
const MATRIX = path.join(ROOT, 'docs', 'releases', 'ACCEPTANCE-MATRIX.json');
const OUT = path.join(ROOT, 'docs', 'releases', 'FINAL-ACCEPTANCE-REPORT.md');

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const state = readJson(STATE, {});
const matrix = readJson(MATRIX, { areas: [], open_internal_items: [], acceptance_head: 'unknown' });
const fs2 = state.final_status ?? {};
const row = (name, status, evidence, note) => '| ' + name + ' | ' + status + ' | ' + evidence + ' | ' + (note ?? '') + ' |';

const lines = [
  '# FINAL ACCEPTANCE REPORT（自动生成，请勿手改）',
  '',
  '- 生成时间：' + new Date().toISOString(),
  '- 单一权威矩阵：`docs/releases/ACCEPTANCE-MATRIX.json` @' + String(matrix.acceptance_head ?? 'unknown'),
  '- acceptance HEAD：`' + String(fs2.acceptance_head ?? fs2.head ?? matrix.acceptance_head ?? 'unknown') + '`',
  '- 协议：`docs/releases/FINAL-ACCEPTANCE-PROTOCOL.md`（三层验收；禁止自证）',
  '- 状态：CODE_COMPLETE=' + String(fs2.CODE_COMPLETE ?? 'NO') + ' · INTEGRATION_COMPLETE=' + String(fs2.INTEGRATION_COMPLETE ?? 'NO') + ' · REAL_VALIDATION_COMPLETE=' + String(fs2.REAL_VALIDATION_COMPLETE ?? 'NO') + ' · PRODUCTION_READY=' + String(fs2.PRODUCTION_READY ?? 'NO'),
  '- INTERNAL_READY=' + (String(fs2.CODE_COMPLETE ?? 'NO') === 'YES' ? 'YES' : 'NO') + '；AUTONOMOUS_INTERNAL_WORK=' + String(fs2.AUTONOMOUS_INTERNAL_WORK ?? 'RUNNING'),
  '- INDEPENDENT_FINAL_AUDIT_REQUIRED = TRUE（独立审计完成前不得置 PRODUCTION_READY=YES）',
  '',
  '## 1. 验收项（派生自 ACCEPTANCE-MATRIX.json）',
  '',
  '| 验收项 | 状态 | 证据 | 备注 |',
  '|---|---|---|---|',
  ...(matrix.areas ?? []).map((area) => row(area.area, area.status, area.evidence, area.note)),
  '',
  '## 2. 打开的内部项（SAFE_CONTINUATION_QUEUE）',
  '',
  ...((matrix.open_internal_items ?? []).length
    ? matrix.open_internal_items.map((item) => '- ' + item)
    : ['- （无）']),
  '',
  '### Layer 1 未通过检查（final-status 计算器输出；UNVERIFIED = 未绑定当前 HEAD 的实证）',
  '',
  ...Object.entries(fs2.checks ?? {})
    .filter(([, value]) => value && value.status !== true)
    .map(([id, value]) => '- ' + id + ' → ' + String(value.status) + '（' + String(value.evidence ?? '') + '）'),
  '',
  '## 3. 外部 / 宿主依赖（不得自证完成）',
  '',
  '### HOST_ACTION_REQUIRED',
  '',
  ...(fs2.HOST_ACTION_REQUIRED ?? []).map((item) => '- ' + item),
  '',
  '### API_INTEGRATION_REQUIRED',
  '',
  ...((matrix.external_gates_remaining ?? {}).api_integration_required ?? []).map((item) => '- ' + item),
  '',
  '### REAL_DATA_REQUIRED',
  '',
  ...((matrix.external_gates_remaining ?? {}).real_data_required ?? []).map((item) => '- ' + item),
  '',
  '### LEGAL_OR_LICENSE_REQUIRED',
  '',
  ...((matrix.external_gates_remaining ?? {}).legal_or_license_required ?? []).map((item) => '- ' + item),
  '',
  '### ARCH_REVIEW_REQUIRED',
  '',
  ...(((matrix.external_gates_remaining ?? {}).arch_review_required ?? []).length
    ? (matrix.external_gates_remaining ?? {}).arch_review_required.map((item) => '- ' + item)
    : ['- （无）']),
  '',
  '## 4. 边界',
  '',
  'Production Enablement=HOLD · External Write=HOLD · Real Money=HOLD · Customer Submission=HOLD · Production Credentials=HOST_ONLY',
];

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log('WROTE=' + OUT);
