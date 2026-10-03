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

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..');
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
  { id: 'platform_recovery', area: 'Platform Recovery', layer: 2, status: 'PARTIAL', evidence: 'BG-001 只读闭环 72 用例', note: '真实 OAuth adapter = API_INTEGRATION_REQUIRED' },
  { id: 'logistics_carrier', area: 'Logistics / Carrier Recovery', layer: 2, status: 'INTERNAL_COMPLETE', evidence: 'u6 carrier 289 用例 + BG-009 只读对账 7/7', note: '真实 provider = EXTERNAL' },
  { id: 'customs', area: 'Customs / Trade Recovery', layer: 2, status: 'PARTIAL', evidence: 'G4 C1–C7 CLOSED（MSG-20261003-128）；BG-012 chain trigger + return-claim-evidence GET + filing-status/start-recovery 已接线', note: '只读投影 GET（duty truth / discrepancy / eligibility / estimate / claim-ready）与 IOR 全链 HTTP 待接：BG-020' },
  { id: 'independent_site', area: 'Independent-site / Chargeback', layer: 2, status: 'PARTIAL', evidence: 'PS04 Phase 1 只读链（BG-010）', note: '内部闭环 start recovery → handoff → status → settlement → ledger → fee → invoice = BG-018' },
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
  { id: 'backend_http_wiring', area: 'Backend HTTP wiring', layer: 2, status: 'PARTIAL', evidence: 'implemented=90 / documented=77 路由契约 OK', note: 'customs 只读投影 GET 待接（BG-020）' },
  { id: 'frontend_wiring', area: 'Frontend wiring', layer: 2, status: 'PARTIAL', evidence: 'integration-status 只读接线 + start-recovery 表单', note: '四域内部 Golden Path 所需最小前端接线 = BG-019' },
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
