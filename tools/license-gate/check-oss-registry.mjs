#!/usr/bin/env node
/**
 * CrossClaim · OSS 复用与商用许可统一校验（R10）
 * ------------------------------------------------------------------
 * 校验三件事（与既有 license-gate 同源，不新建第二套许可证系统）：
 *   1) .autopilot/rules.json 的 open_source_reuse 存在且完整（矩阵/登记表/等级/字段/LLM 禁区）；
 *   2) tools/license-gate/oss-registry.json 每条登记满足字段与等级一致性
 *      （A/B/C 等级、commercial_use_allowed、decision、REJECT 需理由、LEVEL C 不得 ACCEPT、
 *        带模型权重的组件不得 ACCEPT）；
 *   3) 登记表与 docs/releases/OPEN_SOURCE_REUSE_MATRIX.md 交叉一致（名称与分类都要出现）。
 * 用法：node tools/license-gate/check-oss-registry.mjs [--root .]
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
const ROOT = path.resolve(rootFlag >= 0 ? argv[rootFlag + 1] ?? '.' : '.');
const failures = [];

const rulesPath = path.join(ROOT, '.autopilot', 'rules.json');
if (!fs.existsSync(rulesPath)) failures.push('缺少 .autopilot/rules.json');
let reuse = null;
if (fs.existsSync(rulesPath)) {
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  reuse = rules.open_source_reuse ?? null;
  if (!reuse) failures.push('.autopilot/rules.json 缺少 open_source_reuse（R10 未落盘）');
}

if (reuse) {
  for (const key of ['matrix_path', 'registry_path', 'model_license_registry', 'checker', 'gate', 'allowlist']) {
    if (typeof reuse[key] !== 'string' || reuse[key].trim() === '') failures.push('open_source_reuse 缺少字段: ' + key);
  }
  for (const key of ['classes', 'dependency_fields', 'module_output_fields', 'llm_forbidden_decisions', 'peripheral_automation_deny', 'frozen_core']) {
    if (!Array.isArray(reuse[key]) || reuse[key].length === 0) failures.push('open_source_reuse 缺少非空数组: ' + key);
  }
  for (const cls of ['EXISTING', 'LEGACY_REUSE', 'OSS_NOW', 'OSS_LATER', 'REJECT']) {
    if (!(reuse.classes ?? []).includes(cls)) failures.push('classes 缺少: ' + cls);
  }
  for (const lvl of ['A', 'B', 'C']) {
    if (!reuse.license_levels || !Array.isArray(reuse.license_levels[lvl]) || reuse.license_levels[lvl].length === 0) {
      failures.push('license_levels 缺少等级: ' + lvl);
    }
  }
}

const registryPath = path.join(ROOT, 'tools', 'license-gate', 'oss-registry.json');
const matrixPath = path.join(ROOT, 'docs', 'releases', 'OPEN_SOURCE_REUSE_MATRIX.md');
for (const p of [registryPath, matrixPath, path.join(ROOT, 'MODEL_LICENSES.md')]) {
  if (!fs.existsSync(p)) failures.push('缺少文件: ' + path.relative(ROOT, p));
}

let matrixText = fs.existsSync(matrixPath) ? fs.readFileSync(matrixPath, 'utf8') : '';
const classes = reuse?.classes ?? ['EXISTING', 'LEGACY_REUSE', 'OSS_NOW', 'OSS_LATER', 'REJECT'];
for (const cls of classes) {
  if (matrixText !== '' && !matrixText.includes(cls)) failures.push('OPEN_SOURCE_REUSE_MATRIX 未覆盖分类: ' + cls);
}

if (fs.existsSync(registryPath)) {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const entries = Array.isArray(registry.entries) ? registry.entries : [];
  if (entries.length === 0) failures.push('oss-registry.json 没有 entries');
  const required = reuse?.dependency_fields ?? [];
  for (const item of entries) {
    const label = item.dependency_name ?? '(未命名)';
    for (const field of required) {
      const value = item[field];
      if (value === undefined || value === null || String(value).trim() === '') {
        failures.push(label + ' 缺少登记字段: ' + field);
      }
    }
    if (!classes.includes(item.class)) failures.push(label + ' class 非法: ' + item.class);
    if (!['A', 'B', 'C'].includes(item.license_category)) failures.push(label + ' license_category 必须是 A/B/C');
    if (!['YES', 'REVIEW', 'NO'].includes(item.commercial_use_allowed)) failures.push(label + ' commercial_use_allowed 必须是 YES/REVIEW/NO');
    if (!['ACCEPT', 'REVIEW', 'REJECT'].includes(item.decision)) failures.push(label + ' decision 必须是 ACCEPT/REVIEW/REJECT');
    if (item.decision === 'REJECT' && String(item.reason ?? '').trim().length < 10) failures.push(label + ' REJECT 必须给出理由');
    if (item.license_category === 'C' && item.decision === 'ACCEPT') failures.push(label + ' LEVEL C 不得 ACCEPT（默认禁止进入生产）');
    if (item.class === 'OSS_NOW') {
      if (!['ACCEPT', 'REVIEW'].includes(item.decision)) failures.push(label + ' OSS_NOW 的 decision 必须是 ACCEPT 或 REVIEW');
      if (item.decision === 'REVIEW' && !/模型|权重|许可/.test(String(item.reason ?? ''))) {
        failures.push(label + ' OSS_NOW + REVIEW 必须在 reason 里说明原因（如模型权重许可待核实）');
      }
    }
    if (item.model_weight_license && item.model_weight_license !== 'n/a' && item.decision === 'ACCEPT') {
      failures.push(label + ' 带模型权重（model_weight_license 非 n/a）时不得直接 ACCEPT —— 权重许可须先核实（LEVEL C 禁止进生产）');
    }
    if (matrixText !== '' && !matrixText.toLowerCase().includes(String(item.dependency_name).toLowerCase())) {
      failures.push(label + ' 未出现在 OPEN_SOURCE_REUSE_MATRIX 中（矩阵与登记表必须一致）');
    }
  }
}

if (failures.length > 0) {
  process.stderr.write('OSS_REUSE_LICENSE_CHECK_FAILED\n - ' + failures.join('\n - ') + '\n');
  process.exit(1);
}
process.stdout.write('OSS_REUSE_LICENSE_OK（R10 规则 + 矩阵 + 登记表 + 等级一致性）\n');
