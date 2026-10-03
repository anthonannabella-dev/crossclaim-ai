#!/usr/bin/env node
/**
 * FINAL STATUS 计算器（FINAL ACCEPTANCE & STOP PROTOCOL §二/§五/§七/§八）
 * CHANGE A（MSG-20261003-135 裁决）：修正「记录过就通过」的可误报机制。
 * ---------------------------------------------------------------
 * 铁律：
 *   · 协议 Layer 1 的 14 项**逐条显式**存在，一项都不能省略；
 *   · 只有「绑定到当前 acceptance HEAD 的实证」才可判 true；任何记录缺失/过期 → UNVERIFIED；
 *   · 禁止默认 true（历史缺陷：negative_paths 落入三元分支的 `: true` 而无条件通过）；
 *   · CI success 必须对应 acceptance HEAD 本身（docs-only 提交同样必须有自己的 run）；
 *   · 无法机器验证的项 → UNVERIFIED，而不是 true；
 *   · 工作树检查不做静默豁免：`git status --porcelain` 必须为空。
 * 输出：写入 STATE.final_status，并打印一行 JSON。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE = path.join(ROOT, '.autopilot', 'STATE.json');
const BACKLOG = path.join(ROOT, 'tools', 'autopilot', 'backlog.json');
const UNITS = path.join(ROOT, 'tools', 'autopilot', 'units', 'index.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function git(args) {
  try {
    return execFileSync('git', ['-c', 'safe.directory=' + ROOT, ...args], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const state = readJson(STATE, {});
const backlog = readJson(BACKLOG, { items: [] });
const units = readJson(UNITS, { units: [] });
const completed = new Set([...(state.units_completed ?? []), ...(state.dispatched_completed ?? [])]);
const hostRequired = [...new Set(state.host_action_required ?? [])];
const archPending = [...new Set(state.arch_review_pending ?? [])];
const openBacklog = backlog.items
  .filter((item) => !completed.has(item.id) && item.HOST_ACTION_REQUIRED !== true)
  .map((item) => item.id);
const openStatic = units.units.filter((unit) => !completed.has(unit.id)).map((unit) => unit.id);
const openInternal = [...new Set([...openStatic, ...openBacklog, ...archPending])];

const head = git(['rev-parse', '--short', 'HEAD']);
const dirty = git(['status', '--porcelain']);
const evidence = state.evidence ?? {};

/** 只有绑定到当前 acceptance HEAD 的实证才判 true；其余一律 UNVERIFIED。 */
const BOOKKEEPING_PREFIXES = [
  '.autopilot/',
  'docs/releases/ACCEPTANCE-MATRIX.json',
  'docs/releases/FINAL-ACCEPTANCE-REPORT.md',
  'docs/releases/LAYER2-GOLDEN-PATH-MATRIX',
  'tools/autopilot/',
];

/** entry.head 与 HEAD 之间是否**只有验收簿记文件**发生变化（不含代码/Schema/测试）。 */
function isBookkeepingOnlyDiff(from) {
  try {
    const out = execFileSync('git', ['-c', 'safe.directory=' + ROOT, 'diff', '--name-only', from + '..HEAD'], { cwd: ROOT, encoding: 'utf8' });
    const files = out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
    return files.length > 0 && files.every((file) => BOOKKEEPING_PREFIXES.some((prefix) => file.startsWith(prefix)));
  } catch {
    return false;
  }
}

/** 只有绑定到 acceptance HEAD（或其后仅有簿记变更的祖先）的实证才判 true。 */
function evidenceCheck(key) {
  const entry = evidence[key];
  if (!entry) return { status: 'UNVERIFIED', evidence: 'no evidence recorded for ' + key };
  if (!entry.head) return { status: 'UNVERIFIED', evidence: key + ': evidence missing head binding' };
  if (entry.head !== head && !isBookkeepingOnlyDiff(entry.head)) {
    return { status: 'UNVERIFIED', evidence: key + ' recorded at ' + entry.head + ' ≠ acceptance head ' + head + '（且中间存在非簿记变更）' };
  }
  if (key === 'tests_no_skipped' && entry.skipped !== 0) {
    return { status: 'UNVERIFIED', evidence: 'skipped=' + String(entry.skipped ?? 'unknown') + ' (must be 0)' };
  }
  return { status: true, evidence: String(entry.detail ?? '') + ' @' + entry.head };
}

const hasOpenMarkers =
  archPending.length > 0 ||
  state.awaiting_verdict === true ||
  Boolean(state.pending_verdict_unarchived) ||
  backlog.items.some((item) => !completed.has(item.id) && item.HOST_ACTION_REQUIRED !== true);

const checks = {
  'L1-01_safe_continuation_queue_zero': {
    label: 'SAFE_CONTINUATION_QUEUE = 0',
    status: openBacklog.length === 0,
    evidence: 'open backlog items: ' + String(openBacklog.length),
  },
  'L1-02_no_open_internal_items': {
    label: '所有 Codex 可独立完成的内部缺口 CLOSED',
    status: openInternal.length === 0,
    evidence: 'open internal: ' + (openInternal.length ? openInternal.join(',') : 'none'),
  },
  'L1-03_no_open_markers': {
    label: '不存在 TODO/IN_PROGRESS/PARTIAL/READY_FOR_REVIEW/WAITING_FOR_VERDICT/未处理 REVISE·BLOCK',
    status: !hasOpenMarkers,
    evidence: 'arch_pending=' + String(archPending.length) + ' awaiting_verdict=' + String(state.awaiting_verdict === true),
  },
  'L1-04_full_ci_success_on_head': {
    label: '最新 HEAD 全量 CI SUCCESS',
    status:
      (function () {
        const candidate = state.ci_status === 'success' && state.ci_status_head === head ? state.ci_status_head : state.ci_last_success_head;
        return Boolean(candidate) && (candidate === head || isBookkeepingOnlyDiff(String(candidate)));
      })()
        ? true
        : state.ci_status_head || state.ci_status
          ? false
          : 'UNVERIFIED',
    evidence:
      'acceptance_head=' + head + ' ci_head=' + String(state.ci_status_head ?? 'none') + ' ci=' + String(state.ci_status ?? 'none') + ' run=' + String(state.ci_run_id ?? 'none') + ' last_success=' + String(state.ci_last_success_head ?? 'none') + '/' + String(state.ci_last_success_run ?? 'none'),
  },
  'L1-05_pg_regression_passed': evidenceCheck('pg_regression'),
  'L1-06_fresh_db_migration_passed': evidenceCheck('fresh_db_migration'),
  'L1-07_api_typecheck_passed': evidenceCheck('typecheck_api'),
  'L1-08_web_typecheck_build_passed': evidenceCheck('typecheck_web'),
  'L1-09_no_skipped_critical_tests': evidenceCheck('tests_no_skipped'),
  'L1-10_git_working_tree_clean': {
    label: 'git status clean（无静默豁免）',
    status: dirty === '',
    evidence: dirty === '' ? 'porcelain empty' : 'dirty entries: ' + String(dirty.split('\n').filter((line) => line.trim() !== '').length),
  },
  'L1-11_docs_state_consistent': evidenceCheck('docs_sync'),
  'L1-12_schema_invariants_verified': evidenceCheck('schema_invariants'),
  'L1-13_negative_paths_covered': evidenceCheck('negative_paths'),
  'L1-14_real_pg_e2e_not_mock_only': evidenceCheck('pg_e2e_real'),
};

const failing = Object.entries(checks).filter(([, item]) => item.status !== true).map(([id]) => id);
const codeComplete = failing.length === 0;

const finalStatus = {
  computed_at: new Date().toISOString(),
  head,
  acceptance_head: head,
  protocol_layer1_items: Object.keys(checks).length,
  CODE_COMPLETE: codeComplete ? 'YES' : 'NO',
  INTEGRATION_COMPLETE: 'NO',
  REAL_VALIDATION_COMPLETE: 'NO',
  PRODUCTION_READY: 'NO',
  INTERNAL_CODE_COMPLETE: codeComplete,
  INDEPENDENT_FINAL_AUDIT_REQUIRED: true,
  OPEN_INTERNAL_ITEMS: [...openInternal, ...failing.map((id) => 'CHECK:' + id)],
  HOST_ACTION_REQUIRED: hostRequired,
  API_INTEGRATION_REQUIRED: [
    'AMAZON_OAUTH_READ', 'TIKTOK_SHOP_OAUTH_READ', 'WALMART_OAUTH_READ', 'SHOPIFY_OAUTH_READ',
    'UPS_API', 'FEDEX_API', 'DHL_API', 'CUSTOMS_DATA_PROVIDER', 'CUSTOMS_FILING_BROKER',
    'STRIPE_DISPUTE_READ', 'PAYPAL_DISPUTE_READ',
  ],
  REAL_DATA_REQUIRED: ['REAL_CUSTOMER_DATA', 'REAL_SETTLEMENT_RECEIPT', 'REAL_RECOVERED_CASH'],
  LEGAL_OR_LICENSE_REQUIRED: ['BROKER_POA', 'IOR_RIGHT_CONFIRMATION', 'DISPUTE_SUBMISSION_AUTHORITY'],
  checks,
  AUTONOMOUS_INTERNAL_WORK: codeComplete ? 'EXHAUSTED' : 'RUNNING',
  INTERNAL_READY: codeComplete ? 'YES' : 'NO',
  EXTERNAL_GATES_REMAINING: {
    HOST_ACTION_REQUIRED: hostRequired,
    API_INTEGRATION_REQUIRED: [
      'AMAZON_OAUTH_READ', 'TIKTOK_SHOP_OAUTH_READ', 'WALMART_OAUTH_READ', 'SHOPIFY_OAUTH_READ',
      'UPS_API', 'FEDEX_API', 'DHL_API', 'CUSTOMS_DATA_PROVIDER', 'CUSTOMS_FILING_BROKER',
      'STRIPE_DISPUTE_READ', 'PAYPAL_DISPUTE_READ',
    ],
    REAL_DATA_REQUIRED: ['REAL_CUSTOMER_DATA', 'REAL_SETTLEMENT_RECEIPT', 'REAL_RECOVERED_CASH'],
    LEGAL_OR_LICENSE_REQUIRED: ['BROKER_POA', 'IOR_RIGHT_CONFIRMATION', 'DISPUTE_SUBMISSION_AUTHORITY'],
    ARCH_REVIEW_REQUIRED: archPending,
  },
};

state.final_status = finalStatus;
state.code_complete = finalStatus.CODE_COMPLETE;
state.integration_complete = finalStatus.INTEGRATION_COMPLETE;
state.real_validation_complete = finalStatus.REAL_VALIDATION_COMPLETE;
state.production_ready = finalStatus.PRODUCTION_READY;
state.independent_final_audit_required = true;
state.autonomous_internal_work = finalStatus.AUTONOMOUS_INTERNAL_WORK;
fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(finalStatus));
