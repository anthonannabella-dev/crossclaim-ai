# RECOVERY CONFIRMATION — SCHEMA DELTA REQUEST

> 类型：**Schema Delta Request（仅请求批准；不含 migration、不含实现）**
> 依据：架构方 **MSG-20260929-22**（RECOVERY-CONFIRMATION-DESIGN = GO，`NEXT = Submit RECOVERY-CONFIRMATION-SCHEMA-DELTA-REQUEST`）
> 决策依据：**D1 GO**（RecoveryPayout 表）· **D2 GO**（PARTIALLY_RECONCILED）· **D3 GO**（冲回由 FINANCE 处置，不自动改账单）· **D4 GO**（复用 payment reconciliation 差异层）· **D5 HOLD**（自动扣佣）
> 分支 `gate/7-commercial-validation` · Codex · 2026-09-29

---

## 1. 请求内容

### 1.1 `Settlement` 扩展（不改现有字段语义）

| # | 变更 | 类型 / 默认 | 可空 | 目的 |
|---|---|---|---|---|
| R1 | `confirmationStatus` | 枚举 `SettlementConfirmationStatus`，默认 `CONFIRMED` | 否 | 表达业务确认与到账核对进度 |
| R2a | `confirmedByUserId` | `String?` | 是 | 人工确认留痕 |
| R2b | `confirmedAt` | `DateTime?` | 是 | 确认时间 |
| R4 | `reversedBySettlementId` | `String?`（指向同一表的另一行） | 是 | 冲回链（**不删除原记录**） |

新枚举（**唯一新增枚举**）：

```
SettlementConfirmationStatus = CONFIRMED | PARTIALLY_RECONCILED | RECONCILED | DISPUTED | REVERSED
```

> 默认 `CONFIRMED`：兼容既有行——历史上所有已确认回收都视为「已业务确认、未核对到账」。

### 1.2 新表 `RecoveryPayout`（D1 已 GO）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `String @id` | uuid |
| `organizationId` | `String` | 租户（与 Settlement 同租户） |
| `settlementId` | `String` | 指向 Settlement |
| `payoutRef` | `String` | 平台/银行到账引用（幂等键） |
| `amount` | `Decimal(18,4)` | 到账金额 |
| `currency` | `String` | 币种 |
| `receivedAt` | `DateTime` | 到账时间 |
| `sourceType` | `String` | `PLATFORM_SETTLEMENT` / `BANK_TRANSFER` / `OTHER`（枚举化，禁自由文本含义） |
| `createdBy` | `String?` | 录入人 |
| `createdAt` | `DateTime @default(now())` | |

约束与索引：

- `@@unique([organizationId, payoutRef])` —— **幂等**（D4 复用对账差异层的前提）
- `@@index([organizationId, receivedAt])` —— 对账按时间扫描
- `@@index([organizationId, settlementId])` —— 单笔回收的多期到账

### 1.3 索引

| # | 变更 | 用途 |
|---|---|---|
| R5 | `Settlement @@index([organizationId, confirmationStatus])` | 看板与对账查询（D4） |

---

## 2. 不变量

| # | 不变量 | 落点 |
|---|---|---|
| I1 | `RecoveryPayout.organizationId` 必须与 `Settlement.organizationId` 一致 | 服务层 + 沿用租户触发器风格（**本 Delta 不新增触发器**） |
| I2 | `confirmationStatus = RECONCILED ⇒ receivedAmount == confirmedAmount` | 服务层投影计算 |
| I3 | `confirmationStatus = PARTIALLY_RECONCILED ⇒ 0 < receivedAmount < confirmedAmount` | 服务层 |
| I4 | `receivedAmount > confirmedAmount ⇒ DISPUTED`（不自动改账，D3） | 服务层 |
| I5 | `reversedBySettlementId != null` 时原 Settlement 不可再被修改金额 | 服务层 |
| I6 | 到账录入幂等：`(organizationId, payoutRef)` 唯一 | 数据库唯一约束 |

---

## 3. 迁移计划（**获批后才执行**）

1. `ALTER TABLE "Settlement" ADD COLUMN` × 4（R1/R2a/R2b/R4）+ `CREATE TYPE` × 1（枚举）+ `CREATE TABLE "RecoveryPayout"` + 3 个索引。
2. `confirmationStatus` 带默认值 `CONFIRMED` → 既有行**无需回填**（默认值语义即历史事实）。
3. **不新增/不修改任何触发器**；迁移后仍应为 **27 个 `cc_tenant%` 触发器**（CI 校验）。
4. 顺序：`prisma validate` → `migrate deploy`（CI 全新库）→ `generate` → 触发器数量校验 → `tsc` → 全量测试。

回滚：
- 先回滚代码（不再读写新列/新表）→ `DROP TABLE "RecoveryPayout"` → `DROP COLUMN` × 4 → `DROP TYPE`；
- 新表仅存到账记录（应用层新数据），回滚会丢弃这些记录——因此**回滚前必须先导出**（写入迁移说明）。

---

## 4. 兼容性与影响面

| 面 | 影响 |
|---|---|
| 既有回收确认路径 | 零影响（默认 `CONFIRMED`，既有查询不变） |
| 金额口径 | **零改动**（FeeCalculation / RecoveryLedgerEntry / BillingInvoice 不动） |
| 自动扣佣 | **零改动**（D5 HOLD；本 Delta 不含任何支付动作） |
| 对账 | 复用既有 `payment-reconciliation` 差异层（D4），不新增第二套差异逻辑 |
| API | 本 Delta 不改端点；实现阶段才新增「到账录入 / 确认状态」端点 |
| 权限 | 不改矩阵；到账录入与冲回判定限 OWNER/ADMIN/FINANCE（实现阶段校验） |

---

## 5. 验收（实现阶段将提交的证据）

1. `prisma validate` + 全新库 `migrate deploy`；触发器数仍 27。
2. 既有测试全绿（回归）；`Settlement` 既有行默认 `CONFIRMED`。
3. 单测：I2–I4 投影计算（部分/全额/超额）。
4. 真实库集成：`(organizationId, payoutRef)` 幂等（重复录入不重复累加）；跨租户 payout 写入被拒。
5. 冲回：`reversedBySettlementId` 链可追溯；原记录金额不可改（I5）。
6. 对账差异清单在多期到账下与 `payment-reconciliation` 输出一致（D4）。

---

## 6. 请裁决

NEED: **GO / REVISE / HOLD**（RECOVERY-CONFIRMATION-SCHEMA-DELTA-REQUEST）

- 若 GO：我执行迁移（R1–R5），随后实现到账录入、确认状态投影与只读对账视图，并提交 Implementation Checkpoint（含上述 6 项证据）。
- 若 REVISE：请指明需要增删的字段、枚举值或幂等键范围。
- 若 HOLD：保持现状，不做任何 Schema 变更。

**提醒**：D5（自动扣佣）仍为 HOLD；本 Delta 不含任何资金动作。
