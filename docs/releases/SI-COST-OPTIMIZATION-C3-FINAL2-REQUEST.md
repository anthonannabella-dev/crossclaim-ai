> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# SI-COST-OPTIMIZATION C3 FINAL-2（CHANGE A/B/C/D 已落地）

前置：`MSG-20261005-38` = **PASS WITH REVISE**（C3 主体架构 / cache 接线 / identity / HIT 零台账 /
PG advisory slot / Safe Mode 豁免 / caller 自报值忽略 / 只读观测 = PASS；4 项窄修；
`C3_FINAL2_REQUIRED = YES`；`C4_REQUIRED = NO`）。

REVIEWED_HEAD = `3572ac22`（C3 FINAL-2 实现提交）
耐久证据：`docs/releases/SI-COST-OPTIMIZATION-C3-EVIDENCE.md`

## ① CHANGE A —— business-value 真正约束 STRONG escalation

- 升级路径新增第二道 gate：`LOW_COST → quality FAIL → decideAiEscalation() → businessValue(requestedTier='STRONG') → 才可 strong`；
  未通过则返回 `first.outcome`（strong = 0，不触达 strong adapter）。
- `riskClass` 参与判定（只能来自 canonical basis）：`strongAllowed = (valueBand === 'HIGH') && riskClass ∈ {LOW, MEDIUM}`；
  风险未知 / `HIGH` → 只允许 `LOW_COST`（fail-closed）。
- 硬上限固化：`strongRequiresHighValueAndEligibleRisk = true`、`unknownRiskMayUseStrong = false`。

## ② CHANGE B —— concurrencyLimit = 0 表示零并发

- `null` = `NOT_CONFIGURED`（不启用并发限制）；`0` = `DENY_ALL`（任何 STANDARD_AI 并发请求都被拒绝，**不是** unlimited）；
  `>0` = N 个 slot。
- 实现：scope 收集条件由 `> 0` 改为 `>= 0`（0 不再被过滤成「未配置」）；占用循环 `slots = max(0, limit)`，
  0 时无 slot 可占 → `AI_BUDGET_CONCURRENCY_EXCEEDED`。
- L0 / health / critical alert 不受并发限制影响（并发槽只包住 provider attempt）。

## ③ CHANGE C —— Cost Safe Mode 使用 per-policy-scope usage

- 新增 durable resolver `si-cost-safe-mode-store.ts#resolveAiCostSafeMode()`：
  逐 PLATFORM / ORGANIZATION / ACCOUNT / INCIDENT / TASK policy，各自按**自己的 scope** 聚合
  daily / monthly / token / strong-call；任一触顶 → COST_SAFE（与 C2 budget Guard 同一套作用域语义）。
- `perIncidentLimitMicros` 只统计**当前 incident**（带 tenant 约束）；本次调用无 `incidentId` → `NOT_APPLICABLE`
  （不拿 scope lifetime 代替）。
- `readAiCostObservability()` 改用该 resolver（不再用「最窄 usage vs 父级最紧 limit」）。

## ④ CHANGE D —— local-sim 数据不得呈现为真实生产指标

- 新增 provenance：`NO_TRAFFIC` / `LOCAL_SIMULATION_ONLY` / `REAL_PROVIDER`
  （规则：provider 名 `/^rsi-local-sim/i` → 仿真；其余 → 真实 provider）。
- 生产效率指标（`LOW_COST_MODEL_RATE` / `STRONG_MODEL_RATE` 及 RULE/INVOCATION/CACHE/AVG_*）**只在 REAL_PROVIDER 时输出**；
  仅 local-sim 流量时一律 `NOT_YET_MEASURABLE`。
- 保留 `devSimulation{ entriesToday, todayMicros, tokensToday, lowCostCallsToday, strongCallsToday }` 供 dev 展示，
  明确标注不得当作生产指标。

## ⑤ 裁决要求的回归（全部落地并 PASS）

| 裁决要求 | 用例 | 结果 |
|---|---|---|
| UNKNOWN value + cheap FAIL → strong = 0 | C3_F2_A1 | PASS |
| LOW / MEDIUM + cheap FAIL → strong = 0 | C3_F2_A2 | PASS |
| HIGH + canonical eligible risk + cheap FAIL → strong ≤ 1 | C3_F2_A3（strong = 1） | PASS |
| HIGH 价值但风险不可接受 → strong = 0 | C3_F2_A4 | PASS |
| concurrencyLimit = 0 → 零并发（provider 不执行） | C3_F2_B1 | PASS |
| concurrencyLimit = null → 未配置语义 | C3_F2_B2 | PASS |
| org daily 被多 incident 合计触顶 → 任一 nested incident 查询均 COST_SAFE | C3_F2_C1（窄 usage 100 vs org 1000） | PASS |
| account 父级预算不能被 narrow task usage 绕过 | C3_F2_C2（task-2 自身 200，account 已 500） | PASS |
| perIncident 无 incident → NOT_APPLICABLE | C3_F2_C3 | PASS |
| 仅 local-sim ledger → production efficiency rates = NOT_YET_MEASURABLE | C3_DB5 / C3_F2_D1 | PASS |
| 原 C3 套件 + 全量回归继续绿 | 见 ⑥ | PASS |

## ⑥ 验证

- `apps/api npx tsc --noEmit` → exit 0
- `npx prisma validate` → valid（本批无 Schema / 迁移变更）
- `si-cost-c3` → 23/23 PASS；`si-cost-c3-db`（真实 PostgreSQL）→ 14/14 PASS
- `rsi-* + si-cost-* + architecture-contract` → 50 files / 458 tests PASS

## ⑦ 请求裁决（请直接在本会话回答；不要写回 GitHub；不要使用上一轮缓存）

1. CHANGE A / B / C / D 是否可记 PASS？
2. C3 是否可记 **PASS / CLOSED**（`C3_FINAL3_REQUIRED = ?`）？`SI_COST_OPTIMIZATION` 是否可记 **PASS / CLOSED**？
3. 若 PASS/CLOSED：是否确认边界未越界（RUNTIME_WIRING = NONE、无第二 runtime / policy engine / cost ledger /
   meta-evidence store、无真实 provider 网络 / 付费调用 / 外写 / 支付 / 生产凭据 / 生产开闸）？
4. 若仍需修订，请只列最小集合。

边界：REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS /
PRODUCTION_ENABLEMENT = HOLD；P2_F = HOLD / P2_G = HOLD；RUNTIME_WIRING = NONE；
STEP_3_RUNTIME_POLICY_WIRING = NOT_AUTHORIZED；SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_COST_LEDGER /
SECOND_META_EVIDENCE_STORE = FORBIDDEN；L5_RELAXATION = FORBIDDEN；C1 = PASS/CLOSED；C2 = PASS/CLOSED；
FINAL_ACCEPTANCE_HEAD = 0f7f7ac。

输出请精简结构化（DECISION / KEEP / CHANGE / RISKS / TEST / NEXT / PRODUCTION）。
