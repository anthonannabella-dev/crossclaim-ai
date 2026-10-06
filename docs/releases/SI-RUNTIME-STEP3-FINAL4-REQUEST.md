> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# STEP_3_RUNTIME_POLICY_WIRING FINAL-4（唯一 product 组装点 + real-adapter runtime E2E）

前置：`MSG-20261005-43`（FINAL-3 裁决）= **PASS WITH REVISE / NOT CLOSED**（CHANGE A = PASS；
CHANGE B = REVISE：adapter 组件 PASS，但「真实进入 ONE SI Runtime 执行链」证据未闭环；`STEP3_FINAL4_REQUIRED = YES`）。

REVIEWED_HEAD = `adcab905`

## ① 唯一 product / static composition 组装点（新增）

* 新增 `apps/api/src/runtime/recovery-si-product-composition.ts`：`createProductRecoverySiPack({ guard | appActionGuardDeps, readPorts, bind })`。
  * 只接受**共享 guard 类型**：`RuntimeActionGuard` 实例，或 `AppActionGuardDeps`（内部调用 `createAppActionGuard`）；
  * **不接受** `RsiRecoveryGuardPort`（调用方自定义 guard port = FORBIDDEN，即原「任意 ALLOW guard 绕过」旁路已被类型与运行时校验双重阻断）；
  * 两者都不提供 → `RECOVERY_SI_PRODUCT_GUARD_REQUIRED`（fail-closed）；
  * 返回的 pack 带 `guardWiring = 'SHARED_ACTION_GUARD_ADAPTER'` 标记，供架构回归断言。
* `composeRsiRuntime` 新增 `productRecoveryPack`：产品 runtime 只通过该唯一组装点把 Recovery SI 接入
  （内部固定 `createSharedRecoveryGuardAdapter(FromAppGuard)`），并把它与 `domainPacks` 合并进同一派发层；
  `productRecoveryPack` 存在时同样**强制 park-for-judge**（不可被 `awaitVerdict:false` 绕过）。
* 边界常量：`RECOVERY_SI_PRODUCT_COMPOSITION_BOUNDARY`（`uniqueAssemblyPoint = true`、
  `callerSuppliedGuardPort = FORBIDDEN`、`secondGuardImplementation = FORBIDDEN`）+
  `RSI_RUNTIME_COMPOSITION_BOUNDARY.productRecoveryPackGuardWiring`。

## ② real-adapter runtime E2E（新增，4 例）

链路（全部真实共享组件，无 stub guard）：`composeRsiRuntime → productRecoveryPack → createProductRecoverySiPack
→ createSharedRecoveryGuardAdapter → createRuntimeActionGuard（capabilities + audit）→ ALLOW → deterministic read tool`。

| 用例 | 驱动方式（真实共享 guard 状态） | 断言 |
|---|---|---|
| STEP3F4_1 | capabilities 正常 + audit 可用 | `read tool > 0`；dispatch log packId = `recovery-si` 且携带 guardActions；ALLOW → PASS |
| STEP3F4_2 | **审计端口缺失**（共享 guard 的既有语义：ALLOW 降级 DENY） | `read tool = 0`（fail-closed，无副作用） |
| STEP3F4_3 | **capabilities 端口抛错**（Control Plane 状态不可用） | `read tool = 0`（degraded，不 fallback） |
| STEP3F4_4 | 唯一组装点必须提供 shared guard | 缺省 → `RECOVERY_SI_PRODUCT_GUARD_REQUIRED`；`callerSuppliedGuardPort = FORBIDDEN` |

补充说明（沿用 FINAL-3 已被裁定 PASS 的部分，未重复扩 scope）：`REQUIRE_APPROVAL → REQUIRES_APPROVAL`、
Kill Switch → `DENY + killSwitchActive`、`DENY → tool = 0`、CUSTOMS / unmapped → Guard 0 / tool 0
由 `recovery-guard-adapter` 的 adapter 级测试（STEP3F3_B2…B5、STEP3F2_B2/B3）与 `rsi-domain-pack-wiring` 覆盖并通过。

## ③ 验证

* `apps/api npx tsc --noEmit` → exit 0
* `rsi-si-runtime-real-guard-e2e` 4/4 PASS（新增）
* `rsi-domain-pack-wiring` 22/22；`rsi-si-runtime-e2e` 5/5（FINAL-3 语义未回退）
* `rsi-* + si-cost-* + recovery-* + architecture-contract` → **76 files / 769 tests PASS**
* 架构不变量：`SECOND_RUNTIME = 0`、第二 event loop / controller / scheduler = 0、Policy Core 唯一、
  Shared Action Guard 唯一、Control Plane 唯一、依赖方向不反转、Recovery SI 仍为 static domain pack、
  `CUSTOMS L5 = PERMANENT BLOCK`、`tools/autopilot/** = DEV_SCOPE`、本阶段 `modelCallCount = 0`
* 如实标注：本地回归证据为 76 files / 769 tests；**不**把它表述为 GitHub CI 证明（本地环境未取到独立 workflow run）。
* **未宣称**：`MODEL_GATEWAY_RUNTIME_WIRED` / `COST_CORE_RUNTIME_WIRED` / `META_IMPROVEMENT_INTEGRATED` 仍为 false。

## ④ 请求裁决（请直接在本会话回答；不要写回 GitHub；不要使用上一轮缓存）

1. 唯一 product 组装点（禁止调用方注入自定义 guard port）是否可记 PASS？
2. real-adapter runtime E2E（ALLOW → tool > 0；审计缺失 / degraded → tool = 0）是否可记 PASS？
3. `STEP_3_RUNTIME_POLICY_WIRING` 是否可记 **PASS / CLOSED**（`STEP3_FINAL5_REQUIRED = ?`）？
4. 若仍需修订，请只列最小集。

边界：REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS /
PRODUCTION_ENABLEMENT = HOLD；P2_F = HOLD / P2_G = HOLD；CUSTOMS real filing = HOLD；
SECOND_RUNTIME / SECOND_POLICY_ENGINE / SECOND_CONTROL_PLANE / SECOND_MODEL_GATEWAY / SECOND_COST_LEDGER /
SECOND_META_EVIDENCE_STORE = FORBIDDEN；L5_RELAXATION = FORBIDDEN；FINAL_ACCEPTANCE_HEAD = 0f7f7ac。

输出请精简结构化（DECISION / KEEP / CHANGE / RISKS / TEST / NEXT / PRODUCTION）。
