> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# STEP_3_RUNTIME_POLICY_WIRING —— EVIDENCE

- 授权：HOST AUTHORIZATION — STEP 3（`SI_RSI_UNIFICATION_V1 = PASS / CLOSED`、`SI_COST_OPTIMIZATION = PASS / CLOSED`）。
- 边界（未解锁）：REAL_MODEL_NETWORK / PAID_MODEL_CALLS / EXTERNAL_WRITE / PAYMENT / TRANSPORT /
  PRODUCTION_CREDENTIALS / PRODUCTION_ENABLEMENT / P2_F / P2_G = HOLD；CUSTOMS real filing = HOLD；
  `SECOND_RUNTIME = 0`；`L5_RELAXATION = FORBIDDEN`。

## 1. 新增 / 修改

| 文件 | 性质 | 职责 |
|---|---|---|
| `apps/api/src/runtime/rsi-domain-pack.ts` | 新增 | domain capability pack 合同 + 唯一派发层 + `describeRsiRuntimeMembers()` |
| `apps/api/src/runtime/recovery-si-pack.ts` | 新增 | Recovery SI = domain pack（policy → guard binding → 只读工具 → 证据） |
| `apps/api/src/runtime/rsi-run.ts` | 修改 | `composeRsiRuntime({ domainPacks })`；`runtimeMembers()`；`domainDispatchLog()` |
| `apps/api/src/__tests__/rsi-domain-pack-wiring.test.ts` | 新增 | 架构回归 + fail-closed 验收（10 例） |
| `apps/api/src/__tests__/rsi-si-runtime-e2e.test.ts` | 新增 | 3G 十条 E2E（2 例） |

## 2. 关键不变量（机械核对）

| 不变量 | 证据 |
|---|---|
| 唯一 runtime 组合点 | 产品代码中**值导入** `createRsiEventLoop` 的文件仅 `runtime/rsi-run.ts`（`STEP3_ARCH_1`） |
| 依赖方向 | `services/autonomy/**` 无 `intelligence/` import（`STEP3_ARCH_2`）；`recovery-policy → rsi-policy-engine` 静态组合存在（`STEP3_ARCH_3`） |
| 无动态注册 / 第二 runtime | `RSI_DOMAIN_PACK_BOUNDARY.dynamicSelfRegistration = FORBIDDEN`；`describeRsiRuntimeMembers().secondRuntime === 0`（`STEP3_ARCH_4`） |
| 未匹配任务 fail-closed | `domain-pack:unmatched` → BLOCK（`STEP3_DISPATCH_1`） |
| pack 不得自授外部写 | 声明 `externalWritePerformed=true` → 派发层降级 BLOCK（`STEP3_DISPATCH_2`） |
| Recovery pack 未绑定任务 | `RECOVERY_PACK_UNBOUND_TASK` → BLOCK（`STEP3_PACK_1`） |
| CUSTOMS 执行类 intent | `resolveGuardAction(...) === null` 且 pack → BLOCK，只读工具零调用（`STEP3_PACK_2`） |
| 只读工具失败 | `RECOVERY_READ_TOOL_FAILED` → BLOCK（`STEP3_PACK_3`） |
| happy path | PASS + `recovery-si:<domain>:<sha12>`；`modelCallCount = 0`；`externalWritePerformed = false`（`STEP3_PACK_4`） |
| 3G 十条链路 | signal → task → policy → pack → 只读工具 → 证据 → park-for-judge → verdict → continuation（`STEP3_E2E_1..9`） |
| restart/reconcile | 过期 lease 恢复、终止态不重放、二次运行 `idempotentNoop = true`（`STEP3_E2E_10`） |

## 3. 命令与结果

| 命令 | 结果 |
|---|---|
| `apps/api npx tsc --noEmit` | exit 0 |
| `npx vitest run src/__tests__/rsi-domain-pack-wiring.test.ts` | 10/10 PASS |
| `npx vitest run src/__tests__/rsi-si-runtime-e2e.test.ts` | 2/2 PASS |
| `npx vitest run rsi-* si-cost-* recovery-* architecture-contract` | 75 files / 750 tests PASS |
| Schema / migration | 无变更（本阶段为接线） |

## 4. 诚实说明（未证明的部分）

- 本阶段为 **local simulation / contract wiring**：`REAL_MODEL_NETWORK` / `PAID_MODEL_CALLS` 仍为 HOLD，
  E2E 未触达任何真实 provider，也未做 Linux/systemd 实机与 durable DB reboot 验证（列在 STEP 3 完成后的后续门）。
- Recovery pack 的 planner / verifier 段仍由 host 以既有 Recovery 入口驱动（本阶段 pack 主路径为
  policy → guard binding → 确定性只读工具 → 证据）；本阶段**未**新增 plan 执行权，也未放宽任何 L5 边界。
