# Recovery SI P2-D v1 — FINAL-2 证据（CHANGE D1 / D2 + F2D-01..04）

- 依据裁决：**MSG-20261005-20 = REVISE（很窄）**；必修 A（静态 Guard-action 映射）/ 必修 B（可信 Control Plane）已 PASS，本轮只补 D1 / D4 证据 / D7。
- 模块：`apps/api/src/services/intelligence/recovery-guard-dry-run.ts`；测试：`apps/api/src/__tests__/recovery-si-phase2-d.test.ts`。
- 本轮仍未触碰：`APPROVAL_CONSUMPTION` / `EXECUTOR_INVOCATION` / `BUSINESS_FACT_WRITE` / `EXTERNAL_ACTION`（全部 FORBIDDEN）、Schema、`ACTION_GUARD_CATALOG`、审批 / HITL 语义、Runtime wiring。

## CHANGE D1 — supplied READY 必须等于内部重算的 canonical planner READY

新增（只读、模块内）：

```
const canonicalPlan = planRecovery({ state, ranked: priority.ranked, registry, generatedAt: state.observedAt });
const canonicalReady = new Map(...canonicalPlan.actions where proposedAction === 'READY_FOR_EXECUTION');
const executionIdentity = (action) => stableStringify({
  domain, opportunityRef, proposedAction, toolRef, executionMode,
  authorizationRequired, ownerApprovalRequired,
  expectedRecovery: { amount: canonicalDecimal(amount), currency: upper(currency) } | null,
});
```

执行入口在**任何 Guard 调用之前**要求 `canonicalReady.get(opportunityRef)` 存在且 `executionIdentity(canonical) === executionIdentity(supplied)`；否则

```
decision = DENY
code = CANONICAL_READY_MISMATCH
guardEvaluated = false        // 零 Guard 调用
```

该门一次性挡住：缺 authorization、HIGH-risk OWNER gate、provider HOLD、evidence incomplete、PREPARE tool 缺失、金额/币种篡改、actionKind 升级（`REQUEST_AUTHORIZATION` / `REQUEST_OWNER_APPROVAL` / `WAIT_PROVIDER` → `READY_FOR_EXECUTION`）。
`generatedAt` 不参与 identity（重算使用 `state.observedAt` 作为稳定值，且 projection 与 `plan-digest/v1` 一致地排除展示字段）。

## CHANGE D2 — outcome 冻结字段补齐

`RecoveryGuardDryRunOutcome` 现在恒定包含：

```
executionAuthorized: false
executorInvoked: false
submitted: false
persisted: false
approvalConsumed: false
```

即 Guard 返回 ALLOW 时也**只表示「当前只读快照下 Guard policy 没有阻止」**，绝不表示业务状态已推进。`RECOVERY_GUARD_DRY_RUN_BOUNDARY` 新增 `canonicalReadyAlignment` 说明。

## 最小 FINAL-2 证据（F2D-01..04）

| 证据 | 内容 | 结果 |
| --- | --- | --- |
| `F2D-01` | `authorizationReady=false`（canonical planner = `REQUEST_AUTHORIZATION`）被篡改成 `READY_FOR_EXECUTION` | Guard 调用 **0**；无 ALLOW |
| `F2D-02` | `riskClass=HIGH`（canonical planner = `REQUEST_OWNER_APPROVAL`，`ownerApprovalRequired=true`）被篡改成 `READY_FOR_EXECUTION` | Guard 调用 **0**；无 ALLOW |
| `F2D-03` | **真实** `createProductionControlPlane()`（kill switch enabled / mode `WRITE_ENABLED` / `productionGate=SATISFIED` / platform+tenant feature 开启 / 无 `approvalId`）+ `claim.submit` | `guardEvaluated=true`、`guardCallCount=1`、decision = **REQUIRES_APPROVAL**（绝不 ALLOW） |
| `F2D-04` | Guard 返回 ALLOW | `executionAuthorized/executorInvoked/submitted/persisted/approvalConsumed` 全为 `false` |

## 执行证据

- `npx tsc --noEmit`：exit 0（apps/api）。
- `recovery-si-phase2-d.test.ts`：**14/14 PASS**（D1–D10 + F2D-01..04）。
- 回归：`recovery-si` / `recovery-si-e2e` / `recovery-si-revise` / `recovery-si-phase2-ab` / `recovery-si-phase2-c` / `action-guard` / `action-guard-approval-verifier` = **70/70 PASS**（7 files）。
- 无 Schema 变更、无迁移、无 `@prisma/client`、无网络 / 凭据读取、`RUNTIME_WIRING = NONE`。

## 边界（不变）

```
P2_D_DRY_RUN_ONLY = AUTHORIZED
APPROVAL_CONSUMPTION = FORBIDDEN
EXECUTOR_INVOCATION = FORBIDDEN
BUSINESS_FACT_WRITE = FORBIDDEN
EXTERNAL_ACTION = FORBIDDEN
P2_E = HOLD_SCHEMA_DELTA
P2_F = HOLD
P2_G = HOLD
SCHEMA_DELTA_REQUIRED = NO
RUNTIME_WIRING = NONE
EXTERNAL_WRITE = HOLD
PAYMENT = HOLD
TRANSPORT = HOLD
PRODUCTION_CREDENTIALS = HOLD
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
