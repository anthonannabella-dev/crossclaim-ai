> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# SI-COST-OPTIMIZATION C2 —— Implementation Audit 送审请求

- 分支：`gate/7-commercial-validation`；仓库 `anthonannabella-dev/crossclaim-ai`
- **REVIEWED_HEAD = `f099ec4c`**（C2 实现提交：C2-a Schema/迁移/触发器 + C2-b stores/PG 取证）
- 前置：**MSG-20261005-33 = PASS / CLOSED**（C1 关闭，C2 IMPLEMENTATION 已授权）；
  设计依据 MSG-20261005-30（3.1=A / 3.2=B / 3.3=A / 3.4=A / 3.5=A）
- 耐久证据：`docs/releases/SI-COST-OPTIMIZATION-C2-EVIDENCE.md`

## 1. 落地内容

| 项 | 落地 |
| --- | --- |
| `AiCostLedgerEntry`（3.1=A） | append-only 成本事实：`callId` 幂等唯一、`costMicros` INTEGER 微单位、身份/计数/结果字段齐全；**无** raw prompt / 模型输出 / 凭据 / 客户敏感 payload 字段 |
| `AiBudgetPolicy`（3.2=B） | durable 分级预算**配置**；**不建 usage 表**（`AiBudgetUsage = FORBIDDEN`）；有效预算按层级取各字段 min（子级只能收紧） |
| ledger-derived usage | `aggregateAiCostUsage()` 从账本实时聚合（唯一事实源）；重启后统计不归零 |
| `AiModelCacheEntry`（3.3=A） | identity 唯一键含 `organizationId`（`''` = platform）；非 append-only（受控 TTL/GC）；identity 与 resultDigest 由触发器禁止原地改写；命中/过期/跨租户判定复用 C1 `evaluateAiCacheLookup` |
| 触发器 + 清单同步 | tenant 基线 ×3、`cc_tenant_immutable__*` ×3、`cc_append_only__AiCostLedgerEntry`、`cc_cache_identity_immutable__AiModelCacheEntry`；两份清单同步并在真实库校验通过 |
| Budget race 防线 | `runGuardedAiCostWrite()`：同一事务内 `pg_advisory_xact_lock(scopeKey)` → 账本聚合用量 → 与有效预算比较 → 同事务写事实（check-then-write 原子化） |

## 2. 证据（真实 PostgreSQL）

```text
C2_DB1  幂等 callId（duplicate，不产生第二条事实）                     PASS
C2_DB2  append-only：UPDATE/DELETE 被拒（AI_COST_LEDGER_APPEND_ONLY）   PASS
C2_DB3  重启后统计不归零（新 PrismaClient 读回）                        PASS
C2_DB4  tenant 隔离聚合互不串扰                                        PASS
C2_DB5  层级只收紧（子级 5000 不放大平台 1000）                          PASS
C2_DB6  无 usage 表（usage 只能由账本聚合）                             PASS
C2_DB7  超预算拒绝写入（账本不新增事实）                                 PASS
C2_DB8  并发 5 次 / 限额允许 2 次 → 恰好写 2 条（race 防线，不无限超支）   PASS
C2_DB9  缓存 HIT；跨租户 / ruleVersion / stale 一律 MISS                 PASS
C2_DB10 identity 不可原地改写 + GC 删除过期条目                          PASS
```

## 3. 验证命令

```text
prisma validate / migrate deploy / generate → valid / 80 migrations 已应用 / OK
两份触发器清单（真实库）                     → TENANT_CHECKLIST=OK / APPEND_ONLY_CHECKLIST=OK
apps/api npx tsc --noEmit                   → exit 0
si-cost-c2-db.test.ts                       → 10/10 PASS
rsi-* + architecture-contract + C2          → 48 files / 404 tests PASS
```

## 4. 与裁决条文对应（防遗漏）

- **3.2=B 的「不能只是不落 usage」**：`AiBudgetPolicy` 为 durable 配置；用量 100% 由账本聚合（C2_DB6 用 information_schema 证明无 usage 表）。
- **层级语义**：`resolveEffectiveAiBudget()` 对 daily/monthly/incident/strongCall/token/concurrency 逐字段取 min → 子级只能收紧（C2_DB5）。
- **race 防线**：并发用例证明「限额只允许 2 次」时恰好 2 条落库、其余被拒且理由一致（C2_DB8），不存在 check-then-write 竞态越界。
- **缓存身份安全**：唯一键含 `organizationId`；查询按身份精确匹配后仍经 C1 判定（跨租户 / 版本 / 摘要 / stale → MISS）；`DELETE` 允许（TTL/GC），identity 改写被拒（C2_DB10）。
- **敏感数据**：账本与缓存写入类型的字段集合中不存在 prompt 正文 / 模型输出 / 凭据 / 客户敏感 payload（结构保证）。
- **零越界**：未接运行时（`RUNTIME_WIRING = NONE`），未做真实模型网络/付费调用。

## 5. 请求裁决

1. C2（`AiCostLedgerEntry` + `AiBudgetPolicy` + ledger-derived usage + `AiModelCacheEntry` + tenant/append-only 触发器与清单 +
   Budget race 防线 + 真实 PG 回归）是否可记 **PASS**？
2. `C2 IMPLEMENTATION` 是否可记 **PASS / CLOSED**（`C2_FINAL2_REQUIRED = ?`）？
3. 若 PASS/CLOSED：是否授权进入 **C3 IMPLEMENTATION**（`AiModelCacheEntry` 运行时接线 + business-value cost policy
   + admin observability 只读投影 + Cost Safe Mode + 指标 `NOT_YET_MEASURABLE` 语义）？
4. 若仍需修订，请只列最小集合。

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 6. 边界声明（本批未改动）

```text
REAL_MODEL_NETWORK / PAID_MODEL_CALLS = HOLD（仅本地仿真 adapter、零外部模型支出）
EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT = HOLD
P2_F = HOLD；P2_G = HOLD；RUNTIME_WIRING = NONE；STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED
SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_COST_LEDGER / SECOND_META_EVIDENCE_STORE = FORBIDDEN
L5_RELAXATION = FORBIDDEN（CUSTOMS_FILING 继续永久拒绝）
P2_E_V1_OPTION_A = PASS / CLOSED；SI_RSI_UNIFICATION_V1 = PASS / CLOSED；C1 = PASS / CLOSED；FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
