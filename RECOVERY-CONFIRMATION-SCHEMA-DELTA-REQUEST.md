# RECOVERY CONFIRMATION — SCHEMA DELTA REQUEST（R2 · REVISE 后修订）

> 类型：**Schema Delta Request（仅请求批准；不含 migration、不含实现）**
> PREVIOUS: **MSG-20260929-24 = REVISE**（方向批准；要求拆分确认/对账语义、明确历史默认状态与金额来源）
> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29 · ROUND: **R2**

---

## 0. 对 MSG-20260929-24 的三项 CHANGE 逐条回应

| CHANGE | 裁决要求 | 本次修订 |
|---|---|---|
| C1 | **Confirmation（确认事实）与 Reconciliation（到账事实）必须拆开** | 拆成**两个独立字段**：`confirmationStatus`（业务确认）+ `reconciliationStatus`（到账核对）；两者互不覆盖 |
| C2 | **明确历史 Settlement 的默认状态** | `confirmationStatus` 默认 `CONFIRMED`（历史回收都经过人工确认）；`reconciliationStatus` 默认 `NOT_STARTED`（当时无到账数据） |
| C3 | **明确 confirmedAmount 来源 + RecoveryPayout 是否唯一事实来源** | 确认金额 = **既有 `Settlement.recoveredAmount`**（不新增金额字段）；到账事实以 **`RecoveryPayout` 为唯一事实来源**；`receivedAmount` 为**计算投影**（Σ payouts），**不落库** |

> 结论：C1 的根因是「一个状态字段同时表达两件事」。修订后，确认与对账各自独立演进，任一侧变化都不污染另一侧。

---

## 1. 修订后的请求内容

### 1.1 `Settlement` 扩展（不改现有字段语义）

| # | 变更 | 类型 / 默认 | 可空 | 含义 |
|---|---|---|---|---|
| R1a | `confirmationStatus` | 枚举 `SettlementConfirmationStatus`，默认 `CONFIRMED` | 否 | **业务确认**：这笔回收是否已被人工确认为事实 |
| R1b | `reconciliationStatus` | 枚举 `SettlementReconciliationStatus`，默认 `NOT_STARTED` | 否 | **到账核对**：平台/银行到账与确认金额的对齐进度 |
| R2a | `confirmedByUserId` | `String?` | 是 | 业务确认留痕 |
| R2b | `confirmedAt` | `DateTime?` | 是 | 业务确认时间 |
| R4 | `reversedBySettlementId` | `String?` | 是 | 冲回链（不删除原记录；冲回由 FINANCE 处置，D3） |

**两个新枚举**（拆分语义的核心）：

```
SettlementConfirmationStatus      = CONFIRMED | PENDING_CONFIRMATION | REJECTED_BY_REVIEW
SettlementReconciliationStatus    = NOT_STARTED | PARTIAL | RECONCILED | DISPUTED | REVERSED
```

- `confirmationStatus` 回答「我方是否确认这笔回收成立」；
- `reconciliationStatus` 回答「钱是否真的到账、到了多少、是否有问题」；
- 二者**没有隐含映射**：例如 `CONFIRMED + NOT_STARTED`（已确认但尚未到账）是完全正常的状态。

### 1.2 新表 `RecoveryPayout`（D1 GO；到账事实的**唯一来源**）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `String @id` | uuid |
| `organizationId` | `String` | 租户（须与 Settlement 同租户） |
| `settlementId` | `String` | 指向 Settlement（既有列名）；**金额不写在 Settlement 上** |
| `payoutRef` | `String` | 平台/银行到账引用（幂等键） |
| `amount` | `Decimal(18,4)` | 到账金额（唯一金额来源） |
| `currency` | `String` | 币种 |
| `receivedAt` | `DateTime` | 到账时间 |
| `sourceType` | `String` | `PLATFORM_SETTLEMENT` / `BANK_TRANSFER` / `OTHER`（枚举化） |
| `createdBy` | `String?` | 录入人 |
| `createdAt` | `DateTime @default(now())` | |

约束与索引：`@@unique([organizationId, payoutRef])`（幂等）、`@@index([organizationId, receivedAt])`、`@@index([organizationId, settlementId])`。

### 1.3 金额语义（回应 C3）

| 概念 | 来源 | 是否落库 |
|---|---|---|
| `confirmedAmount`（应到账） | **既有 `Settlement.recoveredAmount`** | 已落库（不新增字段） |
| `receivedAmount`（实际到账） | **Σ `RecoveryPayout.amount`**（同租户同 settlement） | **不落库**，读取时计算投影 |
| 差异 | `receivedAmount - confirmedAmount` | 不落库；仅用于投影与既有对账差异层（D4） |

不落库的理由：落库会形成第二份事实来源，与 `RecoveryPayout` 冲突；投影可随时重算且不会漂移。

### 1.4 索引（回应 R5 查询场景）

| 索引 | 查询场景 |
|---|---|
| `Settlement @@index([organizationId, confirmationStatus])` | 「待人工确认」清单（Phase B Dashboard） |
| `Settlement @@index([organizationId, reconciliationStatus])` | 「待对账 / 部分到账 / 争议」清单（财务视图） |
| `RecoveryPayout @@index([organizationId, receivedAt])` | 按期间扫描到账，用于与 payment-reconciliation 差异层比对（D4） |

---

## 2. 不变量（服务层保证，不新增触发器）

| # | 不变量 |
|---|---|
| I1 | `RecoveryPayout.organizationId` 与 `Settlement.organizationId` 一致 |
| I2 | `reconciliationStatus = RECONCILED ⇒ receivedAmount == confirmedAmount` |
| I3 | `reconciliationStatus = PARTIAL ⇒ 0 < receivedAmount < confirmedAmount` |
| I4 | `receivedAmount > confirmedAmount ⇒ reconciliationStatus = DISPUTED`（不自动改账，D3） |
| I5 | `confirmationStatus = PENDING_CONFIRMATION` 时不得进入回收确认（`recovery-outcome` 前置校验） |
| I6 | `(organizationId, payoutRef)` 唯一（幂等） |
| I7 | 冲回链（`reversedBySettlementId`）非空时，原 Settlement 金额不可改；`reconciliationStatus` 可转为 `REVERSED` |

---

## 3. 迁移计划（**获批后才执行**）

1. `CREATE TYPE` × 2 + `ALTER TABLE "Settlement" ADD COLUMN` × 4（R1a/R1b 带默认值、R2a/R2b 可空、R4 可空）+ `CREATE TABLE "RecoveryPayout"` + 5 个索引。
2. 默认值语义：既有行 → `confirmationStatus=CONFIRMED`（历史都经过人工确认）、`reconciliationStatus=NOT_STARTED`（当时无到账数据）→ **无需回填**。
3. **不新增/不修改触发器**；迁移后仍应为 27 个 `cc_tenant%` 触发器。
4. 顺序：`prisma validate` → `migrate deploy`（CI 全新库）→ `generate` → 触发器数量校验 → `tsc` → 全量测试。

回滚：先回滚代码 → `DROP TABLE "RecoveryPayout"`（**回滚前必须先导出到账记录**）→ `DROP COLUMN` ×4 → `DROP TYPE` ×2。

---

## 4. 影响面

| 面 | 影响 |
|---|---|
| 金额口径 | 零改动（`FeeCalculation` / `RecoveryLedgerEntry` / `BillingInvoice` 不动；`recoveredAmount` 语义不变） |
| 支付自动化 | 零改动（D5 HOLD；本 Delta 无任何资金动作） |
| 对账 | 复用既有 `payment-reconciliation` 差异层（D4），本层只做投影 |
| API / 权限 | 本 Delta 不改端点、不改权限矩阵 |
| 规则引擎 | 零改动 |

---

## 5. 实现阶段验收（6 项）

1. `prisma validate` + 全新库 `migrate deploy` + 触发器数仍 27；
2. 既有测试全绿；历史 Settlement 得到 `CONFIRMED + NOT_STARTED`；
3. 拆分语义单测：`CONFIRMED + NOT_STARTED`（正常）、`CONFIRMED + PARTIAL`、`CONFIRMED + RECONCILED`、`DISPUTED` 四类投影；
4. 幂等：重复 `payoutRef` 不重复累加；跨租户 payout 被拒；
5. 冲回：链可追溯、原金额不可改（I7）；
6. 多期到账下与 `payment-reconciliation` 差异清单一致（D4）。

---

## 6. 请裁决

NEED: **GO / REVISE / HOLD**（RECOVERY-CONFIRMATION-SCHEMA-DELTA-REQUEST · R2）

- 若 GO：执行迁移（R1a/R1b/R2/R4 + RecoveryPayout + 索引）并进入实现；
- 若 REVISE：请指明仍不满足的语义点。

**提醒**：D5（自动扣佣）仍 HOLD；本 Delta 不含任何资金动作。
