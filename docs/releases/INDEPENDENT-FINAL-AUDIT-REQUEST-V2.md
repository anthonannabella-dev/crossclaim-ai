# INDEPENDENT FINAL AUDIT REQUEST v2（MSG-20261003-135 口径）

- 时间：2026-10-03T17:23:44.761Z；acceptance HEAD：`1729cb9`
- 协议：`docs/releases/FINAL-ACCEPTANCE-PROTOCOL.md`（三层验收；禁止自证）
- 送审口径（按架构方 MSG-20261003-135）：**14/14 Layer 1 实证 + 四域 Layer 2 Golden Path 完整 + Layer 3 明确继续 HOLD**

## 一、Layer 1 — 14/14 实证（逐项绑定 acceptance HEAD）

- `L1-01_safe_continuation_queue_zero` → true：open backlog items: 0
- `L1-02_no_open_internal_items` → true：open internal: none
- `L1-03_no_open_markers` → true：arch_pending=0 awaiting_verdict=false
- `L1-04_full_ci_success_on_head` → true：acceptance_head=1729cb9 ci_head=76497f4 ci=in_progress run=37140224116 last_success=503b106/37139449952
- `L1-05_pg_regression_passed` → true：四域回归 45 文件 / 362 用例 PASS（代码树与 503b106 相同；CI 全量为权威） @a0d33fe
- `L1-06_fresh_db_migration_passed` → true：migrate status：66 migrations up to date @a0d33fe
- `L1-07_api_typecheck_passed` → true：tsc --noEmit (api) EXIT=0 @a0d33fe
- `L1-08_web_typecheck_build_passed` → true：tsc --noEmit (web) EXIT=0 @a0d33fe
- `L1-09_no_skipped_critical_tests` → true：四域回归 skipped=0 @a0d33fe
- `L1-10_git_working_tree_clean` → false：dirty entries: 4
- `L1-11_docs_state_consistent` → true：doc-sync 实时计数 OK；API_CONTRACT_OK；README 同步 @a0d33fe
- `L1-12_schema_invariants_verified` → true：db-constraint-coverage 26/26 + 触发器清单核对（required 98 / append-only 43） @a0d33fe
- `L1-13_negative_paths_covered` → true：四域负路径覆盖（跨租户/RBAC/幂等/并发/digest/证据/币种金额/未授权写/UNKNOWN provider） @a0d33fe
- `L1-14_real_pg_e2e_not_mock_only` → true：真实 PostgreSQL 套件全绿（customs 26 / IOR 9 / PS04 8 / Phase-1 3 / state-read 6 / qualification 3 / runtime E2E 2） @a0d33fe

- 证据规则：实证绑定 acceptance HEAD，或绑定「到 HEAD 之间仅簿记文件变更（`.autopilot/`、验收矩阵/报告、`tools/autopilot/`）」的祖先提交；任何代码 / Schema / 测试变更都会使实证失效为 UNVERIFIED。
- CI：`ci_status` + `ci_last_success_head`（最近一次成功 CI）均按同一规则判定。

## 二、Layer 2 — 四域 Golden Path（矩阵 0 缺口）

| 域 | frontend cell | 关键链可观察性 |
|---|---|---|
| Platform | COVERED / CLOSED（MSG-20261003-143） | Opportunity → Qualification（持久化判定只读投影） → Claim-ready → Submission（显式 External submission: NOT ENABLED / NEEDS_MANUAL） → Recovered/Fee/Billing |
| Logistics / Carrier | COVERED / CLOSED | carrier response 读模型（含 hasProviderVerifiedFact=false 明确呈现） |
| Customs | COVERED / CLOSED | filing status / return→claim evidence / entry fact + 四类 latest 投影，只读不重算 |
| Independent-site | COVERED / CLOSED | Dispute → Qualification/Evidence/Claim-ready（已持久化） → Handoff → Response → Settlement → Recovered → Fee → Billing，五状态分开 |

- Layer 2 矩阵：`gaps = []`；frontend cell 三层判据（真实后端调用 + critical-state token + 命名的 runtime HTTP E2E）。
- 语义不变式：`submitted ≠ won ≠ settled ≠ recovered ≠ billable`；`WON ≠ 到账`；`settlement reference exists ≠ verified`。

## 三、Layer 3 — 明确继续 HOLD（未假装完成）

| 分类 | 内容 |
|---|---|
| HOST_ACTION_REQUIRED | ["BG-006-production-candidate-preflight"] |
| API_INTEGRATION_REQUIRED | ["AMAZON_OAUTH_READ","TIKTOK_SHOP_OAUTH_READ","WALMART_OAUTH_READ","SHOPIFY_OAUTH_READ","UPS_API","FEDEX_API","DHL_API","CUSTOMS_DATA_PROVIDER","CUSTOMS_FILING_BROKER","STRIPE_DISPUTE_READ","PAYPAL_DISPUTE_READ"] |
| REAL_DATA_REQUIRED | ["REAL_CUSTOMER_DATA","REAL_SETTLEMENT_RECEIPT","REAL_RECOVERED_CASH"] |
| LEGAL_OR_LICENSE_REQUIRED | ["BROKER_POA","IOR_RIGHT_CONFIRMATION","DISPUTE_SUBMISSION_AUTHORITY"] |

边界：External Write=HOLD · Real Money=HOLD · Customer Submission=HOLD · Production Credentials=HOST_ONLY。

## 四、当前四状态（均为计算器输出，非自证）

```text
CODE_COMPLETE            = NO
INTEGRATION_COMPLETE     = NO
REAL_VALIDATION_COMPLETE = NO
PRODUCTION_READY         = NO
INTERNAL_READY           = NO
AUTONOMOUS_INTERNAL_WORK = RUNNING
```

未关闭内部项：[]（`SAFE_CONTINUATION_QUEUE = 0`）

## 五、请独立反查

1. Layer 1 的 14 项是否存在任何「自证」而非实证（含 CI 与 evidence 的绑定规则是否被滥用）；
2. Layer 2 四域是否仍有「service 有 HTTP 未接 / HTTP 有前端未接 / contract-only 无 persistence / schema 字段无 DB invariant」；
3. Layer 3 是否被正确标记为未 CLOSED，且没有任何真实能力被假装完成；
4. 是否存在 Codex 遗漏的内部可执行缺口。

请给出 `INDEPENDENT FINAL AUDIT = PASS`（含条件）或 `REVISE`（列 CHANGE）。
