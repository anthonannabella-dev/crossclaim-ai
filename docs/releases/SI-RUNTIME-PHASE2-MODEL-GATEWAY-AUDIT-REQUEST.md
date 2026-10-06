> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# PHASE 2 — MODEL GATEWAY RUNTIME 审计请求

前置：`STEP_3_RUNTIME_POLICY_WIRING = PASS / CLOSED`（`MSG-20261005-47`，Reviewed HEAD `795f65a5`，
`STEP3_FINAL8_REQUIRED = NO`）。
本阶段授权：HOST `[CODEX-CONTINUOUS-SI-RSI-POST-FINAL7-180S]` PHASE 2 —— 把现有 `rsi-model-router.ts`
真正接入 ONE SI Runtime（**禁止第二 Model Router**）。

REVIEWED_HEAD = `b7158a7e`

## ① U1 — 唯一 Model Gateway capability port

* 新增 `apps/api/src/runtime/rsi-si-model-gateway.ts`：
  * `createSiModelGatewayPort(deps)` —— 只把既有唯一 Gateway（`services/autonomy/rsi-model-router.ts`）
    包装成 SI Runtime 可注入的 capability port；**本模块不实现任何路由 / 预算 / 缓存 / 质量 / 升级逻辑**；
  * 预算 guard、cache、business-value gate、quality evaluator、bounded strong escalation、
    tenant budget、Cost Safe Mode 全部沿用 Gateway 内部实现；
  * `SI_MODEL_GATEWAY_BOUNDARY = { owner: 'rsi-model-router', secondRouter: 'FORBIDDEN',
    realProviderNetwork: 'HOLD', paidModelCalls: 'HOLD', localSimulationAdapterOnly: true,
    providerFailure: 'fail-closed' }`。
* 接线：`RsiDomainPackContext.modelGateway`（可选）+ `createRsiDomainPackRunner({ modelGateway })`
  + `composeRsiRuntime.productRecoveryPack.modelGateway`；边界常量
  `RSI_RUNTIME_COMPOSITION_BOUNDARY.siModelGatewayWiring = OPTIONAL_PORT（owner = rsi-model-router；
  SECOND_MODEL_ROUTER = FORBIDDEN）`。缺省不注入 = deterministic-first（不触达模型）。

## ② U2 — SI Runtime 端到端模型链 E2E（local simulation adapter）

链路：`signal → task → Policy Core → product Recovery Pack → Shared Action Guard → Model Gateway port
→ evidence → proposal → Judge → verdict`。

| 用例 | 断言 |
|---|---|
| P2U2_1 | product Recovery 链路 + gateway port → 经 `recovery-si` 派发；强制 park-for-judge（`waitingForVerdict=true`、`verdict=null`、proposal 非空）；external verdict 才完成 |
| P2U2_2 | **budget guard 不可绕过**：provider 缺 pricing → `BUDGET_GUARD_UNENFORCEABLE`、`called=false`、provider 调用 **0** |
| P2U2_3 | **Cost Safe Mode 拒绝** → `called=false`、reason `AI_COST_SAFE_MODE:DAILY`、provider 调用 **0** |
| P2U2_4 | **quality gate 不可由模型自证**：cheap 成功 + 无 evaluator → **不升级 strong（0）**；evaluator FAIL → 有界升级（两次调用 strong ≤ 1，受 `AI_ESCALATION_HARD_CAPS`） |
| P2U2_5 | 边界：`owner = rsi-model-router`、`SECOND_ROUTER = FORBIDDEN`、`REAL_PROVIDER_NETWORK / PAID_MODEL_CALLS = HOLD`；共享 Action Guard 唯一实现仍在位 |
| P2U1_1..3 | port 委托共享 Gateway 并返回可审计 usage；pack 通过 context 取到 port、缺省为 deterministic-first；架构回归：产品代码 `createRsiModelRouter` 调用点仅 `rsi-model-router.ts` + `rsi-si-model-gateway.ts`（无第二 Router） |

## ③ 验证（本地）

* `apps/api npx tsc --noEmit` → exit 0
* `rsi-si-model-gateway` 3/3、`rsi-si-model-chain-e2e` 5/5（新增）
* `rsi-* + si-cost-* + recovery-* + architecture-contract` → **78 files 全绿**
* 如实标注：**`GITHUB_CI = NOT_OBSERVED`**（本批 commit 未取到 Actions workflow run；不得表述为 CI 已绿）
* **未宣称**：`MODEL_GATEWAY_RUNTIME_WIRED` = **false**（无真实 provider E2E）；
  `REAL_MODEL_NETWORK` / `PAID_MODEL_CALLS` = **HOLD**（仅 local simulation adapter）。
* 修正记录（如实）：U2 首版断言曾假设「无 evaluator → 完全禁止升级」；按已被裁定 PASS 的 C1 语义
  （provider 失败即确定性 FAIL、可升级一次；cheap **成功** 才必须经 server-side evaluator）修正的是**断言**，未改代码。

## ④ 请求裁决（请直接在本会话回答；不要写回 GitHub；不要使用上一轮缓存）

1. U1（唯一 Model Gateway capability port，禁第二 Router）是否可记 PASS？
2. U2（端到端模型链 E2E：budget guard / Cost Safe Mode / quality gate / 有界升级 / park-for-judge）是否可记 PASS？
3. `PHASE_2_MODEL_GATEWAY_RUNTIME` 是否可记 **PASS / CLOSED**（`PHASE2_FINAL_REQUIRED = ?`）？
4. 是否可以进入 PHASE 3（ACTION RUNTIME：provider adapter interface / credential port / idempotency /
   exactly-once / retry-reconcile / external-write gate / HITL / provider result normalization / sandbox-mock /
   failure-degraded / audit-evidence），并保持真实 provider 逐个开闸、当前全部 HOLD？

边界：REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS /
PRODUCTION_ENABLEMENT / P2_F / P2_G / CUSTOMS real filing = HOLD；SECOND_RUNTIME / SECOND_POLICY_ENGINE /
SECOND_CONTROL_PLANE / SECOND_MODEL_GATEWAY / SECOND_COST_LEDGER / SECOND_META_EVIDENCE_STORE = FORBIDDEN；
L5_RELAXATION = FORBIDDEN；`MODEL_GATEWAY_RUNTIME_WIRED` / `ACTION_RUNTIME_PRODUCTION_ENABLED` /
`META_IMPROVEMENT_INTEGRATED` / `PRODUCTION_READY` 在无真实 E2E 前一律保持 false。

输出请精简结构化（DECISION / KEEP / CHANGE / RISKS / TEST / NEXT / PRODUCTION）。
