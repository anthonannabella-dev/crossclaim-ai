# Success Fee / Billing **永久红线**（R46 前置约束）

> 配套契约：**R13** —— `docs/releases/PAYMENT-AUTHORIZATION-AND-ONBOARDING-CONTRACT.md`（Platform OAuth ≠ Payment Authorization；Onboarding 免费扫描不得强制绑卡；无有效 Payment Authorization 只出账单不扣款；不保存 PAN/CVV；autopay 属独立 Payment Activation Gate · HOLD）。

> 依据：**HOST DIRECTIVE 2026-10-02**（宿主补充的永久红线，独立于任何单批裁决）。
> 状态：**永久生效** —— 写入 `.autopilot/RULES.md` R12 与 `.autopilot/rules.json#success_fee_billing_redline`，
> 由 `tools/autopilot/check-autopilot-rules.mjs` 在 CI 强制。
> 队列影响：**不改变**当前 R45 执行队列（S2 送审中 → S3 → S4 → S5），不重新规划、不重复审计已 PASS 底座。

---

## 0. 一句话红线

**`Reimbursement observed ≠ recovered ≠ billable`** —— 只有系统通过 reconciliation 确认真实到账，并形成合法的
`Settlement = RECEIVED`（及对应 `RecoveryLedger` 事实）之后，才允许计算 Success Fee 与生成 `BillingInvoice`。

链路口径（冻结）：`Reconciliation → Confirmed Settlement → RecoveryLedger → FeeCalculation → BillingInvoice → Payment`。
`Payment` 自动扣款属于**独立的 Production / Payment Authorization Gate**，当前 **HOLD**。

---

## 1. 可计费判定（billable predicate，逐条必须同时成立）

计算 Success Fee / 生成 BillingInvoice 前，必须能证明该笔金额满足：

| # | 条件 | 既有 Schema 落点 |
| --- | --- | --- |
| 1 | 到账轴为**真实到账** | `Settlement.status = RECEIVED`（`PARTIAL` 只能按**已到账部分**计费） |
| 2 | 业务确认轴为**已确认** | `Settlement.confirmationStatus = CONFIRMED`（`PENDING_CONFIRMATION` / `REJECTED_BY_REVIEW` 一律不可计费） |
| 3 | 对账轴为**已对账** | `Settlement.reconciliationStatus ∈ { RECONCILED, PARTIAL }`（`NOT_STARTED` / `DISPUTED` / `REVERSED` 一律不可计费） |
| 4 | 到账可追溯 | `Settlement.evidenceId` 非空（悬空证据不可计费） |
| 5 | 未被冲回 | `Settlement.reversedBySettlementId IS NULL`，且不存在未收口的 reversal 链 |
| 6 | 金额来源确定 | 计费基数只能取自**已确认到账**的 `Settlement.amount`（`PARTIAL` 取已到账部分）与对应 `RecoveryLedgerEntry`；**不得**取自 `ReimbursementFact.amount`、平台 approved 状态或 ClaimItem 金额字段 |
| 7 | 费率与依据确定 | 费率来自既有 `FeeCalculation`（`FeeBasis` 为 `RECOVERED_AMOUNT_PCT` / `FIXED` / `TIERED`）；`FeeBasis = NONE` 不得开票；金额 > 0 且币种为 3 位大写 |
| 8 | 幂等与依据唯一 | 遵循既有 `billing.draft` 受保护动作口径：锁后重读费用依据、禁止把已关联他账单的依据复用到新账单、无有效依据 → 409 `BILLING_BASIS_REQUIRED` |

> 判定必须由**确定性代码 / SQL / 既有领域服务**执行；LLM 只能用于解释与草稿文本，不得参与判定结果。

---

## 2. 明确禁止（fail-closed 清单）

1. **仅因平台显示 approved 就收费** —— accepted/approved 是 provider outcome 事实，不等于到账。
2. **仅因 reimbursement observed 就收费** —— `ReimbursementFact(kind=OBSERVED)` 只是观察事实。
3. **未确认到账就收费** —— 无 `Settlement = RECEIVED`（或 partial 的已到账部分）不得产生任何费用或账单。
4. **partial recovery 按 full recovery 收费** —— 只能按已确认到账金额计费；未到账差额不得预收。
5. **reversal / correction 后继续按旧金额收费** —— 冲正必须触发重新计算（重算后依据变更，不得沿用旧 `BillingInvoice` 金额）。
6. **AI 直接决定 recovered amount 或 fee** —— 金额、费率、账本、结算一律由确定性逻辑决定。
7. **未经客户明确预授权自动扣款** —— 自动扣款属独立 Gate（见 §4）。

补充（沿用既有冻结口径）：不得把 projection / `FULLY_RECONCILED` 当作历史事实；不得由人工 override 直接改写原始事实后计费；
不得绕过 Tenant Isolation · RBAC · Approval/HITL · Action Guard · Idempotency · Transaction · Ledger invariants。

---

## 3. reversal / correction 的强制重算

- 冲正以**新事实**表达（`Settlement.reversedBySettlementId` / `ReimbursementFact(kind=REIMBURSEMENT_REVERSED)`），不覆盖历史；
- 冲正后相关 `FeeCalculation` 必须重新计算；已签发账单进入既有受控状态机（`VOID` / `WRITTEN_OFF`），**不得**直接改金额；
- 任何「旧金额继续计费」的路径一律视为 **fail-closed 缺陷**，按缺陷修复且不得以文档说明替代。

---

## 4. 自动扣款 = 独立 Production / Payment Authorization Gate（当前 HOLD）

| 项 | 状态 |
| --- | --- |
| 自动扣款 / Payment 采集 | **HOLD**（不属于 R46；需独立 Gate 裁决） |
| 开启前置条件 | ① 客户**明确预授权**（可追溯的授权事实与撤销路径）；② 支付通道**正式验收**（生产凭据、webhook 验签、对账、退款/争议路径）；③ 经架构方与宿主书面放行 |
| 生产凭据 / 生产支付接入 | **HOLD**（HOST APPROVAL REQUIRED） |

在 Gate 放行前，系统最多只能生成**账单事实**（`BillingInvoice`）与草稿/通知类产物，**不得**发起任何扣款动作。

---

## 5. 与既有 Gate / 队列的关系

- 本红线**不改变** R45 执行队列（S1 CLOSED → S2 送审中 → S3 → S4 → S5）与 R46 的排期位置；
- R46 进入实施前的任何设计/计划，必须显式引用本文件并逐条对应 §1 / §2；
- 已 PASS 的底座（Tenant Isolation / HITL / Action Guard / Ledger / CAS / Row Lock / 幂等 / reconcile）**继续冻结**，本红线不构成重新设计理由；
- 本红线属于「资金链路 + 合规」类边界：任何触及计费基数、费率、账本或扣款时序的改动，仍必须回架构方审计。

---

## 6. 本轮状态字段（涉及计费/资金时输出）

```
BILLING_REDLINE_APPLIED = YES / NO
BILLABLE_PREDICATE_SATISFIED = YES / NO / N-A
SETTLEMENT_RECEIVED_CONFIRMED = YES / NO / N-A
REVERSAL_RECOMPUTED = YES / NO / N-A
AI_DECIDED_AMOUNT_OR_FEE = NO（恒为 NO；出现即缺陷）
AUTO_DEBIT = HOLD（恒为 HOLD，直到独立 Gate 放行）
```
