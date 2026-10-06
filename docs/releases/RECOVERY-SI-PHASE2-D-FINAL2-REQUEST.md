> **[HISTORICAL_SNAPSHOT]** 本文是历史审计 / 证据快照，原文保留不改写（历史裁决不删除）。
> 其中关于 `RUNTIME_WIRING` / `STEP_3_RUNTIME_POLICY_WIRING` / `RSI_OUTCOME_SINK_RUNTIME_WIRING`
> 的**当时状态**已被后续实现取代：SUPERSEDED_BY=c0b61792（STEP_3_RUNTIME_POLICY_WIRING：
> Recovery SI 作为 domain capability pack 接入 ONE CrossClaim SI Runtime；后续 FINAL-2..6 与 PHASE 2
> 见 ca23b1df / adcab905 / ca298187 / 5f9ce46f / 6e98e66e）。
> 唯一**现行**状态请以 `docs/releases/CURRENT-SI-RSI-STATUS.md` 为准
> （SUPERSEDED_BY=cdd95258 为该状态件的基线 HEAD）。

# Recovery SI P2-D v1 FINAL-2 — 审计请求（CHANGE D1 / D2 + F2D-01..04）

**REVIEWED_HEAD = 638c9561**（FINAL-2 实现提交：`apps/api/src/services/intelligence/recovery-guard-dry-run.ts` + `apps/api/src/__tests__/recovery-si-phase2-d.test.ts` + `docs/releases/RECOVERY-SI-PHASE2-D-FINAL2-EVIDENCE.md`）

- 前置裁决：**MSG-20261005-20 = REVISE（很窄）**（必修 A = PASS、必修 B = PASS；`D1 = REVISE`、`D4 = REVISE`（真实 Control Plane 语义未证明）、`D7 = REVISE`（缺 submitted/persisted））。
- 上一轮实现提交：`5aaf7389`；上一轮送审包：`24d11970`；上一次裁决归档提交：`bbd75c0e`。

## 本轮范围（仅补裁决要求的最小集，未扩大授权）

### CHANGE D1（已实现）
执行入口在任何 Action Guard 调用**之前**重算 canonical plan：

```
canonicalPlan = planRecovery({ state, ranked: prioritizeOpportunities(state).ranked, registry, generatedAt: state.observedAt })
canonicalReady = { opportunityRef → canonical READY_FOR_EXECUTION action }
```

并要求 supplied action 与 canonical action 的 **execution-relevant identity** 完全一致
（`domain / opportunityRef / proposedAction / toolRef / executionMode / authorizationRequired / ownerApprovalRequired / expectedRecovery{amount,currency}`，金额用 canonical decimal、币种大写）。
不一致或缺失 → `decision=DENY`、`code=CANONICAL_READY_MISMATCH`、`guardEvaluated=false`（**零 Guard 调用**）。

### CHANGE D2（已实现）
`RecoveryGuardDryRunOutcome` 恒定包含 `submitted:false` / `persisted:false`（与 `executionAuthorized` / `executorInvoked` / `approvalConsumed` 并列）；`RECOVERY_GUARD_DRY_RUN_BOUNDARY` 增加 `canonicalReadyAlignment`。无 Schema 变更。（对应的 `D4` 证据见 F2D-03。）

## 最小证据（F2D-01..04）

| 证据 | 断言 |
| --- | --- |
| `F2D-01` | `authorizationReady=false`（canonical = `REQUEST_AUTHORIZATION`）动作被篡改成 `READY_FOR_EXECUTION` → Guard 调用 **0**，无 ALLOW |
| `F2D-02` | `riskClass=HIGH`（canonical = `REQUEST_OWNER_APPROVAL`，`ownerApprovalRequired=true`）被篡改成 `READY_FOR_EXECUTION` → Guard 调用 **0**，无 ALLOW |
| `F2D-03` | **真实** `createProductionControlPlane()`（kill switch enabled / `mode=WRITE_ENABLED` / `productionGate=SATISFIED` / platform+tenant `claim.submit` 开启 / 无 `approvalId`）→ `guardEvaluated=true`、`guardCallCount=1`、**REQUIRES_APPROVAL** |
| `F2D-04` | Guard 返回 ALLOW 时 `executionAuthorized/executorInvoked/submitted/persisted/approvalConsumed` 全为 `false` |

## 不变量

`ACTION_GUARD_DRY_RUN_ALLOW != EXECUTION_AUTHORIZATION`；不消费审批；不调用 executor；不写业务事实；不创建 Claim submission / CustomsSubmissionAttempt / PlatformWriteAttempt / Payment / Settlement / RecoveryLedger / Billing；零 provider、零凭据；L5 永久拒绝；`CUSTOMS` 仍映射为 `null`（未偷换成 `customs.recovery.start`）。

## 测试与静态检查（本地归档证据）

- `npx tsc --noEmit` → exit 0。
- `recovery-si-phase2-d.test.ts` → **14/14 PASS**（D1–D10 + F2D-01..04）。
- 回归 → `recovery-si`(11) + `recovery-si-e2e`(5) + `recovery-si-revise`(6) + `recovery-si-phase2-ab`(19) + `recovery-si-phase2-c`(10) + `action-guard`(10) + `action-guard-approval-verifier`(9) = **70/70 PASS**。

## Schema Delta

`SCHEMA_DELTA_REQUIRED = NO`；无迁移、无 Prisma 引用、无 `ACTION_GUARD_CATALOG` 变更、审批 / HITL 语义未改动、`RUNTIME_WIRING = NONE`。

## 请求裁决

1. `CHANGE D1` / `CHANGE D2` 是否可记 **PASS**，`D1` / `D7` 是否可翻转，`D4`（真实 Control Plane 语义）是否因 `F2D-03` 成立；
2. `F2D-01..04` 是否足够 → `P2_D_V1_IMPLEMENTATION` 是否可 **CLOSED**（`FINAL3_REQUIRED = ?`）；
3. 是否确认四类 FORBIDDEN（APPROVAL_CONSUMPTION / EXECUTOR_INVOCATION / BUSINESS_FACT_WRITE / EXTERNAL_ACTION）与 `P2_E = HOLD_SCHEMA_DELTA`、`P2_F = HOLD`、`P2_G = HOLD` 继续各自单独送审；
4. 是否确认进入真实执行必须另开 **P2-G**（executor identity / approval 真实性 / provider transport / external-write gate / kill switch / real credentials / reconciliation），且当前 `PLATFORM|CARRIER|INDEPENDENT_SITE → claim.submit` 只是 dry-run 的保守分类，不得直接当 P2-G 的真实 executor identity；
5. 若仍需修订，请只列最小集合。

`FINAL_ACCEPTANCE_HEAD = 0f7f7ac`（未改动）。
