# RECOVERY CONFIRMATION DESIGN — CrossClaim AI

> 状态：**DESIGN ONLY（未实现）** · 依据架构方 **MSG-20260929-20：Recovery Confirmation = DESIGN-FIRST**
> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29
> 纪律：本设计**不改变金额口径**、不启用自动扣佣（HOLD）、不引入 migration。

---

## 1. 现状基线

| 能力 | 现状 |
|---|---|
| 回收确认入口 | `POST /cases/:caseId/recovery-outcome`（服务 `confirmRecoveryOutcome`） |
| 入参 | `{ recoveredAmount, currency, basisReference, evidenceArtifactId?, note? }` |
| 产出（同事务） | `Settlement` + `RecoveryLedgerEntry` + `FeeCalculation` + `BillingInvoice` |
| 返回 | `{ settlementId, ledgerEntryId, feeCalculationId, billingInvoiceId, recoveredAmount, feeAmount, created, exceedsClaim }` |
| 幂等 | 以 `basisReference` 为幂等键（重复提交返回 `created=false`） |
| 高额卡口 | `recovery-review`：> $1000 需 OWNER/ADMIN 复核（REQUEST/APPROVE/REJECT） |
| 佣金对账 | `POST /commissions/reconcile`（dry-run 默认、只建 DRAFT、永不自动置 PAID） |
| 支付域 | `Payment/PaymentEvent/PaymentProcessingAttempt`（执行与恢复已建；真实扣款 HOLD） |
| 货币校验 | 已存在 `CURRENCY_MISMATCH`、`exceedsClaim` 判定 |

**缺口**：确认的是「我方记录的回收事实」，缺的是与**平台实际到账**的显式对齐（payout 引用、部分到账、跨期到账、冲回/争议）。

---

## 2. 目标与非目标

目标：
1. 把「回收确认」拆成**可核对的两段**：业务确认（我方证据）→ 资金核对（平台到账）。
2. 支持**部分到账**与**多期到账**，且任何时点都能回答「这笔钱是否已与账单对齐」。
3. 与 Claim Tracking 终局态显式衔接（只允许 APPROVED / PARTIALLY_APPROVED 进入确认）。
4. 为财务提供稳定只读投影（差异清单已存在，扩展即可）。

非目标：
- 不自动扣佣、不自动置 PAID（HOLD 保持）。
- 不改变 15% 成功费口径与计算实现（`FeeCalculation` 语义不动）。
- 不接真实支付通道（Stripe 真实动作仍等宿主授权）。

---

## 3. 状态模型（建议）

```
PENDING_CONFIRMATION
   ├──(人工确认业务回收)──▶ CONFIRMED
   │                          ├──(到账引用录入)──▶ RECONCILED
   │                          ├──(金额/币种不符)──▶ DISPUTED
   │                          └──(冲回/拒付)────▶ REVERSED
   └──(证据不足)──▶ REJECTED_BY_REVIEW
```

规则：
1. `PENDING_CONFIRMATION → CONFIRMED` 必须带 `basisReference` + 至少 1 条证据（`evidenceArtifactId`）。
2. 高额（> $1000）在 `CONFIRMED` 之前必须有 `recovery-review` 的 APPROVE 记录。
3. `RECONCILED` 必须提供外部到账引用（`payoutRef`）且金额与币种匹配；部分到账允许，但需累计对齐（见 §4）。
4. `REVERSED` 不删除原记录：以**冲回分录**表达（沿用账本追加式语义）。
5. 所有状态迁移写 `AuditLog`（actor/时间/from→to/引用）。

---

## 4. 部分到账与多期到账

- 一次确认对应**一笔应收**（`recoveredAmount`），到账可以分多次 `payout` 引用累加；
- 维护 `confirmedAmount` 与 `receivedAmount` 两个只读投影：
  - `receivedAmount < confirmedAmount` → `PARTIALLY_RECONCILED`
  - 相等 → `RECONCILED`
  - 超出 → 进入 `DISPUTED`（不自动调整金额，必须人工处置）
- 跨期到账不改变原 `basisReference`；每笔到账独立留痕（引用 + 时间 + 金额 + 币种）。

---

## 5. 建议的 Schema Delta（仅获批后另提 Delta Request）

| # | 变更 | 目的 | 备注 |
|---|---|---|---|
| R1 | `Settlement.confirmationStatus`（枚举，默认 `CONFIRMED`） | 表达核对进度 | 兼容既有行为 |
| R2 | `Settlement.confirmedByUserId` / `confirmedAt` | 人工确认留痕 | 与 Claim 的批准留痕同构 |
| R3 | `RecoveryPayout`（新表：`organizationId, settlementId, payoutRef, amount, currency, receivedAt, sourceType, createdBy`，唯一 `(organizationId, payoutRef)`） | 记录平台到账与幂等 | 仅在获批后建 |
| R4 | `Settlement.reversedBySettlementId String?` | 冲回链 | 不删除原记录 |
| R5 | 索引 `(organizationId, confirmationStatus)`、`RecoveryPayout(organizationId, receivedAt)` | 看板与对账 | 普通索引 |

> R3 是本设计唯一的**新表**；若架构方倾向不新增表，可退化为「`Settlement.payoutRefs` JSON 数组 + 审计」，但会牺牲幂等与查询能力（见 §9 决策点）。

---

## 6. 权限（沿用既有矩阵）

| 动作 | OWNER | ADMIN | OPS | FINANCE | VIEWER |
|---|---|---|---|---|---|
| 确认业务回收 | ✅ | ✅ | ✅ | ✅ | ❌ |
| 录入到账引用 | ✅ | ✅ | ❌ | ✅ | ❌ |
| 判 DISPUTED / REVERSED | ✅ | ✅ | ❌ | ✅ | ❌ |
| 高额 APPROVE | ✅ | ✅ | ❌ | ❌（仅可 REQUEST） | ❌ |

---

## 7. 幂等与并发

1. 业务确认：沿用 `basisReference` 幂等（已实现）。
2. 到账录入：`(organizationId, payoutRef)` 唯一；重复录入幂等命中，不重复累加。
3. 状态迁移：CAS（`updateMany where confirmationStatus = expectedFrom`），冲突返回稳定错误码。
4. 并发对账：以 Settlement 行为准，写投影而非复算历史。

---

## 8. 失败模式

| 场景 | 处理 |
|---|---|
| 金额不符 | `DISPUTED` + 差异清单可见；**不自动改账** |
| 币种不符 | 复用既有 `CURRENCY_MISMATCH` 拒绝 |
| 超过 Claim 金额 | 复用既有 `exceedsClaim` 判定并标记 |
| 到账后才知冲回 | 以冲回分录 + `REVERSED` 表达，保留历史 |
| 重复到账引用 | 幂等命中，不重复累加 |
| 缺证据 | `REJECTED_BY_REVIEW`（人工） |

---

## 9. 待你裁决的决策点

| # | 问题 | Codex 建议 |
|---|---|---|
| D1 | 是否新增 `RecoveryPayout` 表（R3） | 建议**新增**（幂等与对账查询都需要；JSON 方案会在真实到账场景失效） |
| D2 | 部分到账是否需要独立状态 | 建议**要**（`PARTIALLY_RECONCILED`），否则财务无法区分「未到」与「到一半」 |
| D3 | 冲回是否影响已生成账单 | 建议**不自动改**，由 FINANCE 人工处置（保持「不自动修账」原则） |
| D4 | 与既有 `payment-reconciliation` 的关系 | 复用其差异清单，确认层只做投影，不重复实现 |
| D5 | 自动扣佣是否随本设计推进 | **不**（HOLD 保持；需商业证据 + 合规 + 宿主授权） |

---

## 10. 请裁决

NEED: **GO / REVISE / HOLD**（RECOVERY-CONFIRMATION-DESIGN），并请对 §9 的 D1–D4 给结论（D5 建议维持 HOLD）。

若 GO：我先提交独立 **Schema Delta Request**（R1–R5），获准后实现 `confirmationStatus` 投影、到账录入与幂等、只读对账视图，并补单测 + 真实库集成 + 并发/幂等用例，随后提交 Implementation Checkpoint。
