#!/usr/bin/env node
/**
 * ACCEPTANCE MATRIX（CHANGE B · MSG-20261003-135）
 * ---------------------------------------------------------------
 * 单一权威验收矩阵：`docs/releases/ACCEPTANCE-MATRIX.json`。
 * 其余三份来源必须与它一致：
 *   · .autopilot/STATE.json（open backlog / arch_pending / final_status）
 *   · docs/releases/MASTER-GAP-CLOSURE-REGISTER.md
 *   · docs/releases/FINAL-ACCEPTANCE-REPORT.md（由本矩阵派生，不再手写）
 *
 * 用法：
 *   node tools/autopilot/acceptance-matrix.mjs --write
 *   node tools/autopilot/acceptance-matrix.mjs            # 只打印
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs', 'releases', 'ACCEPTANCE-MATRIX.json');
const STATE = path.join(ROOT, '.autopilot', 'STATE.json');
const BACKLOG = path.join(ROOT, 'tools', 'autopilot', 'backlog.json');

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const git = (args) => {
  try {
    return execFileSync('git', ['-c', 'safe.directory=' + ROOT, ...args], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

/** 单一权威区域矩阵（人类维护的唯一处；报告与 guard 均由此派生）。 */
const AREAS = [
  { id: 'p0_business_survival_gates', area: 'P0 Business Survival Gates', layer: 1, status: 'CLOSED', evidence: 'MSG-20261003-132；lifelines A/B CLOSED' },
  { id: 'platform_recovery', area: 'Platform Recovery', layer: 2, status: 'COVERED', evidence: 'BG-001 只读闭环 + qualification 只读投影（CHANGE A）+ runtime HTTP E2E；critical-state read surface', note: '内部 Golden Path = COVERED；真实 OAuth adapter = Layer 3 API_INTEGRATION_REQUIRED（HOLD）' },
  { id: 'logistics_carrier', area: 'Logistics / Carrier Recovery', layer: 2, status: 'COVERED', evidence: 'u6 carrier 289 用例 + BG-009 只读对账 7/7 + carrier response critical-state 面', note: '内部链 = COVERED；真实 provider = Layer 3 API_INTEGRATION_REQUIRED（HOLD）' },
  { id: 'customs', area: 'Customs / Trade Recovery', layer: 2, status: 'COVERED', evidence: 'G4 C1–C7 CLOSED + BG-012 chain trigger + BG-020 只读读模型（事实 + 四类 latest 投影，PG 4/4）+ BG-019 关键状态面', note: '内部链 = COVERED；真实 filing / broker = HOLD_EXTERNAL' },
  { id: 'independent_site', area: 'Independent-site / Chargeback', layer: 2, status: 'COVERED', evidence: 'BG-010 只读链 + BG-021 事实层（PG 8/8）+ Phase-1 只读投影与 producer（PG 3/3）+ state read surface（PG 6/6）+ runtime HTTP E2E', note: '内部链 = COVERED（submitted ≠ won ≠ settled ≠ recovered ≠ billable）；真实 PSP 提交 = API/LEGAL/HOST' },
  { id: 'evidence_graph', area: 'Evidence Graph', layer: 2, status: 'INTERNAL_COMPLETE', evidence: 'BG-007 71 用例' },
  { id: 'qualification', area: 'Qualification', layer: 2, status: 'CLOSED', evidence: 'GATE B CLOSED；11/11 + PG 5/5 + 后端强制 Gate；IOR readiness 接线（BG-014）' },
  { id: 'settlement', area: 'Settlement（只读对账）', layer: 2, status: 'INTERNAL_COMPLETE', evidence: 'BG-009 7/7（APPROVED/PAID ≠ RECEIVED）', note: '真实到账 = HOLD' },
  { id: 'ledger_fee_billing', area: 'RecoveryLedger / 15% Fee / Billing', layer: 2, status: 'INTERNAL_COMPLETE', evidence: 'u7 资金链 287 用例', note: '真实扣费 = HOLD' },
  { id: 'action_guard', area: 'Action Guard', layer: 1, status: 'INTERNAL_COMPLETE', evidence: 'action-guard 套件 + 注册表' },
  { id: 'tenant_isolation', area: 'Tenant Isolation', layer: 1, status: 'VERIFIED', evidence: 'tenant 触发器清单 + psql 校验' },
  { id: 'rbac', area: 'RBAC', layer: 1, status: 'VERIFIED', evidence: 'permissions 矩阵 + HTTP E2E 403' },
  { id: 'idempotency_concurrency_recovery', area: 'Idempotency / Concurrency / Failure Recovery', layer: 1, status: 'VERIFIED', evidence: 'C17 13/13；platform-write CAS；u7 套件' },
  { id: 'fresh_db_migration', area: 'Fresh DB Migration', layer: 1, status: 'VERIFIED', evidence: 'u4 deploy-smoke（空库全迁移）' },
  { id: 'db_constraints', area: 'DB Constraints', layer: 1, status: 'VERIFIED', evidence: 'db-constraint-coverage + 运行库 psql' },
  { id: 'backend_http_wiring', area: 'Backend HTTP wiring', layer: 2, status: 'INTERNAL_COMPLETE', evidence: '路由契约 implemented=92 / documented=79 OK；BG-020 + BG-019 端点均已接线并有 runtime E2E', note: '真实外部 provider 接线属 Layer 3（HOLD）' },
  { id: 'frontend_wiring', area: 'Frontend wiring', layer: 2, status: 'INTERNAL_COMPLETE', evidence: '四域 critical-state read surface（Customs / Carrier / Platform / Independent-site）+ 命名的 runtime HTTP E2E 证据；架构方判四域 frontend cell 全 COVERED（MSG-20261003-143）', note: '' },
  { id: 'full_ci', area: 'Full CI', layer: 1, status: 'VERIFIED', evidence: '每 commit GitHub Actions（HEAD 绑定见 STATE.ci_status_head）' },
  { id: 'documentation_sync', area: 'Documentation sync', layer: 1, status: 'VERIFIED', evidence: 'u5 doc-sync 5 checks OK；BG-004' },
  { id: 'security_credential_boundary', area: 'Security / Credential boundary', layer: 1, status: 'VERIFIED', evidence: '无凭据落库；Trust guard；HOST_ONLY' },
  { id: 'production_integrations', area: 'Production integrations', layer: 3, status: 'HOST_ACTION_REQUIRED', evidence: 'BG-006 已登记；未执行任何生产动作' },
];

const state = readJson(STATE, {});
const backlog = readJson(BACKLOG, { items: [] });
const completed = new Set([...(state.units_completed ?? []), ...(state.dispatched_completed ?? [])]);
const openBacklog = backlog.items.filter((item) => !completed.has(item.id) && item.HOST_ACTION_REQUIRED !== true).map((item) => item.id);
const openInternalItems = [...new Set([...openBacklog, ...(state.arch_review_pending ?? [])])];

const matrix = {
  generated_at: new Date().toISOString(),
  acceptance_head: git(['rev-parse', '--short', 'HEAD']),
  protocol: 'docs/releases/FINAL-ACCEPTANCE-PROTOCOL.md',
  areas: AREAS,
  open_internal_items: openInternalItems,
  host_action_required: [...new Set(state.host_action_required ?? [])],
  external_gates_remaining: {
    api_integration_required: [
      'AMAZON_OAUTH_READ', 'TIKTOK_SHOP_OAUTH_READ', 'WALMART_OAUTH_READ', 'SHOPIFY_OAUTH_READ',
      'UPS_API', 'FEDEX_API', 'DHL_API', 'CUSTOMS_DATA_PROVIDER', 'CUSTOMS_FILING_BROKER',
      'STRIPE_DISPUTE_READ', 'PAYPAL_DISPUTE_READ',
    ],
    real_data_required: ['REAL_CUSTOMER_DATA', 'REAL_SETTLEMENT_RECEIPT', 'REAL_RECOVERED_CASH'],
    legal_or_license_required: ['BROKER_POA', 'IOR_RIGHT_CONFIRMATION', 'DISPUTE_SUBMISSION_AUTHORITY'],
    arch_review_required: [...new Set(state.arch_review_pending ?? [])],
  },
};

if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(matrix, null, 2) + '\n', 'utf8');
  console.log('WROTE=' + OUT);
}
console.log(JSON.stringify({ acceptance_head: matrix.acceptance_head, open_internal_items: openInternalItems, areas: AREAS.length }));
