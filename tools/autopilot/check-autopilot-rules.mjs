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
  if (!/R12/.test(md)) failures.push('RULES.md 缺少 R12（Success Fee / Billing 永久红线）');
  if (!md.includes('Reobserved_not_billable') && !md.includes('≠ recovered ≠ billable')) {
    failures.push('RULES.md R12 缺少一句话红线（Reimbursement observed ≠ recovered ≠ billable）');
  }

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

// R11：平台 API 准入准备线（docs/platform-approval）必须存在，且覆盖五个平台
const platform = rules?.platform_api_approval_readiness ?? null;
if (!platform) {
  failures.push('rules.json 缺少 platform_api_approval_readiness（R11 未落盘）');
} else {
  for (const rel of platform.required_docs ?? []) {
    if (!fs.existsSync(path.join(ROOT, rel))) failures.push('缺少平台准备文档: ' + rel);
  }
  const matrixPath = path.join(ROOT, 'docs', 'platform-approval', 'PLATFORM_SCOPE_MATRIX.md');
  const matrixText = fs.existsSync(matrixPath) ? fs.readFileSync(matrixPath, 'utf8') : '';
  for (const key of ['AMAZON', 'TIKTOK_SHOP', 'WALMART', 'SHOPIFY', 'WOOCOMMERCE']) {
    const rel = platform.platform_matrices?.[key];
    if (!rel || !fs.existsSync(path.join(ROOT, rel))) failures.push('缺少平台 scope 矩阵: ' + key);
    const token = key === 'TIKTOK_SHOP' ? 'TIKTOK' : key;
    if (matrixText !== '' && !matrixText.toUpperCase().includes(token)) {
      failures.push('PLATFORM_SCOPE_MATRIX 未覆盖平台: ' + token);
    }
  }
  if (!Array.isArray(platform.platform_status_fields) || platform.platform_status_fields.length === 0) {
    failures.push('platform_api_approval_readiness 缺少 platform_status_fields');
  }
}

// R12_BLOCK：Success Fee / Billing 永久红线（HOST DIRECTIVE 2026-10-02）
const billingRedline = rules?.success_fee_billing_redline ?? null;
if (!billingRedline) {
  failures.push('rules.json 缺少 success_fee_billing_redline（R12 未落盘）');
} else {
  const rel = billingRedline.doc;
  if (!rel || !fs.existsSync(path.join(ROOT, rel))) failures.push('缺少 R12 规范文档: ' + rel);
  const doc = rel && fs.existsSync(path.join(ROOT, rel)) ? fs.readFileSync(path.join(ROOT, rel), 'utf8') : '';
  for (const token of ['Settlement = RECEIVED', 'billable', 'Payment Authorization Gate', 'FeeCalculation']) {
    if (!doc.includes(token)) failures.push('R12 文档缺少关键口径: ' + token);
  }
  for (const key of ['billable_predicate', 'forbidden', 'ai_forbidden_decisions', 'status_fields']) {
    if (!Array.isArray(billingRedline[key]) || billingRedline[key].length === 0) failures.push('success_fee_billing_redline 缺少非空数组: ' + key);
  }
  if (billingRedline.auto_debit_gate?.status !== 'HOLD') {
    failures.push('success_fee_billing_redline.auto_debit_gate.status 必须为 HOLD（自动扣款属独立 Gate）');
  }
}

if (failures.length > 0) {
  process.stderr.write('AUTOPILOT_RULES_CHECK_FAILED\n - ' + failures.join('\n - ') + '\n');
  process.exit(1);
}
process.stdout.write('AUTOPILOT_RULES_OK（rules.json + RULES.md + 送审记录契约一致）\n');
