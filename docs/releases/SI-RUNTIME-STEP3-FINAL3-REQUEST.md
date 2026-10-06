> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# STEP_3_RUNTIME_POLICY_WIRING FINAL-3（CHANGE A / B 已落地）

前置：`MSG-20261005-42`（FINAL-2 裁决）= **PASS WITH REVISE**（proposal/verdict 分离主体 PASS 但仍有 1 个旁路；
Guard port/fail-closed = contract PASS 但真实 Shared Guard adapter 未完成；`STEP3_FINAL3_REQUIRED = YES`）。

REVIEWED_HEAD = `692726bf`

## ① CHANGE A —— 关闭 `awaitVerdict:false` 旁路（不得回退）

* `composeRsiRuntime`：`domainPacks` 路径**强制** park-for-judge：
  `awaitVerdict: domainPacks.length > 0 ? true : (input.awaitVerdict ?? false)` —— 宿主显式传 `false` 也无法绕过。
* 新增边界常量 `RSI_RUNTIME_COMPOSITION_BOUNDARY.domainPackAlwaysParksForJudge = true`。
* 语义保持：`waitingForVerdict = true`、`verdict === null`、proposal 独立保存（`proposal()`）、
  只有真实 external verdict 才能完成、`SELF_JUDGE_FORBIDDEN` 不回退。

## ② CHANGE B —— 真实 Shared Action Guard / Control Plane adapter

* 新增 `apps/api/src/runtime/recovery-guard-adapter.ts`：
  * `createSharedRecoveryGuardAdapter({ guard })`：只做**决策映射**，评估一律委托共享 `RuntimeActionGuard.evaluate`；
  * `createSharedRecoveryGuardAdapterFromAppGuard(deps)`：直接用共享 `createAppActionGuard(deps)` 组装
    （唯一 Control Plane + Kill Switch 读端口 + `ACTION_GUARD_CATALOG` 闸门）。
* 真实链路：`intent → resolveGuardAction → shared Action Guard / Control Plane adapter → ALLOW → deterministic read tool`；
  domain pack 无法绕过 shared guard（非 ALLOW 一律 `BLOCK`，`toolCallCount = 0`）。
* 映射语义：`ALLOW → ALLOW`；`DENY → DENY`；`REQUIRE_APPROVAL → REQUIRES_APPROVAL`（保持 HITL 等待，不自动继续）；
  Kill Switch → `DENY + killSwitchActive`；Control Plane 不可用（抛错）→ `DENY + degraded`（**不 fallback**）；
  tenant / organization 不符 → 共享 guard 判 DENY → tool = 0；CUSTOMS / unmapped → 零 Guard 调用直接 BLOCK。
* 边界常量 `RECOVERY_GUARD_ADAPTER_BOUNDARY`：唯一 owner 路径 + `secondGuardImplementation = FORBIDDEN` +
  不可用 / 需审批 / Kill Switch 的 fail-closed 语义。

## ③ 测试（新增 6 例；原 5 条 stub 路径 + CUSTOMS 继续通过）

| 用例 | 证据 |
|---|---|
| STEP3F3_A1 | `domainPacks + awaitVerdict:false` → 仍 `waitingForVerdict = true`、`verdict === null`、proposal = PASS、只有 external verdict 才完成 |
| STEP3F3_B1 | **真实共享 Guard 被实际调用**（spy 计数 = 1），adapter 决策与共享决策逐项一致 |
| STEP3F3_B2 | 共享 Guard 抛错（Control Plane 不可用）→ `DENY + degraded` → read tool = 0 |
| STEP3F3_B3 | Kill Switch → `DENY + killSwitchActive` → read tool = 0 |
| STEP3F3_B4 | `REQUIRE_APPROVAL → REQUIRES_APPROVAL`（保持等待人工 / HITL，不自动继续） |
| STEP3F3_B5 | 源码级：adapter 复用 `action-guard/runtime-guard-composition`，`secondGuardImplementation = FORBIDDEN` |
| 既有 STEP3F2_B2 ×5 | DENY / REQUIRES_APPROVAL / degraded / kill switch / tenant mismatch → `BLOCK`，`readCalls = []` |
| 既有 STEP3F2_B3 | CUSTOMS → Guard 0 / tool 0 |

## ④ 验证

* `apps/api npx tsc --noEmit` → exit 0
* `rsi-domain-pack-wiring` 22/22；`rsi-si-runtime-e2e` 5/5
* `rsi-* + si-cost-* + recovery-* + architecture-contract` → **75 files / 765 tests PASS**
* 架构不变量：`SECOND_RUNTIME = 0`、第二 event loop / controller / scheduler = 0、Policy Core 唯一、
  Shared Action Guard 唯一、Control Plane 唯一、依赖方向不反转、Recovery SI 仍为 static domain pack、
  `CUSTOMS L5 = PERMANENT BLOCK`、`tools/autopilot/** = DEV_SCOPE`、本阶段 `modelCallCount = 0`
* **未提前宣称**：`MODEL_GATEWAY_RUNTIME_WIRED` / `COST_CORE_RUNTIME_WIRED` / `META_IMPROVEMENT_INTEGRATED`
  仍为 false（需后续独立真实 runtime / E2E 证据）

## ⑤ 请求裁决（请直接在本会话回答；不要写回 GitHub；不要使用上一轮缓存）

1. CHANGE A（关闭 `awaitVerdict:false` 旁路）与 CHANGE B（真实 Shared Action Guard adapter）是否可记 PASS？
2. `STEP_3_RUNTIME_POLICY_WIRING` 是否可记 **PASS / CLOSED**（`STEP3_FINAL4_REQUIRED = ?`）？
3. 若仍需修订，请只列最小集。

边界：REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS /
PRODUCTION_ENABLEMENT = HOLD；P2_F = HOLD / P2_G = HOLD；CUSTOMS real filing = HOLD；
SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_CONTROL_PLANE / SECOND_MODEL_GATEWAY / SECOND_COST_LEDGER /
SECOND_META_EVIDENCE_STORE = FORBIDDEN；L5_RELAXATION = FORBIDDEN；FINAL_ACCEPTANCE_HEAD = 0f7f7ac。

输出请精简结构化（DECISION / KEEP / CHANGE / RISKS / TEST / NEXT / PRODUCTION）。
