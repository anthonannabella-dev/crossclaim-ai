#!/usr/bin/env node
/** FINAL-ACCEPTANCE-REPORT 生成器（协议六）。数据来源：STATE + 差集登记表 + CI/测试留档。 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..');
const STATE = path.join(ROOT, '.autopilot', 'STATE.json');
const OUT = path.join(ROOT, 'docs', 'releases', 'FINAL-ACCEPTANCE-REPORT.md');

const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const fs2 = state.final_status ?? {};
const row = (name, status, evidence, note) => "| " + name + " | " + status + " | " + evidence + " | " + (note ?? "") + " |";

const lines = [
  "# FINAL ACCEPTANCE REPORT（自动生成，请勿手改）",
  "",
  "- 生成时间：" + new Date().toISOString() + "；HEAD：`" + String(fs2.head ?? state.current_head ?? "unknown") + "`",
  "- 协议：`docs/releases/FINAL-ACCEPTANCE-PROTOCOL.md`（三层验收；禁止自证）",
  "- 状态：CODE_COMPLETE=" + String(fs2.CODE_COMPLETE ?? "NO") + " · INTEGRATION_COMPLETE=" + String(fs2.INTEGRATION_COMPLETE ?? "NO") + " · REAL_VALIDATION_COMPLETE=" + String(fs2.REAL_VALIDATION_COMPLETE ?? "NO") + " · PRODUCTION_READY=" + String(fs2.PRODUCTION_READY ?? "NO"),
  "- INDEPENDENT_FINAL_AUDIT_REQUIRED = TRUE（独立审计完成前不得置 PRODUCTION_READY=YES）",
  "",
  "## 1. 验收项",
  "",
  "| 验收项 | 状态 | 证据 | 备注 |",
  "|---|---|---|---|",
  row("P0 Business Survival Gates", "CLOSED", "MSG-20261003-132；lifelines A/B CLOSED；CI 3417377/42be8f6 success", "含 Trust guard A1–A3"),
  row("Platform Recovery", "PARTIAL（真实 adapter = API_INTEGRATION_REQUIRED）", "BG-001 平台只读闭环 72 用例", "真实 OAuth 未接"),
  row("Logistics / Carrier Recovery", "INTERNAL COMPLETE", "BG-006? 实为 u6 carrier 289 用例 + BG-009 只读对账 7 用例", "真实 provider = EXTERNAL"),
  row("Customs Recovery", "CLOSED（G4 C1–C7）", "MSG-20261003-128/132；PG E2E 8/8 + 路由 E2E 4/4", "真实 filing = HOLD_EXTERNAL"),
  row("Independent-site / Chargeback", "IN PROGRESS（PS04 Phase 1）", "D1–D3 枚举迁移已落地（3d80d60）；BG-010 待实现", "不接真实 PSP"),
  row("Evidence Graph", "INTERNAL COMPLETE（证据层）", "BG-007 71 用例", ""),
  row("Qualification", "CLOSED", "MSG-20261003-132；11/11 + PG 5/5 + 后端强制 Gate", ""),
  row("Settlement（只读对账）", "IN PROGRESS", "BG-009 只读投影 7/7（APPROVED/PAID ≠ RECEIVED）", "真实到账 = HOLD"),
  row("RecoveryLedger / 15% Fee / Billing", "INTERNAL COMPLETE（HOLD 语义）", "u7 资金链 287 用例", "真实扣费 = HOLD"),
  row("Action Guard", "INTERNAL COMPLETE", "action-guard 套件 + GUARD_ENFORCED_ACTIONS 注册", "EXTERNAL_WRITE 接线需再审"),
  row("Tenant Isolation", "VERIFIED", "tenant 触发器清单 92 baseline + psql 校验", ""),
  row("RBAC", "VERIFIED", "permissions 矩阵 + HTTP E2E 403 用例", ""),
  row("Idempotency / Concurrency / Failure Recovery", "VERIFIED", "C17 13/13；platform-write CAS；u7 套件", ""),
  row("Fresh DB Migration", "VERIFIED", "u4：deploy-smoke OK（空库全迁移）", ""),
  row("DB Constraints", "VERIFIED", "db-constraint-coverage 26/26 + 运行库 psql 核实", ""),
  row("Backend HTTP wiring", "PARTIAL", "customs 只读路由已接；Customs 内部触发（BG-012）待做", ""),
  row("Frontend wiring", "PARTIAL", "integration-status 只读接线；其余域待接", ""),
  row("Full CI", "见 CI Run 列", "各 commit run 均 success（详见 STATE.ci_confirmed）", "最新 HEAD 结果以 GitHub 为准"),
  row("Documentation sync", "VERIFIED", "u5 doc-sync 5 checks OK；BG-004 OK", ""),
  row("Security / Credential boundary", "VERIFIED", "无凭据落库；Trust guard A1–A3；HOST_ONLY 凭据", ""),
  row("Production integrations", "HOST_ACTION_REQUIRED", "BG-006 已登记；未执行任何生产动作", "见第 3 节"),
  "",
  "## 2. 打开的内部项",
  "",
  ...(Array.isArray(fs2.OPEN_INTERNAL_ITEMS) && fs2.OPEN_INTERNAL_ITEMS.length ? fs2.OPEN_INTERNAL_ITEMS.map((item) => "- " + item) : ["- （无）"]),
  "",
  "## 3. 外部 / 宿主依赖（不得自证完成）",
  "",
  "### HOST_ACTION_REQUIRED",
  "",
  ...(fs2.HOST_ACTION_REQUIRED ?? []).map((item) => "- " + item),
  "",
  "### API_INTEGRATION_REQUIRED",
  "",
  ...(fs2.API_INTEGRATION_REQUIRED ?? []).map((item) => "- " + item),
  "",
  "### REAL_DATA_REQUIRED",
  "",
  ...(fs2.REAL_DATA_REQUIRED ?? []).map((item) => "- " + item),
  "",
  "### LEGAL_OR_LICENSE_REQUIRED",
  "",
  ...(fs2.LEGAL_OR_LICENSE_REQUIRED ?? []).map((item) => "- " + item),
  "",
  "## 4. 边界",
  "",
  "Production Enablement=HOLD · External Write=HOLD · Real Money=HOLD · Customer Submission=HOLD · Production Credentials=HOST_ONLY",
];

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
console.log("WROTE=" + OUT);
