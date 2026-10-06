> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# SI-COST-OPTIMIZATION C3 Implementation Audit Request

前置：`MSG-20261005-37` = **PASS / CLOSED**（C2 关闭；`C3 IMPLEMENTATION = AUTHORIZED`，含 6 项：
cache runtime wiring / business-value cost policy / Cost Safe Mode / concurrencyLimit enforcement /
admin read-only observability / NOT_YET_MEASURABLE metrics）。

REVIEWED_HEAD = `e7467b73`（C3 实现提交）
耐久证据：`docs/releases/SI-COST-OPTIMIZATION-C3-EVIDENCE.md`

## ① 落地（5 个新模块 + 2 处接线，无 Schema / 迁移变更）

1. `si-cost-safe-mode.ts`（纯函数）
   - 阈值 = durable `AiBudgetPolicy`（daily/monthly/perIncident/token/strong）与 durable ledger 聚合；
   - 触发 → `COST_SAFE`；`STANDARD_AI` 拒绝；`LEVEL_0_RULE` / `HEALTH_CHECK` / `CRITICAL_ALERT` **恒放行**（EXEMPT）；
   - `retryAllowed = false`（Safe Mode 下的拒绝为终局判定，不产生 retry storm）；
   - 未知 / 非法输入 → 抛错 fail-closed（不据此放行普通 AI）。
2. `si-ai-business-value-policy.ts`（纯函数）
   - 价值**只能**来自可信 canonical `basisRef` + `estimatedRecoveryValueMicros`；`callerClaimedValueMicros` **一律忽略**；
   - UNKNOWN / LOW / MEDIUM → `maxTier = LOW_COST`；仅 HIGH → `STRONG` eligible；host 不得放大阈值（hard caps）；
   - `AI_COST_PER_OPPORTUNITY / CASE / SUCCESSFUL_RECOVERY / $1000_RECOVERED / MODEL_COST_TO_RECOVERY_VALUE_RATIO`：
     分母缺失一律 `NOT_YET_MEASURABLE`。
3. `si-model-cache-runtime.ts`（cache 运行时接线，包裹 C2 store）
   - identity 七字段与 C1 契约一致；`organizationId` 为空 → `AI_MODEL_CACHE_TENANT_REQUIRED`（fail-closed，不查不存）；
   - stale / ruleVersion / schemaVersion / digest / tenant 不符 → MISS；高风险禁 stale fallback；
   - HIT ⇒ `MODEL_CALL_SKIPPED_CACHE_HIT`，**零 provider 调用、零 provider ledger entry**；savings 无估算器 → `NOT_YET_MEASURABLE`。
4. `si-budget-concurrency.ts`（`concurrencyLimit` enforcement，多实例）
   - 复用 PostgreSQL advisory **事务级 slot 锁**（`ai-concurrency:<scope>:<ref>:slot:<i>`）：跨实例互斥，**非**进程内 counter；
   - canonical 顺序 platform → org → account → incident → task，固定顺序防死锁；不新增 lease / usage 表；
   - 任一层无空闲 slot → `AI_BUDGET_CONCURRENCY_EXCEEDED`（不触达 provider、不写 ledger）；事务结束自动释放。
5. `si-cost-observability.ts`（admin 只读投影）
   - 数据只来自 durable ledger / policy / cache；**不写任何行**、不建第二 usage 表；
   - 输出：today/month/incident 成本、tokens、strong / low-cost 计数、budget remaining、top cost incidents、
     cache entries / expired、safe-mode 状态；结构上不含 prompt / 模型输出 / 凭据 / 客户敏感 payload；
   - 指标：可推导项给真实值，不可推导项 `NOT_YET_MEASURABLE`。

接线：
- `rsi-model-router.ts`：新增**可选**端口 `costSafeMode` / `cache` / `businessValue` / `concurrency` / `onCacheSavings`
  （缺省不启用 ⇒ 行为与 C1/C2 完全一致；`RsiModelInvocationRequest` 仅新增可选 `cacheScope`）。
  顺序：Necessity Gate → decideRsiModelCall → invocation 校验 → Safe Mode → cache → business value →
  C1 per-task identity / bounded escalation → 单次 attempt 经并发槽 → provider。
- `rsi-model-provider-composition.ts`：组合根可注入上述端口（仅 SI 成本控制内部链路 + local sim adapter）；
  `cacheHits()` 仅为组合根 dev 观测，不是 durable 事实源；cache HIT 不产生 provider 台账记录。

## ② 真实 PostgreSQL 取证（`si-cost-c3-db.test.ts`，8/8 PASS）

- C3_DB1 `concurrencyLimit=1`：两个独立 PrismaClient 并发 → 恰好 1 个成功、另 1 个 `AI_BUDGET_CONCURRENCY_EXCEEDED`；结束后槽位释放（第 3 次成功）。
- C3_DB2 `concurrencyLimit=2`：两个并发放行，第三个拒绝。
- C3_DB3 未配置 `concurrencyLimit` → 不开事务、直接执行。
- C3_DB4 账本累计触及日预算 → `COST_SAFE`；`STANDARD_AI` 拒绝、L0 / health / critical alert 放行。
- C3_DB5 投影只读（行数前后不变）；todayMicros / tokens / 等级计数 / budget remaining 正确；
  `RULE_RESOLVED_RATE` / `CACHE_HIT_RATE` / `AVG_AI_COST_PER_SUCCESSFUL_RECOVERY` = `NOT_YET_MEASURABLE`。
- C3_DB6 tenant 隔离（700 / 300 不串）。
- C3_DB7 cache：同租户 HIT；跨租户 / ruleVersion 不符 = MISS；缺 tenant → `AI_MODEL_CACHE_TENANT_REQUIRED`。
- C3_DB8 显式 savings 估算器 → 登记 tokens 120 / cost 900 micros（`ESTIMATOR`）。

## ③ 单元验收（`si-cost-c3.test.ts`，18/18 PASS）

Safe Mode（NORMAL / DAILY / TOKEN / STRONG_CALL / 豁免通道 / 非法输入 fail-closed）、
business value（UNKNOWN 禁 strong / HIGH eligible / caller 自报值忽略 / 坏 basis fail-closed / 比值 NOT_YET_MEASURABLE）、
Router（cache HIT 零 provider 零台账 / MISS 正常 / identity 非法 fail-closed / SAFE MODE / business-value 拒绝 /
并发槽拒绝**不消耗 attempt**）、组合根（可注入 / 缺省不变）。

## ④ 验证

- `apps/api npx tsc --noEmit` → exit 0
- `npx prisma validate` → valid；`npx prisma migrate status` → up to date（本批无 Schema / 迁移变更）
- `si-cost-c3` 18/18；`si-cost-c3-db` 8/8；`rsi-* + si-cost-* + architecture-contract` → 50 files / 445 tests PASS

## ⑤ 请求裁决（请直接在本会话回答；不要写回 GitHub；不要使用上一轮缓存）

1. 上述 6 项 C3 范围是否可记 PASS？
2. `SI_COST_OPTIMIZATION` 是否可记 **PASS / CLOSED**（`C4_REQUIRED = ?`）？
3. 若 PASS/CLOSED：是否确认 C3 未越界（RUNTIME_WIRING 仍为 NONE、无第二 runtime / policy engine / cost ledger /
   meta-evidence store、无真实 provider 网络 / 付费调用 / 外写 / 支付 / 生产凭据 / 生产开闸）？
4. 若仍需修订，请只列最小集合。

边界：REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS /
PRODUCTION_ENABLEMENT = HOLD；P2_F = HOLD / P2_G = HOLD；RUNTIME_WIRING = NONE；
STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED；SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_COST_LEDGER /
SECOND_META_EVIDENCE_STORE = FORBIDDEN；L5_RELAXATION = FORBIDDEN；C1 = PASS/CLOSED；C2 = PASS/CLOSED；
FINAL_ACCEPTANCE_HEAD = 0f7f7ac。

输出请精简结构化（DECISION / KEEP / CHANGE / RISKS / TEST / NEXT / PRODUCTION）。
