> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# Recovery SI Phase 2 D —— Action Guard dry-run 设计/实施边界（设计请求，零代码）

- 分支：`gate/7-commercial-validation`
- **REVIEWED_HEAD = `79618507`**（当前冻结状态：P2-A/P2-B/P2-C Option A 均已 PASS/CLOSED；本文件为**纯文档设计请求**，所在提交由送审唤醒给出）
- 前置：**MSG-20261005-18 = PASS / CLOSED**（`REVIEWED_HEAD = 180ccb67`；FNV `ecca84bf` / 250 行 / `FULL_COPY_OK`）。该裁决明确：`P2_D_ACTION_GUARD_HANDOFF = NOT_AUTHORIZED`、`P2-C CLOSED ≠ P2-D AUTHORIZED`，并指示「下一步如要继续，应单独送 P2-D Action Guard dry-run 设计/实施边界；不能自动开始」。
- 更早的设计边界：**MSG-20261005-13** 已给出 `P2-D = DESIGN_APPROVED / IMPLEMENTATION_REQUIRES_SEPARATE_AUDIT` 与 D1–D8 最小证据集合。
- 本轮性质：**设计请求**。不实现任何 Action Guard 接线、不调用 executor、不消费审批、不新增 Schema。

## 1. 现有可复用底座（不建第二套）

```text
apps/api/src/services/action-guard/action-guard.ts
  evaluateActionGuard(input: ActionGuardInput): ActionGuardResult   // 纯函数、无副作用、fail closed
  ACTION_GUARD_CATALOG                                             // 唯一动作目录（READ_ONLY / INTERNAL_WRITE / EXTERNAL_WRITE / MONEY_MOVEMENT / SECRET_ACCESS）
Recovery SI（已 CLOSED）
  customer-recovery-state → prioritize → plan → verify → policy（薄适配 rsi-policy-engine）
```

P2-D **只复用** `evaluateActionGuard` 的判定能力，不新建 Guard、不改 `ACTION_GUARD_CATALOG`、不改审批模型。

## 2. P2-D v1 范围（dry-run only）

```text
READY_FOR_EXECUTION（已通过 verifier 的 decision）
  → build Guard request（不可变 execution basis）
  → evaluateActionGuard(...)      （纯函数判定，无副作用）
  → return ALLOW / DENY / REQUIRES_APPROVAL
  到此停止
```

**明确不做**：`→ consume approval → executor → external action`。

不可变 execution basis（送入 Guard 请求的最小集合）：

```text
organizationId
opportunityRef
actionKind        （RecoveryPlanAction.proposedAction）
toolRef           （可选；静态绑定得到，不由模型构造）
planDigest        （对已验证 plan 的确定性摘要，用于"同一份计划"追溯）
```

动作 → Guard action 的映射沿用既有 `recovery-policy`（`RECOVERY_ACTION_TO_POLICY_ACTION`）与 L5 清单：
任何 External Write / Payment / Transport / Production Credentials / Real Claim Submit / Customs Filing /
COMMISSION_CAPTURE / PRODUCTION_ENABLEMENT / KILL_SWITCH_DISABLE 的请求**必须**命中 L5 并被永久拒绝。

## 3. 不变量（本轮不放松）

1. `ACTION_GUARD_DRY_RUN_ALLOW != EXECUTION_AUTHORIZATION`；
2. 即使 Guard 返回 ALLOW，也保持 `executionAuthorized = false`、`executorInvoked = false`、`submitted = false`、`persisted = false`；
3. dry-run **不消费审批**（不写 `recovery.approval_consumed`、不改 approval 状态、不产生 execution attempt）；
4. dry-run **不创建**任何业务事实：`Claim submission` / `CustomsSubmissionAttempt` / `PlatformWriteAttempt` / `Payment` / `Settlement` / `RecoveryLedger` / `Billing` / provider request 全部 0；
5. 只有 **fresh verified plan** 才能产生 Guard request（沿用 `CHANGE_B1`：入口内重新 `prioritizeOpportunities()` + `verifyRecoveryPlan()`；篡改 / 陈旧 → Guard **根本不调用**）；
6. tenant 绑定点：`organizationId` 必须同时等于 plan、state、actor 与 Guard request；不一致 fail-closed；
7. `L5` 请求（External Write / Payment / Customs Filing / Real Claim Submit / credentials）→ **永久拒绝**，不因 dry-run 而放宽；
8. 不建第二套 Runtime；`SECOND_RUNTIME = FORBIDDEN`；`L5_RELAXATION = FORBIDDEN`；不改 `ACTION_GUARD_CATALOG`；不改审批/HITL 语义。

## 4. 最小验收证据（MSG-20261005-13 的 D1–D8，落到 dry-run 语义）

```text
D1  READY decision 必须来自 fresh verified plan；tampered / stale decision → Guard 根本不调用（调用计数 = 0）
D2  organizationId / opportunityRef / action kind / toolRef / plan digest 绑定成不可变 execution basis（basis 被改动 → 拒绝）
D3  tenant mismatch → DENY（且零 Guard 调用或调用后立即 DENY，按实现选择其一并给出证据）
D4  无 approval / 缺 authorization / OWNER gate 缺失 → DENY 或 REQUIRES_APPROVAL（绝不 ALLOW）
D5  dry-run 不消费 approval（approval 事实前后不变，consumed 计数 = 0）
D6  dry-run 不创建：Claim submission / CustomsSubmissionAttempt / PlatformWriteAttempt / Payment /
    Settlement / RecoveryLedger / Billing / provider request（全部计数 = 0）
D7  Guard ALLOW 仍然 executionAuthorized=false、executorInvoked=false
D8  L5 请求（External Write / Payment / Customs Filing / Real Claim Submit / credentials）→ 永久拒绝
```

补充建议的最小证据（可只取其中必要的）：dry-run 结果与 `evaluateActionGuard` 的纯函数结果一致（不引入第二套判定）；
网络调用 = 0；凭据读取 = 0。

## 5. 请求裁定

1. 是否批准 P2-D v1 按**dry-run only**（`READY_FOR_EXECUTION → build Guard request → evaluateActionGuard → ALLOW/DENY/REQUIRES_APPROVAL`）先做设计实施边界？
2. D1–D8 最小证据集合是否足够？是否需要补充（例如 dry-run 与纯函数判定一致性、basis digest 的稳定表达）？
3. Guard request 的不可变 execution basis 字段集合（`organizationId / opportunityRef / actionKind / toolRef / planDigest`）是否可行？`planDigest` 的定义希望采用（a）对已验证 plan 的 canonical JSON 摘要，或（b）既有 repository digest 约定？
4. 是否确认 P2-D v1 **不得**消费审批、不得调用 executor、不得创建任何 submission / payment / ledger / billing / provider request？
5. 是否确认 `P2-E（持久化）/ P2-F（模型）/ P2-G（真实执行）` 仍需各自单独送审，且 `P2-D` 通过也不得自动进入？

请在本次会话中直接回答；不要尝试写回 GitHub。不要使用上一轮缓存。

## 6. 边界声明（本请求不改动）

```text
P2_D = NOT_AUTHORIZED（本请求仅申请设计/实施边界）
P2_E = HOLD_SCHEMA_DELTA
P2_F = HOLD
P2_G = HOLD
P2_C_PERSISTENCE = FORBIDDEN
P2_C_EXTERNAL_WRITE = FORBIDDEN
RSI_OUTCOME_SINK_RUNTIME_WIRING = NOT_AUTHORIZED
RUNTIME_WIRING = NONE
SCHEMA_DELTA_REQUIRED = NO（本请求零 Schema 变更）
EXTERNAL_WRITE = HOLD
PAYMENT = HOLD
TRANSPORT = HOLD
PRODUCTION_CREDENTIALS = HOLD
REAL_CLAIM_SUBMIT = HOLD
CUSTOMS_FILING = HOLD
RSI_MODEL_NETWORK = HOLD
RSI_PAID_MODEL_CALLS = HOLD
SECOND_RUNTIME = FORBIDDEN
L5_RELAXATION = FORBIDDEN
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```
