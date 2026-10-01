#!/usr/bin/env node
/**
 * AUTOPILOT 持久自治规则校验（.autopilot/RULES.md + .autopilot/rules.json）
 * ----------------------------------------------------------------------
 * 强制 HOST DIRECTIVE 2026-10-01：
 *   1) 规则文件必须存在且包含三项状态字段（会话 / runner 重启后不得丢失）；
 *   2) 送审记录（STATE.*_submission）必须给出 FOUNDATION_REUSED / NEW_RISK_BOUNDARY / ARCH_REVIEW_REQUIRED；
 *   3) ARCH_REVIEW_REQUIRED = YES 的送审记录必须点名 R2 的 8 类触发之一（防止把已 PASS 底座再次送审）；
 *   4) 规则必须声明「无新裁决不是停止条件」与合法停止条件集合。
 * 用法：node tools/autopilot/check-autopilot-rules.mjs [--root .]
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
const ROOT = path.resolve(rootFlag >= 0 ? argv[rootFlag + 1] ?? '.' : '.');
const AP = path.join(ROOT, '.autopilot');
const failures = [];

const rulesMdPath = path.join(AP, 'RULES.md');
const rulesJsonPath = path.join(AP, 'rules.json');
const statePath = path.join(AP, 'STATE.json');

if (!fs.existsSync(rulesMdPath)) failures.push('MISSING .autopilot/RULES.md');
else {
  const md = fs.readFileSync(rulesMdPath, 'utf8');
  for (const field of ['FOUNDATION_REUSED', 'NEW_RISK_BOUNDARY', 'ARCH_REVIEW_REQUIRED']) {
    if (!md.includes(field)) failures.push('RULES.md 缺少状态字段: ' + field);
  }
  if (!/持久自治规则/.test(md)) failures.push('RULES.md 未声明为持久自治规则');
}

let rules = null;
if (!fs.existsSync(rulesJsonPath)) failures.push('MISSING .autopilot/rules.json');
else {
  try {
    rules = JSON.parse(fs.readFileSync(rulesJsonPath, 'utf8'));
  } catch (error) {
    failures.push('rules.json 解析失败: ' + String(error));
  }
}

if (rules) {
  for (const key of ['frozen_foundation', 'arch_review_triggers', 'status_fields', 'allowed_stop_conditions']) {
    if (!Array.isArray(rules[key]) || rules[key].length === 0) failures.push('rules.json 缺少非空数组: ' + key);
  }
  if (rules.incremental_audit !== true) failures.push('rules.json 未开启 incremental_audit');
  if (rules.continue_when_arch_review_required_false !== true) {
    failures.push('rules.json 未声明 continue_when_arch_review_required_false=true');
  }
  if (rules.no_verdict_is_not_stop !== true) failures.push('rules.json 未声明 no_verdict_is_not_stop=true');
}

if (rules && fs.existsSync(statePath)) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const triggers = rules.arch_review_triggers ?? [];
  const enforced = new Set(rules.enforced_from_submission_keys ?? []);
  for (const [key, value] of Object.entries(state)) {
    if (!key.endsWith('_submission') || value === null || typeof value !== 'object') continue;
    if (value.submitted_under_rules !== true && !enforced.has(key)) continue;
    const rc = value.risk_classification;
    if (!rc || typeof rc !== 'object') {
      failures.push(key + ' 缺少 risk_classification（FOUNDATION_REUSED / NEW_RISK_BOUNDARY / ARCH_REVIEW_REQUIRED）');
      continue;
    }
    for (const field of ['FOUNDATION_REUSED', 'NEW_RISK_BOUNDARY', 'ARCH_REVIEW_REQUIRED']) {
      if (typeof rc[field] !== 'string' || rc[field].trim() === '') failures.push(key + ' 缺少 ' + field);
    }
    const arch = String(rc.ARCH_REVIEW_REQUIRED ?? '');
    if (/^YES/i.test(arch)) {
      const blob = JSON.stringify(value);
      const hit = triggers.some((trigger) => blob.includes(trigger));
      if (!hit) {
        failures.push(key + ' 声明 ARCH_REVIEW_REQUIRED=YES 但未点名 R2 的任一触发项（禁止把已 PASS 底座重复送审）');
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write('AUTOPILOT_RULES_CHECK_FAILED\n - ' + failures.join('\n - ') + '\n');
  process.exit(1);
}
process.stdout.write('AUTOPILOT_RULES_OK（rules.json + RULES.md + 送审记录契约一致）\n');
