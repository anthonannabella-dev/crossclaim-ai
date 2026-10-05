# SI-COST-OPTIMIZATION C2 —— FINAL-3 送审请求（A incident 维度 + B tenant 绑定）

- **REVIEWED_HEAD = 56b3207d**（C2 FINAL-3 实现提交）；分支 `gate/7-commercial-validation`
- 前置：**MSG-20261005-35 = PASS WITH REVISE**（CHANGE A 部分 PASS 仍需 incident 维度缺口；CHANGE B 非 PLATFORM policy 必须绑定 tenant）
- 范围严格 = A `perIncidentLimitMicros` 按当前 incident 聚合 + B Budget policy / usage tenant 绑定

## 1. CHANGE A —— perIncidentLimitMicros 按当前 incident 维度

```text
父级 policy（PLATFORM / ORGANIZATION / ACCOUNT）的 perIncidentLimitMicros 是**继承给当前 incident 的上限**：
  perIncidentUsage = 当前 incidentId 的账本聚合（且带 organizationId 约束）
  校验：perIncidentUsage + estimatedCostMicros <= perIncidentLimitMicros
无 incidentId → 该字段 NOT_APPLICABLE（不再用 policy scope lifetime 代替 incident usage）
```

## 2. CHANGE B —— Budget policy / usage tenant 绑定

```text
policy 身份：organizationId 非空（PLATFORM 用 '' 哨兵），唯一键 = (scope, scopeRef, organizationId)
  → 同 scopeRef 在不同 tenant 下各自独立，不再互相覆盖/串用
policy 查找：非 PLATFORM 必须同时命中 organizationId = refs.organizationId（否则视为不适用）
usage 聚合：ACCOUNT / INCIDENT / TASK 一律附带 organizationId 约束（跨租户 ledger 行不参与聚合）
DB 层：CHECK ("scope" = 'PLATFORM' AND organizationId = '') OR ("scope" <> 'PLATFORM' AND organizationId <> '')
service 层：非 PLATFORM 缺 organizationId → AI_BUDGET_POLICY_TENANT_REQUIRED（fail-closed）
```

## 3. 证据（真实 PostgreSQL；C2 套件 18 → 24 例）

| 要求 | 证据 |
| --- | --- |
| org perIncident=1000：inc-A 900 / inc-B 900 各自 PASS；inc-A 再 +200 → AI_BUDGET_INCIDENT_EXCEEDED | `C2F3_A1` |
| platform perIncident 按各 incident 独立统计 | `C2F3_A2` |
| ACCOUNT parent policy 的 per-incident cap 只计当前 incident | `C2F3_A3` |
| org-A 的 ACCOUNT/INCIDENT/TASK policy 不得应用到 org-B | `C2F3_B1`（org-B 通过、org-A 被拒） |
| 同名同值 scopeRef 跨 tenant 不串 usage | `C2F3_B2`（org-A 500 / org-B 500 各自允许；org-A 第二次被拒） |
| 缺 tenant 绑定 fail-closed（service + DB） | `C2F3_B3`（service 抛 AI_BUDGET_POLICY_TENANT_REQUIRED；裸 INSERT 被 DB 拒绝） |
| 原 18 例 + 全量回归继续绿 | `C2 24/24`；`rsi-* + architecture-contract + C2 = 48 文件 / 418 例 PASS` |

## 4. 验证

```text
prisma validate → valid；migrate deploy → 82 migrations（20261005090000 tenant_binding + 20261005100000 policy_identity 已应用）；
prisma generate → OK；apps/api npx tsc --noEmit → exit 0；si-cost-c2-db → 24/24 PASS
NOT_YET_WIRED = CONCURRENCY_LIMIT_ENFORCEMENT（配置可存，执行留 C3）；TOKEN_LIMIT = ENFORCED
```

## 5. 请求裁决

1. CHANGE A（incident 维度 perIncident）与 CHANGE B（policy/usage tenant 绑定）是否可记 **PASS**？
2. `C2 IMPLEMENTATION` 是否可记 **PASS / CLOSED**（`C2_FINAL4_REQUIRED = ?`）？
3. 若 PASS/CLOSED：是否授权进入 **C3 IMPLEMENTATION**（缓存运行时接线 + business-value cost policy + Cost Safe Mode +
   `concurrencyLimit` enforcement + admin 只读可观测 + `NOT_YET_MEASURABLE` 指标）？
4. 若仍需修订，请只列最小集合。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 6. 边界声明

```text
REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS /
PRODUCTION_ENABLEMENT = HOLD；P2_F = HOLD；P2_G = HOLD；RUNTIME_WIRING = NONE；
STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED；SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_COST_LEDGER /
SECOND_META_EVIDENCE_STORE = FORBIDDEN；L5_RELAXATION = FORBIDDEN；C1 = PASS/CLOSED；FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
