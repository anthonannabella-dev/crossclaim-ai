> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# SI-COST-OPTIMIZATION C2 —— FINAL-4 送审请求（tenant identity 两个残留旁路）

- **REVIEWED_HEAD = f5e4cc2c**（C2 FINAL-4 实现提交）；分支 `gate/7-commercial-validation`
- 前置：**MSG-20261005-36 = PASS WITH REVISE**（CHANGE A incident 维度 = PASS；CHANGE B policy tenant identity = PASS；
  剩两处 tenant identity 入口未统一 fail-closed；`C2_FINAL4_REQUIRED = YES`；C3 暂不授权）

## 1. CHANGE A —— tenant-scoped refs 缺 organizationId 必须 fail-closed

```text
任一 accountId / incidentId / taskId 存在但 organizationId 为空 → AI_BUDGET_TENANT_IDENTITY_REQUIRED（fail-closed）
  · provider 不调用、ledger 不写入（校验发生在事务前的入口处）
platform-only 路径仅当四个 refs 全为空（或显式 platform identity）才允许
```

## 2. CHANGE B —— `resolveEffectiveAiBudget()` tenant-safe

```text
非 PLATFORM 查找必须同时命中 organizationId = refs.organizationId（PLATFORM 用 '' 哨兵）
非 PLATFORM refs 缺 organizationId → AI_BUDGET_TENANT_IDENTITY_REQUIRED（fail-closed）
→ 与 guarded path 语义统一，C3 runtime / Cost Safe Mode / observability 复用该 helper 时不再存在跨租户读取旁路
```

## 3. 证据（C2 套件 24 → 27 例）

| 要求 | 证据 |
| --- | --- |
| incidentId/taskId 但 org=null → fail-closed，且 ledger 无 null-org 行 | `C2F4_A1` |
| platform-only（四 refs 全空）仍允许 | `C2F4_A2` |
| 同 scopeRef 跨 tenant：resolve 各自读本租户 policy；缺 org → fail-closed | `C2F4_B1`（org-A 500 / org-B 100；无 org 抛 AI_BUDGET_TENANT_IDENTITY_REQUIRED） |
| 原 24 例 + 全量回归继续绿 | C2 27/27；`rsi-* + architecture-contract = 47 文件 / 394 例 PASS` |

```text
apps/api npx tsc --noEmit → exit 0；migrate status → up to date（本批无 Schema/迁移变更）
NOT_YET_WIRED = CONCURRENCY_LIMIT_ENFORCEMENT（留 C3）；TOKEN_LIMIT = ENFORCED
```

## 4. 请求裁决

1. CHANGE A / B 是否可记 **PASS**？
2. `C2 IMPLEMENTATION` 是否可记 **PASS / CLOSED**（`C2_FINAL5_REQUIRED = ?`）？
3. 若 PASS/CLOSED：是否授权进入 **C3 IMPLEMENTATION**（cache runtime wiring + business-value cost policy + Cost Safe Mode +
   concurrencyLimit enforcement + admin 只读可观测 + `NOT_YET_MEASURABLE` 指标）？
4. 若仍需修订，请只列最小集合。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 5. 边界声明

```text
REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS /
PRODUCTION_ENABLEMENT = HOLD；P2_F = HOLD；P2_G = HOLD；RUNTIME_WIRING = NONE；
STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED；SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_COST_LEDGER /
SECOND_META_EVIDENCE_STORE = FORBIDDEN；L5_RELAXATION = FORBIDDEN；C1 = PASS/CLOSED；FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
