# SI-COST-OPTIMIZATION C3 —— EVIDENCE（cache runtime wiring / business-value / Safe Mode / concurrency / observability）

- 授权：`MSG-20261005-37`（C2 = PASS / CLOSED；`C3 IMPLEMENTATION = AUTHORIZED`）。
- 边界：REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS /
  PRODUCTION_ENABLEMENT = HOLD；P2_F = HOLD；P2_G = HOLD；`RUNTIME_WIRING = NONE`（C3 接线仅限 **SI 成本控制内部链路** +
  local simulation adapter）；STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED；不新增第二 runtime / policy engine /
  cost ledger / meta-evidence store。

## 1. 新增模块（apps/api/src/services/autonomy/）

| 模块 | 职责 | 关键不变量 |
|---|---|---|
| `si-cost-safe-mode.ts` | Cost Safe Mode 判定（纯函数） | 只停 `STANDARD_AI`；`LEVEL_0_RULE` / `HEALTH_CHECK` / `CRITICAL_ALERT` 恒放行；`retryAllowed = false`（无重试风暴）；非法输入抛错 fail-closed |
| `si-ai-business-value-policy.ts` | 业务价值 → 最高模型等级 | 价值**只能**来自可信 canonical `basisRef`；`callerClaimedValueMicros` 一律忽略；UNKNOWN/LOW/MEDIUM → `LOW_COST` only；HIGH → `STRONG` eligible；host 不得放大阈值；缺可信分母 → `NOT_YET_MEASURABLE` |
| `si-model-cache-runtime.ts` | cache **运行时接线**（包裹 C2 store） | `organizationId` 缺失 → `AI_MODEL_CACHE_TENANT_REQUIRED`（fail-closed，不查不存）；stale / ruleVersion / schema / input / prompt / tenant 不符 → MISS（复用 C1 判定）；HIT **不产生 provider ledger entry**；savings 无估算器 → `NOT_YET_MEASURABLE` |
| `si-budget-concurrency.ts` | `concurrencyLimit` 强制（多实例） | PostgreSQL **advisory-xact-lock slot**；不新增 lease / usage 表；canonical 顺序（platform → org → account → incident → task）防死锁；任一层满即 `AI_BUDGET_CONCURRENCY_EXCEEDED`；调用结束自动释放 |
| `si-cost-observability.ts` | admin **只读**投影 | 全部来自 durable ledger / policy / cache；不写任何行；无第二 usage 表；不暴露 prompt / response / 凭据 / 客户敏感内容；不可测指标 → `NOT_YET_MEASURABLE` |

## 2. 接线（唯一咽喉不变）

- `rsi-model-router.ts`：新增**可选**端口 `costSafeMode` / `cache` / `businessValue` / `concurrency` / `onCacheSavings`。
  缺省不启用 ⇒ 行为与 C1/C2 **完全一致**（`RsiModelInvocationRequest` 仅新增可选 `cacheScope`）。
- 执行顺序（保持不变的部分一律不变）：Necessity Gate → `decideRsiModelCall` → invocation 校验 →
  **C3①Safe Mode 准入** → **C3②cache（HIT ⇒ `MODEL_CALL_SKIPPED_CACHE_HIT`，零 provider 调用）** →
  **C3③business value** → C1 per-task identity / bounded escalation → 单次 attempt 经 **C3④并发槽** → provider。
- `rsi-model-provider-composition.ts`：组合根可注入上述端口；`cacheHits()` 仅为组合根内 dev 观测，
  **不是** durable 事实源；cache HIT 不产生 provider 台账记录。

## 3. 真实 PostgreSQL 取证（`si-cost-c3-db.test.ts`，8/8 PASS）

| 用例 | 证据 |
|---|---|
| C3_DB1 | `concurrencyLimit = 1`：两个**独立 PrismaClient** 并发，恰好 1 个获得槽位，另一个 `AI_BUDGET_CONCURRENCY_EXCEEDED`；调用结束后槽位自动释放（第 3 次可执行） |
| C3_DB2 | `concurrencyLimit = 2`：两个并发放行，第三个被拒绝 |
| C3_DB3 | 未配置 `concurrencyLimit` → 不开事务、直接执行（零额外开销） |
| C3_DB4 | 账本累计触及日预算 → `COST_SAFE`（exhaustedDimensions 含 DAILY）；`STANDARD_AI` 拒绝、`LEVEL_0_RULE` / `HEALTH_CHECK` / `CRITICAL_ALERT` 放行 |
| C3_DB5 | 只读投影：行数前后不变（无写入）；`todayMicros = 5_000`、tokens = 240、strong/low-cost 计数正确；`RULE_RESOLVED_RATE` / `CACHE_HIT_RATE` / `AVG_AI_COST_PER_SUCCESSFUL_RECOVERY` = `NOT_YET_MEASURABLE` |
| C3_DB6 | tenant 隔离：只聚合本租户账本（700 / 300 不串） |
| C3_DB7 | cache：同租户身份 HIT；跨租户 / `ruleVersion` 不符 = MISS；缺 `organizationId` → `AI_MODEL_CACHE_TENANT_REQUIRED` |
| C3_DB8 | 显式 savings 估算器 → 登记真实口径（tokens 120 / cost 900 micros，`ESTIMATOR`） |

## 4. 单元验收（`si-cost-c3.test.ts`，18/18 PASS）

- Safe Mode：NORMAL / 日预算触顶 / token 触顶 / strong-call 触顶 / 豁免通道 EXEMPT / 非法输入 fail-closed。
- Business value：无 basis → UNKNOWN（strong 禁止）/ HIGH → STRONG eligible / caller 自报值被忽略 / 坏 basis fail-closed /
  成本价值比缺分母 → `NOT_YET_MEASURABLE`。
- Router：cache HIT（零 provider、零 provider 台账、savings 登记）/ cache MISS 正常路径 /
  identity 非法 fail-closed（不降级放行 provider）/ SAFE MODE 拒绝 / business-value 拒绝 / 并发槽拒绝**不计 attempt**（无重试风暴）。
- 组合根：端口可注入；缺省行为不变。

## 5. 验证命令与结果

| 命令 | 结果 |
|---|---|
| `apps/api npx tsc --noEmit` | exit 0 |
| `npx prisma validate` | valid |
| `npx prisma migrate status` | Database schema is up to date（本批**无** Schema / 迁移变更） |
| `npx vitest run src/__tests__/si-cost-c3.test.ts` | 18/18 PASS |
| `npx vitest run src/__tests__/si-cost-c3-db.test.ts` | 8/8 PASS |
| `npx vitest run rsi-* + si-cost-* + architecture-contract` | 50 files / 445 tests PASS |

## 6. Acceptance 对照（HOST ADDENDUM 12 条）

1. LEVEL_0 仍为默认 —— `decideRsiModelCall` / `evaluateAiNecessity` 未变；Safe Mode 不停 L0。✔
2. rule-solvable 无法调用模型 —— Necessity Gate 未变（C1 已 PASS）。✔
3. durable ledger restart 不归零 —— C2_DB3（未回退）。✔
4. tenant budget isolation —— C2 + C3_DB6。✔
5. cache identity 安全 —— C3_DB7 + C1 identity 契约。✔
6. stale cache fail-closed —— `evaluateAiCacheLookup`（C1）+ 高风险禁 stale fallback。✔
7. cheap→strong 必经 quality gate —— C1 bounded escalation（未回退）。✔
8. 预算耗尽无无限 retry —— Safe Mode `retryAllowed = false`；并发槽拒绝不计 attempt。✔
9. strong 不被普通任务滥用 —— business value（UNKNOWN → LOW_COST）+ C1 hard cap。✔
10. 无 credential / raw prompt / raw provider response 持久化 —— ledger / cache / 投影结构保证。✔
11. Cost Safe Mode 正常 —— C3_SM1–SM5 + C3_DB4。✔
12. 既有 RSI / Recovery SI regression 全绿 —— 50 files / 445 tests。✔

**真实指标**：`RULE_RESOLVED_RATE` / `MODEL_INVOCATION_RATE` / `CACHE_HIT_RATE` / `AVG_AI_COST_PER_CASE` /
`AVG_AI_COST_PER_SUCCESSFUL_RECOVERY` = **NOT_YET_MEASURABLE**（无真实模型流量与真实恢复事实；
本批不伪造任何生产指标）。已可计算项：low-cost / strong 调用占比（来自 durable ledger）。

## 7. 未解锁边界

`CONCURRENCY_LIMIT_ENFORCEMENT = ENFORCED（C3）`；其余 HOLD 全部保持原状（见本文开头）。
