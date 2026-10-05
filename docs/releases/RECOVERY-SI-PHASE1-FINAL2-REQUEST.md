# Recovery SI Phase 1 —— FINAL-2 送审请求（MSG-20261005-11 三项必修已落地）

- 分支：`gate/7-commercial-validation`；代码送审 HEAD 以 `STATE.CURRENT_HEAD` 为准（本批提交后记录）。
- 上一轮裁决：**MSG-20261005-11 = REVISE**（Phase 1 架构方向 PASS；FNV 04f0b0a8 / 336 行 / FULL_COPY_OK，已逐字归档）。
- 说明：上一轮提到「在 97dfb387 读不到 RECOVERY-SI-PHASE1-AUDIT-REQUEST.md」——该文件在 `8a028ad` 已入库，本 FINAL-2 durable pack 齐备。

## 1. CHANGE A —— 多币种金额语义（原 blocker）

- `recovery-prioritizer.ts`：**无可信 FX 时按 currency 分桶**，组内按 EV 降序，组间按 currency 升序（**不做跨币种金额比较**）。
- USD 计价成本（`providerCostUsd` / `expectedOperationalCostUsd`）**仅在 recoverable 也为 USD 时**参与相减；非 USD 置 0 并给出 `USD_COST_EXCLUDED_NO_FX`。
- `riskPenaltyUsd` 改为与 recoverable **同币种**语义（不做 FX）。
- 字段语义：`expectedRecoveryValue`（同币种）、`expectedRecoveryValueUsd`（仅 USD 非 null）、新增 `rankByCurrency`。
- 边界常量新增 `crossCurrencyMonetaryRanking = false`、`usdCostsOnlySubtractedWhenCurrencyIsUsd = true`。

## 2. CHANGE B —— Verifier 真正 fail-closed

| 项 | 修法 |
| --- | --- |
| ① 租户不符整单拒绝 | `state.tenantVerified !== true` 或 `plan.organizationId !== state.organizationId` 或任一 `opportunity.organizationId !== state.organizationId` → 整单 `halt TENANT_MISMATCH`、`decisions = []` |
| ② 每条事实时效 | 被引用机会的 `observedAt` 同样纳入 stale/future 检查 → 违规项 `STALE_OPPORTUNITY` |
| ③ 金额可篡改 | verifier 接收 `PriorityResult`，校验 `action.expectedRecovery.amount === scored.expectedRecoveryValue` 且 currency 一致，否则 `MONEY_DERIVATION_MISMATCH` |

## 3. CHANGE C —— READY_FOR_EXECUTION 不再表达执行许可

- `decideRecoveryAction("READY_FOR_EXECUTION")` → `allowedForRecoverySi = false`、`requiresOwnerApproval = true`、`reasonCodes += EXECUTION_NOT_AUTHORIZED_IN_PHASE1`。
- supervisor 每条 decision 新增 `executionAuthorized: false`（Phase 1 恒 false）。
- READY marker 保留（决策标记），**不接 Action Guard**；边界常量新增 `readyForExecutionNeverAllowedForSi = true`。

## 4. FINAL-2 最小证据集合（逐条）

| # | 要求 | 证据（测试名） |
| --- | --- | --- |
| 1 | EUR + USD 成本不得出现 `900 EUR − 5 USD = 895 EUR` | `CHANGE_A_NO_USD_COST_ON_EUR`：成本置 0、`USD_COST_EXCLUDED_NO_FX`、EUR 计 900 |
| 2 | USD+EUR 无 FX 时不跨币种比较/统一 EV 排名 | `CHANGE_A_NO_CROSS_CURRENCY_RANKING`：组间按 currency 升序（EUR 在前）+ `rankByCurrency` |
| 3 | 伪造 cross-tenant state → halt TENANT_MISMATCH、decisions [] | `CHANGE_B1_FORGED_CROSS_TENANT_STATE`（绕过 builder 构造污染 state） |
| 4 | state fresh 但 opportunity.observedAt stale → fail-closed | `CHANGE_B2_STALE_OPPORTUNITY` → 该项被拒 |
| 5 | 篡改 plan.expectedRecovery → verifier reject | `CHANGE_B3_TAMPERED_EXPECTED_RECOVERY` → `MONEY_DERIVATION_MISMATCH` |
| 6 | READY_FOR_EXECUTION：`executionAuthorized = false` | `CHANGE_C_READY_IS_NOT_EXECUTION` → decision 双字段 false + 稳定 reasonCode |

测试总计：`recovery-si.test.ts` 11 + `recovery-si-e2e.test.ts` 5 + `recovery-si-revise.test.ts` 6 = **22/22 PASS**；`tsc --noEmit` exit 0。

## 5. 不变边界

```
PHASE1_RUNTIME_WIRING = FORBIDDEN      PHASE1_TOOL_EXECUTION = FORBIDDEN
PHASE2 = SEPARATE_ARCHITECT_APPROVAL_REQUIRED
SCHEMA_DELTA_REQUIRED = NO
EXTERNAL_WRITE / PAYMENT / TRANSPORT / PRODUCTION_CREDENTIALS / REAL_CLAIM_SUBMIT / CUSTOMS_FILING = HOLD
FINAL_ACCEPTANCE_HEAD = 0f7f7ac
```

## 6. 请求裁决

1. CHANGE A / B / C 是否可记 PASS，`RECOVERY_SI_PHASE1` 是否可记 **CLOSED**？
2. §4 六条最小证据是否足够（若需补请只列最小集合）？
3. 是否确认 `SCHEMA_DELTA_REQUIRED = NO` 与 `PHASE1_RUNTIME_WIRING / PHASE1_TOOL_EXECUTION = FORBIDDEN` 继续成立？
