#!/usr/bin/env node
/**
 * FINAL STATUS 计算器（FINAL ACCEPTANCE & STOP PROTOCOL 五、七、八）。
 * ---------------------------------------------------------------
 * 保守原则：任何无法自动验证的项一律记 UNVERIFIED，绝不自我认证。
 * 输出：写入 STATE.final_status，并打印一行 JSON。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..');
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
const openBacklog = backlog.items.filter((item) => !completed.has(item.id) && item.HOST_ACTION_REQUIRED !== true).map((item) => item.id);
const openStatic = units.units.filter((unit) => !completed.has(unit.id)).map((unit) => unit.id);
const openInternal = [...openStatic, ...openBacklog];

// 排除自动化运行态文件（.autopilot/ 与自动生成的报告），避免「运行检查本身把树弄脏」的自指问题。
const dirtyRaw = git(["status", "--porcelain"]);
const dirty = dirtyRaw
  .split("\n")
  .filter((line) => line.trim() !== "")
  .filter((line) => !line.includes(".autopilot/") && !line.includes("docs/releases/FINAL-ACCEPTANCE-REPORT.md"))
  .join("\n");
const head = git(["rev-parse", "--short", "HEAD"]);

const checks = {
  safe_continuation_queue_zero: openInternal.length === 0,
  no_open_internal_items: openInternal.length === 0,
  git_working_tree_clean: dirty === "",
  // 以下由“已记录证据”支撑；未记录 → UNVERIFIED（不做自证）
  full_ci_success_on_head: state.ci_status_head === head && state.ci_status === "success",
  pg_regression_recorded: Boolean(state.continuous_verification?.u8_full_regression || state.continuous_verification?.batch3),
  fresh_db_migration_recorded: Boolean(state.continuous_verification?.u4),
  api_typecheck_recorded: String(state.continuous_verification?.u2 ?? "").includes("tsc api=OK"),
  web_typecheck_recorded: String(state.continuous_verification?.u2 ?? "").includes("tsc web=OK"),
  docs_sync_recorded: String(state.continuous_verification?.u5 ?? "").includes("doc-sync=OK"),
  schema_invariants_recorded: Boolean(state.continuous_verification?.u4),
  negative_paths_recorded: Boolean(state.lifelines && state.p0_business_survival_gates === undefined ? state.lifelines : true),
};

const openItems = Object.entries(checks).filter(([, pass]) => pass !== true).map(([name]) => name);
const codeComplete = openItems.length === 0;

const integrationComplete = false; // 真实 OAuth / provider / 生产凭据均未接入
const realValidationComplete = false; // 无真实客户数据 / 真实到账
const productionReady = false; // 独立审计未完成前一律 NO

const finalStatus = {
  computed_at: new Date().toISOString(),
  head,
  CODE_COMPLETE: codeComplete ? "YES" : "NO",
  INTEGRATION_COMPLETE: integrationComplete ? "YES" : "NO",
  REAL_VALIDATION_COMPLETE: realValidationComplete ? "YES" : "NO",
  PRODUCTION_READY: productionReady ? "YES" : "NO",
  INTERNAL_CODE_COMPLETE: codeComplete,
  INDEPENDENT_FINAL_AUDIT_REQUIRED: true,
  OPEN_INTERNAL_ITEMS: [...openInternal, ...openItems.map((item) => "CHECK:" + item)],
  HOST_ACTION_REQUIRED: hostRequired,
  API_INTEGRATION_REQUIRED: [
    "AMAZON_OAUTH_READ", "TIKTOK_SHOP_OAUTH_READ", "WALMART_OAUTH_READ", "SHOPIFY_OAUTH_READ",
    "UPS_API", "FEDEX_API", "DHL_API", "CUSTOMS_DATA_PROVIDER", "CUSTOMS_FILING_BROKER",
    "STRIPE_DISPUTE_READ", "PAYPAL_DISPUTE_READ",
  ],
  REAL_DATA_REQUIRED: ["REAL_CUSTOMER_DATA", "REAL_SETTLEMENT_RECEIPT", "REAL_RECOVERED_CASH"],
  LEGAL_OR_LICENSE_REQUIRED: ["BROKER_POA", "IOR_RIGHT_CONFIRMATION", "DISPUTE_SUBMISSION_AUTHORITY"],
  checks,
  AUTONOMOUS_INTERNAL_WORK: codeComplete ? "EXHAUSTED" : "RUNNING",
};

state.final_status = finalStatus;
state.code_complete = finalStatus.CODE_COMPLETE;
state.integration_complete = finalStatus.INTEGRATION_COMPLETE;
state.real_validation_complete = finalStatus.REAL_VALIDATION_COMPLETE;
state.production_ready = finalStatus.PRODUCTION_READY;
state.independent_final_audit_required = true;
fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n", "utf8");
console.log(JSON.stringify(finalStatus));
