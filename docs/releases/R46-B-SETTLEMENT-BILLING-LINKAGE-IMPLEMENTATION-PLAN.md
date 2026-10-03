# R46-B — Settlement / Billing Linkage · Implementation Plan

> 依据：**MSG-20261002-53 = PASS WITH REVISE — R46-A APPROVED FOR IMPLEMENTATION PLANNING**（CHANGE A1 / B1 / C1 / E1 + CHANGE F 四项数据库级不变量 + §5.4 legacy 冲回链裁定 + §6.6 Fee 作废语义裁定 + 15 项新增永久验收 + 推荐 S1…S6 顺序）。
> 状态：**docs-only 计划** —— 本文件**不实施** Schema、**不写** migration、**不改**代码；仅把裁决固化为最终模型与实施 / 事务 / 测试计划。
> 边界：**NO R45→Settlement automatic creation · NO automatic Fee · NO automatic Invoice issuance · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials**；R13 **Payment Activation Gate = HOLD**。
> 继承：R46-A Schema Delta Request（docs-only）+ MSG-20261002-52 的 15 项永久验收；R12 / R13 / R14 红线不变。

---

## 1. 最终模型

### 1.1 表与变更总览（一次完整，不拆多个 Schema Delta Request）

| 表 | 变更 | 性质 |
| --- | --- | --- |
| `Settlement` | **纯增列**（全 nullable） | 既有表 |
| `SettlementReceiptSnapshot` | **新表** | append-only |
| `SettlementAdjustment` | **新表** | append-only |
| `FeeCalculation` | **纯增列**（全 nullable） | 既有表 |
| `FeeCalculationSettlement` | **新表** | append-only membership |
| `FeeCalculationAdjustment` | **新表** | append-only |
| `BillingInvoice` / `BillingStatus` | **不变** | — |
| `RecoveryLedgerEntry` | **不变** | — |

### 1.2 `Settlement` 增列（CHANGE A + E）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `externalIdentityKind` | enum `SettlementExternalIdentityKind` | `BANK_TRANSACTION` \| `PSP_SETTLEMENT` \| `PLATFORM_SETTLEMENT_REPORT` \| `CARRIER_SETTLEMENT` \| `INSURER_PAYOUT` \| `CHECK_REFERENCE` \| `MANUAL_DOCUMENT` \| `OTHER` |
| `externalIdentityValue` | `String?` | **仅 provenance / display**（CHANGE A1：**不参与任何唯一判定**）；仅当业务确需时保存；日志 / API 不得输出完整敏感值 |
| `externalIdentityValueHash` | `String?` | `sha256(canonicalValue)` 64hex 小写；**唯一判定的规范依据之一** |
| `externalIdentityVersion` | `String?` | canonical 规则版本（`'v1'`）；**纳入唯一键** |
| `financialEventFingerprint` | `String?` | 无稳定外部 ID 时：`sha256('sfp-v1' \| identityKind \| caseRefCanonical \| occurredAt(UTC ms) \| amount(4dp) \| currency)` |
| `financialEventFingerprintVersion` | `String?` | `'sfp-v1'`；**纳入唯一键** |
| `claimItemId` | `String?` | linkage basis（同租户） |
| `linkageBasisKind` | enum `SettlementLinkageBasisKind` | `CLAIM_ITEM_DIRECT` \| `CASE_LEVEL_ALLOCATION` \| `MANUAL_BASIS` |
| `linkageBasisRef` | `String?` | `MANUAL_BASIS` 必填 |
| `receiptSnapshotId` | `String?` | 指向 `SettlementReceiptSnapshot` |

### 1.3 `SettlementReceiptSnapshot`（新表，append-only；CHANGE E / E1 / F4）

| 字段 | 说明 |
| --- | --- |
| `id` / `organizationId` | 租户边界 |
| `claimItemId?` / `caseId?` | claim / case linkage |
| `externalIdentityKind` / `externalIdentityValueHash` / `externalIdentityVersion` | external financial identity |
| `financialEventFingerprint` / `financialEventFingerprintVersion?` | 无稳定 ID 路径 |
| `amount` / `currency` / `receivedAt` | 资金事实 |
| `sourceKind` | enum `SettlementReceiptSourceKind`：`OFFICIAL_API` \| `PLATFORM_REPORT` \| `BANK_STATEMENT` \| `PSP_SETTLEMENT_REPORT` \| `MANUAL_DOCUMENT` |
| `evidenceReferences` | `Json`：`[{ evidenceArtifactId, digest, kind }]`；**≥ 1** |
| `snapshotVersion` | `'v1'`（canonicalization contract 版本） |
| `snapshotDigest` | 64hex；由**服务端**按 §3.5 合同计算 |
| `createdByUserId` / `createdAt` | actor |

**不可变性（E1）**：`BEFORE UPDATE OR DELETE → 拒绝`。证据补充或资金事实变化时，**不得 UPDATE 原 snapshot**，必须生成新 snapshot / 新 `snapshotVersion` / 新 digest 并重新审批。

### 1.4 `SettlementAdjustment`（新表，append-only；CHANGE B / B1 / F1 / F2）

| 字段 | 说明 |
| --- | --- |
| `id` / `organizationId` | 租户边界 |
| `originalSettlementId` | 复合外键 `(organizationId, originalSettlementId)` → `Settlement(organizationId, id)`，`ON DELETE RESTRICT` |
| `adjustmentKind` | enum `SettlementAdjustmentKind`：`REVERSAL` \| `CORRECTION`（v1 仅 `REVERSAL` 启用，见 §2.2） |
| `amount` | `Decimal(18,4)`；v1 `REVERSAL` 恒 > 0 |
| `currency` | 必须 == 原 Settlement `currency`（§3.2） |
| `occurredAt` | 外部事件时间 |
| `externalIdentityKind` / `externalIdentityValueHash` / `externalIdentityVersion` / `externalIdentityValue?` | 同 §1.2 规则（自身 external identity / provenance） |
| `financialEventFingerprint` / `Version?` | 无稳定 ID 路径 |
| `evidenceReferences` | `Json`；**≥ 1**（逐条存在 / 同租户 / 不重复 / 合法 kind·status） |
| `reasonCode` / `reasonText?` | 结构化理由 |
| `approvalId` | humanApproval 绑定；`UNIQUE(organizationId, approvalId)` |
| `createdByUserId` / `createdAt` | actor |

### 1.5 `FeeCalculation` 增列 + `FeeCalculationSettlement`（新表；CHANGE C / C1 / F3）

`FeeCalculation` 增列（全 nullable，**历史计算事实保持不可变**）：

| 列 | 说明 |
| --- | --- |
| `membershipDigest` | `sha256(canonical(membership 集合 + 金额 + 币种 + basis version))` |
| `feeBasisVersion` | 本笔计费使用的费率 / basis 版本 |
| `policyRef` | 费率来源引用（R12「依据存在且唯一」） |
| `supersededByFeeCalculationId` | 仅作 CAS / 版本协调与只读指针；**禁止**用于金额推导 |

`FeeCalculationSettlement`（membership）：

| 字段 | 说明 |
| --- | --- |
| `id` / `organizationId` / `feeCalculationId` | 复合外键到 `FeeCalculation(organizationId, id)` |
| `settlementId?` | 复合外键到 `Settlement(organizationId, id)`，`ON DELETE RESTRICT` |
| `adjustmentId?` | 复合外键到 `SettlementAdjustment(organizationId, id)`，`ON DELETE RESTRICT` |
| `basisRole` | enum `FeeMembershipBasisRole`：`POSITIVE` \| `NEGATIVE` |
| `amountContribution` | `POSITIVE` > 0；`NEGATIVE` < 0 |
| `currency` | 与 Settlement / Fee 一致 |
| `createdAt` | — |

### 1.6 `FeeCalculationAdjustment`（新表，append-only；§6.6 裁定 + CHANGE C1）

| 字段 | 说明 |
| --- | --- |
| `id` / `organizationId` / `targetFeeCalculationId` | 复合外键到 `FeeCalculation(organizationId, id)` |
| `adjustmentKind` | enum `FeeCalculationAdjustmentKind`：`VOID`（原计算不应成立） \| `REVERSAL`（因资金事实冲回） \| `CORRECTION`（输入 / 费率被纠正） |
| `triggerSettlementAdjustmentIds` | `Json`：触发本次 Fee 调整的 `SettlementAdjustment` id 列表（≥ 1，除 `VOID` 可空） |
| `amountDelta` | `Decimal(18,4)`（带符号）；`VOID` 时等于 `-原 feeAmount` |
| `currency` / `reasonCode` / `reasonText?` | — |
| `approvalId` | `UNIQUE(organizationId, approvalId)` |
| `createdByUserId` / `createdAt` | actor |

**CHANGE C1**：`SettlementAdjustment` 到来后**不允许 UPDATE 旧 `FeeCalculation`**。必须新增 `FeeCalculationAdjustment`（或新的 superseding calculation 事实）。

`netEarnedFee(feeCalculation)` = `FeeCalculation.feeAmount` − `Σ(active FeeCalculationAdjustment.amountDelta)`；`active` 判定与链式重建规则在 S4 冻结并由 checker 校验。

### 1.7 legacy 字段（§5.4 裁定）

| 字段 | 处置 |
| --- | --- |
| `Settlement.reversedBySettlementId` | **保留、可读、不回填**；**不再作为新业务写入路径**；**不批准双写**（避免两个资金真值源） |
| R12 红线中的「未被冲回」判定 | 升级为净额口径（`Settlement` 到账 − 有效 `SettlementAdjustment`），legacy 链仅作为兼容读 |

---

## 2. CHANGE 落实细节

### 2.1 CHANGE A1 — 身份唯一性以 kind + valueHash + version 为规范依据

```text
valueHash  = sha256(canonicalExternalIdentityValue)          -- 不含 version
UNIQUE (organizationId, externalIdentityKind, externalIdentityValueHash, externalIdentityVersion)
  WHERE externalIdentityValueHash IS NOT NULL
UNIQUE (organizationId, financialEventFingerprint, financialEventFingerprintVersion)
  WHERE financialEventFingerprint IS NOT NULL
CHECK  (externalIdentityValueHash IS NOT NULL OR financialEventFingerprint IS NOT NULL)
```

- `externalIdentityValue` **不进入任何唯一键**（A1）；
- 版本升级（`v1 → v2`）产生**新的身份键**，旧行保持可读，不静默重解释；
- 日志 / API / 审计输出**不得**回显完整敏感引用值（只允许 hash 前缀或受控脱敏视图）。

### 2.2 CHANGE B1 — `SettlementAdjustment` 字段与 v1 约束

v1 **只开放 full reversal**：

```text
CHECK (adjustmentKind = 'REVERSAL')                       -- CORRECTION 在 v1 fail-closed（ADJUSTMENT_KIND_NOT_ENABLED）
CHECK (amount > 0)
CHECK (currency ~ '^[A-Z]{3}$')
CHECK (externalIdentityValueHash IS NOT NULL OR financialEventFingerprint IS NOT NULL)
```

跨行约束（服务层 + DB 触发器双保险）：

1. `amount == 原 Settlement.amount`（**full reversal 等额**；不等 → `REVERSAL_AMOUNT_MISMATCH` 拒绝）；
2. `currency == 原 Settlement.currency`（不等 → `CURRENCY_MISMATCH` 拒绝，v1 禁 FX）；
3. `organizationId == 原 Settlement.organizationId`（同一租户）；
4. 同一 `originalSettlementId` 的**有效** `REVERSAL` 总额 ≤ 原金额（`OVER_REVERSAL`）；
5. 同一 external identity / fingerprint replay → 幂等复用（不新建、不报错）；
6. 重复 full reversal（不同事件、同一 OBSERVED 目标）→ fail-closed。

> 触发器以 `BEFORE INSERT` 校验（append-only 表无 UPDATE 路径）；服务层必须在**同一事务**内先 `SELECT … FOR UPDATE` 原 Settlement 再插入。

### 2.3 CHANGE C / C1 — Fee 血缘与 Fee 调整

- `FeeCalculation.baseAmount` 必须等于 membership 的 `Σ amountContribution`（服务端计算 + checker 校验）；
- `FeeCalculationSettlement` 使 `FeeCalculation` 可重建「哪些 Settlement − 哪些有效 Adjustment → net billable basis + 使用的 fee rate/basis version」；
- `SettlementAdjustment` 到来后：**不改历史 FeeCalculation**，而是新增 `FeeCalculationAdjustment`；`netEarnedFee` 由链式事实重算；
- `BillingInvoice` 资格判定仍走既有 `billing.draft` 口径；**fee calculated ≠ invoice issued ≠ payment due/collected**。

### 2.4 CHANGE E1 — snapshot 不可变与审批漂移防护

- snapshot append-only；
- `settlement.record` 的 approval `boundExtra` 必须含 `receiptSnapshotDigest`（服务端构造）；
- 执行时锁后重验 digest；**审批后**金额 / 币种 / receipt identity / evidence / receivedAt 任一变化 → 原 approval **失效**（`APPROVAL_BINDING_MISMATCH`）；
- 需要变更 → 生成新 snapshot（新 `snapshotVersion` / 新 digest）→ **重新审批**。

### 2.5 CHANGE F — 四个数据库级不变量

| 编号 | 不变量 | 实现 |
| --- | --- | --- |
| F1 | 同租户归属：`Settlement ↔ ClaimItem ↔ Case ↔ ReceiptSnapshot ↔ Evidence` **全部同 tenant** | 全部跨表引用使用**复合外键** `(organizationId, xxxId)` → `父表(organizationId, id)`（父表均已具备 `@@unique([organizationId, id])`）+ 既有租户保护触发器清单；**不依赖 service validation** |
| F2 | `Adjustment.currency == 原 Settlement.currency`；v1 禁 FX | §2.2 触发器 + CHECK |
| F3 | Fee membership uniqueness：同一 Settlement / 有效资金份额不得因重跑进入同一计算链两次 | `UNIQUE(organizationId, settlementId) WHERE settlementId IS NOT NULL`；`UNIQUE(organizationId, adjustmentId) WHERE adjustmentId IS NOT NULL`（append-only 表，无 UPDATE 逃逸）+ checker |
| F4 | Receipt snapshot digest：versioned canonicalization contract + 64hex DB CHECK；禁止客户端提供可信 digest | `CHECK (snapshotDigest ~ '^[0-9a-f]{64}$')`；canonicalization v1（稳定字段序 + UTF-8 + 金额 4dp 定点 + 时间 ISO-8601 UTC）在代码中冻结并有 digest 向量测试；服务端计算，客户端传入值一律忽略 / 拒绝 |

---

## 3. 约束 / 索引 / 触发器清单（S1 落地）

| 表 | unique / index | CHECK | 触发器 |
| --- | --- | --- | --- |
| `Settlement`（增列） | `UNIQUE(org, kind, valueHash, version) WHERE hash IS NOT NULL`；`UNIQUE(org, fingerprint, version) WHERE fp IS NOT NULL`；`INDEX(org, claimItemId, receivedAt)`；`INDEX(org, receiptSnapshotId)` | 身份二选一；hash / fp 64hex；`amount > 0`；`currency ~ '^[A-Z]{3}$'`；`linkageBasisKind IS NOT NULL`（新建行） | 租户保护（既有机制）；身份列受控变更（append-only 语义） |
| `SettlementReceiptSnapshot` | `UNIQUE(org, id)`；`INDEX(org, createdAt)` | `snapshotDigest ~ '^[0-9a-f]{64}$'`；evidence ≥ 1；`amount > 0` | `cc_append_only__SettlementReceiptSnapshot`（tgtype 27）+ 租户保护 |
| `SettlementAdjustment` | `UNIQUE(org, id)`；`UNIQUE(org, kind, valueHash, version)`；`UNIQUE(org, fingerprint, version)`；`UNIQUE(org, approvalId)`；`INDEX(org, originalSettlementId)` | §2.2 全部 | `cc_append_only__SettlementAdjustment` + `cc_settlementadjustment_invariants`（跨行校验）+ 租户保护 |
| `FeeCalculationSettlement` | `UNIQUE(feeCalculationId, settlementId, adjustmentId)`；`UNIQUE(org, settlementId) WHERE settlementId IS NOT NULL`；`UNIQUE(org, adjustmentId) WHERE adjustmentId IS NOT NULL`；`INDEX(org, feeCalculationId)` | 符号一致性；`settlementId`/`adjustmentId` 二选一 | `cc_append_only__FeeCalculationSettlement` + 租户保护 |
| `FeeCalculationAdjustment` | `UNIQUE(org, id)`；`UNIQUE(org, approvalId)`；`INDEX(org, targetFeeCalculationId)` | `amountDelta <> 0`；`kind = 'VOID' ⇒ amountDelta = -target.feeAmount`（触发器） | `cc_append_only__FeeCalculationAdjustment` + 租户保护 |
| `BillingInvoice` / `RecoveryLedgerEntry` | **不变** | **不变** | **不变** |

所有新增 tenant-owned 表必须同步登记 `tools/tenant-triggers/required-triggers.json` 与 `tools/tenant-triggers/append-only-triggers.json`，否则 CI 失败。

---

## 4. 受保护动作与权限（沿用 Action Guard / HITL）

| 动作 | 类型 | 闸门 |
| --- | --- | --- |
| `settlement.record` | `INTERNAL_WRITE` | humanApproval（`receiptSnapshotDigest` 绑定）+ 锁后 ACTIVE membership/role 重验 + evidence 校验 |
| `settlement.adjust` | `INTERNAL_WRITE` | 同上 + 原 Settlement 引用 / 等额 / 同币种 / 同租户校验 |
| `billing.fee_calculate` | `INTERNAL_WRITE` | humanApproval + net billable basis + membership 唯一 + basis 依据唯一 |
| `billing.fee_adjust` | `INTERNAL_WRITE` | humanApproval + `FeeCalculationAdjustment`（VOID / REVERSAL / CORRECTION） |
| `billing.invoice_issue` | `INTERNAL_WRITE` | humanApproval + 有效 FeeCalculation（沿用 `billing.draft` 锁后重读 / 依据唯一 / `BILLING_BASIS_REQUIRED`） |
| `payment.capture` | `MONEY_MOVEMENT` | **productionGate（HOLD）** |

审批创建时的 `boundExtra` 由**服务端**构造，客户端不得自证；每个 approval `UNIQUE(organizationId, approvalId)` 恰好消费一次；失败时**业务事实 / 成功审计 / approval 消费全部零推进**。

---

## 5. 事务与并发要点

统一模式（沿用 R45 S4 模版）：

```text
advisory lock（如需要）
  → SELECT … FOR UPDATE（claim / settlement 作用域）
  → 依据 / 快照 / approval 绑定校验（锁后重验）
  → 幂等键查回（命中 → REUSED，不新建）
  → 业务写入（append-only）
  → 业务审计（AuditLog）
  → approval 消费（恰好一次）
  → commit      任何一步失败 → 整体 rollback，零副作用
```

- 全部金额运算使用 **4 位定点**（BigInt / Decimal），禁止浮点；
- 金额 / 币种 / 时间 canonical 化在服务端唯一实现；
- `settlement.record` 与 `settlement.adjust` 必须能证明「失败时 Settlement / Adjustment / Audit / approval 消费**全部零推进**」。

---

## 6. 迁移拆分与实施顺序（推荐 S1…S6）

| Stage | 交付 | 证据要求 | 送审 |
| --- | --- | --- | --- |
| **S1** | Schema + migrations + triggers + inventories（4 新表 + 2 表增列 + 全部 CHECK / unique / 触发器 + 两份清单） | `prisma validate` · fresh migrate · tenant / append-only / controlled-mutation 清单一致 · two-stage upgrade 保数据 | Implementation Checkpoint |
| **S2** | `SettlementReceiptSnapshot` + Settlement ingest / record（身份解析 + 幂等 + approval 绑定 + evidence 校验） | 身份幂等 / 冲突 / 零证据零写入 / approval 漂移 fail-closed | Implementation Checkpoint |
| **S3** | `SettlementAdjustment` / reversal（等额 + 同币种 + 同租户 + 幂等 + full reversal 唯一） | 15 + 4 项 reversal 相关永久验收 | Implementation Checkpoint |
| **S4** | Fee membership + fee calculation / adjustment（`netEarnedFee` 重建） | membership 唯一 / 不 UPDATE 历史 Fee / 净额正确下降 | Implementation Checkpoint |
| **S5** | Invoice linkage boundary（资格与关联，不改状态机） | fee ≠ invoice ≠ payment 的边界测试 | Implementation Checkpoint |
| **S6** | consistency checker + full regression closure | 只读 checker（DETECT ≠ REPAIR）+ 全量回归 + two-stage upgrade | Release Checkpoint |

**约束**：每个 Stage 完成后提交**独立 Implementation Checkpoint**并等待裁决；不得跨 Stage 顺带实现；不得删除、skip 或弱化任何既有永久基线（R45 / R44 / R43 / PG / H / D / M）。

---

## 7. 测试计划（永久验收）

### 7.1 MSG-20261002-52 的 15 项（R46 资金模型）

| # | 验收 | Stage |
| --- | --- | --- |
| 1 | 同一到账事件重复录入 → Settlement 仍 1 | S2 |
| 2 | 不同到账事件 → 可形成多笔 Settlement | S2 |
| 3 | Settlement 无可信 evidence → 零写入 | S2 |
| 4 | approval 后 amount/currency/reference/evidence 变化 → fail-closed | S2 |
| 5 | partial Settlement 只按已到账部分进入 fee basis | S4 |
| 6 | reversal 不修改原 Settlement | S3 |
| 7 | duplicate reversal → 拒绝 / 幂等复用 | S3 |
| 8 | reversal 后净 fee basis 正确下降 | S4 |
| 9 | 同一 Settlement 不得进入两个重复 FeeCalculation | S4 |
| 10 | FeeCalculation 可追溯到具体 Settlement membership | S4 |
| 11 | reconciliation override 不产生 Settlement/Fee | S6 |
| 12 | R45 projection 重跑不产生资金副作用 | S6 |
| 13 | currency mismatch 不自动换汇 | S3 / S4 |
| 14 | Invoice creation 不等于 Payment collected | S5 |
| 15 | Payment / R13 全程继续 HOLD | S5 / 全程 |

### 7.2 MSG-20261002-53 新增的 15 项

| # | 验收 | Stage |
| --- | --- | --- |
| 1 | legacy reversal 可读，但新写不触碰 `reversedBySettlementId` | S1 / S3 |
| 2 | legacy / new representation 冲突 → checker 非零 | S6 |
| 3 | exact receipt replay → 1 Settlement | S2 |
| 4 | same identity / different amount → conflict | S2 |
| 5 | snapshot 修改被 DB 拒绝 | S2 |
| 6 | 新 snapshot → 新 digest → 旧 approval 不可用 | S2 |
| 7 | cross-tenant Claim/Settlement/Snapshot/Evidence → DB/service 双层拒绝 | S1 / S2 |
| 8 | full reversal amount ≠ original amount → 拒绝 | S3 |
| 9 | reversal currency mismatch → 拒绝 | S3 |
| 10 | reversal 后原 Settlement 仍完整存在 | S3 |
| 11 | adjustment 后旧 FeeCalculation 不被 UPDATE | S4 |
| 12 | 同 Settlement 重复进入同 Fee chain → 拒绝 | S4 |
| 13 | Fee membership 可重建 net billable basis | S4 |
| 14 | reconciliation / override 重跑仍产生 0 个 Settlement/Fee/Invoice | S6 |
| 15 | Invoice issuance 继续产生 0 Payment | S5 |

### 7.3 基线保护

R45 永久基线（S1–S5 / fresh migration / two-stage upgrade / 三份清单 / 176 files 1730 tests）与 R44 / R43 / PG / H / D / M 基线**全部保留**；R46 不得通过删除、skip 或弱化测试获得通过。

---

## 8. legacy 兼容与收口

1. `Settlement.reversedBySettlementId` **只读兼容**：新业务写入路径不再使用；
2. 兼容读取层同时识别 legacy 链与 `SettlementAdjustment`；
3. checker 增加「双表示矛盾」检测（DETECT ≠ REPAIR）：同一目标 Settlement 同时存在 legacy 链与新 adjustment 且金额不一致 → 非零；
4. 是否彻底移除 legacy 列，留到 R46 收口后的独立提案；本计划**不做迁移删除**。

---

## 9. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| legacy reversal 与新 adjustment 形成双真值源 | 不双写 + 兼容读 + checker 矛盾检测（§8） |
| adjustment 到来后修改历史 FeeCalculation | append-only + `FeeCalculationAdjustment` + 触发器拒绝 UPDATE |
| receipt snapshot 被 UPDATE 导致审批对象漂移 | append-only + 新 snapshot/version + approval 失效规则 |
| 同一 Settlement 被重复纳入 success fee basis | membership 唯一约束（F3）+ checker |

---

## 10. 请裁决（编号）

1. §1 最终模型（4 新表 + 2 表增列 + `FeeCalculationAdjustment` 命名与三分类 VOID/REVERSAL/CORRECTION）是否批准？
2. §2.1 CHANGE A1（唯一键含 `externalIdentityVersion`；`externalIdentityValue` 退出唯一判定）与 §2.2 CHANGE B1（v1 仅 full reversal、等额由触发器 + 服务层双保险、CORRECTION fail-closed）是否符合裁决？
3. §2.3 CHANGE C1（不 UPDATE 历史 FeeCalculation，改用 `FeeCalculationAdjustment` + `netEarnedFee` 重算）与 §2.5 CHANGE F 四项数据库级不变量是否完整？
4. §6 的 **S1…S6** 拆分与「每个 Stage 独立 Checkpoint 送审」是否批准？S1 是否可以先行（Schema + migrations + triggers + inventories，零资金行为）？

> 边界（重申）：本计划为 docs-only；实施前保持 **NO R45→Settlement automatic creation · NO automatic Fee · NO automatic Invoice issuance · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials**；R13 Payment Activation Gate = HOLD。

---

## 11. S1 最终 Schema 实施口径（MSG-20261002-54 收口）

> 本段为 **MSG-20261002-54 = PASS WITH REVISE** 要求的 S1 前置收口：先把该裁决的 CHANGE A（F3 fee-chain uniqueness）/ CHANGE B（Settlement↔Snapshot 不可漂移）/ CHANGE C（Invoice 不得从 Fee 自动产生）写进最终 S1 Schema 实施口径，再实施 S1。**本段仍属 docs-only。**

### 11.1 CHANGE A —— fee chain identity 与唯一性（替换 §2.5 的 F3）

**问题（MSG-54 F3 修正）**：原 `UNIQUE(org, settlementId)` / `UNIQUE(org, adjustmentId)` 会把一笔资金事实在整个组织生命周期中锁死给唯一一个 FeeCalculation，从而堵死合法的 superseding / recalculation / correction chain / invoice regeneration。

**S1 口径（最终）**：

| 概念 | 定义 |
| --- | --- |
| `feeChainId` | **稳定服务端 identity**，等于链上首个（root）FeeCalculation 的 id；supersede 时**沿用**同一 `feeChainId` |
| `feeChainRootFeeCalculationId` | 指向链根（root）的 FeeCalculation；root 自身该列为 NULL |
| `feePolicyRef` + `feeBasisVersion` | 该链使用的费率依据与版本（R12「依据存在且唯一」） |
| `supersededByFeeCalculationId` | 链内前向指针；**只作版本协调，禁止用于金额推导** |

唯一性（全部为 append-only 表上的约束 + 只读 checker）：

```text
-- 1) 同一链内不得重复纳入同一资金事实
UNIQUE (organizationId, feeChainId, settlementId)   WHERE settlementId IS NOT NULL
UNIQUE (organizationId, feeChainId, adjustmentId)   WHERE adjustmentId IS NOT NULL

-- 2) 同一 claimItem 在同一时刻最多一条 active 链（active = 未被 supersede）
UNIQUE (organizationId, claimItemId) WHERE supersededByFeeCalculationId IS NULL

-- 3) membership 行级唯一（同一次计算内）
UNIQUE (feeCalculationId, settlementId, adjustmentId)
```

**不变量（替换旧 F3）**：*同一个资金事实不得同时进入两个互不相关的 active fee chain。*

- 「同一链」= 相同 `feeChainId`（含 superseding / recalculation）；
- 「互不相关」= 不同 `feeChainId` 且同时 active。由约束 (2) 在 claimItem 维度直接排除，并由 checker 做跨表交叉验证（DETECT ≠ REPAIR）；
- **不得**使用 `UNIQUE(org, settlementId)` 全局锁死（该写法在 S1 中明确禁止）。

### 11.2 full-reversal 唯一语义（MSG-54 CHANGE B1 收紧）

v1 下对任一 original Settlement：

```text
有效 REVERSAL 数 ∈ {0, 1}
且若为 1：amount == 原 Settlement.amount（等额 full reversal）
```

- **不再**使用「总额 ≤ 原金额」的累计口径（v1 无 partial reversal）；
- partial reversal / CORRECTION → **fail-closed**（`ADJUSTMENT_KIND_NOT_ENABLED`）；
- 第二个**不同** reversal event 指向同一 Settlement → `REVERSAL_ALREADY_APPLIED`；
- **同一** reversal event replay → `REUSED existing adjustment`（幂等复用，不新建、不报错）。

实现：`UNIQUE (organizationId, originalSettlementId)` on `SettlementAdjustment`（v1 因只有 full reversal 而等价于「0 或 1」）+ `BEFORE INSERT` 跨行校验触发器（等额 / 同币种 / 同租户）+ 服务层 `SELECT … FOR UPDATE` 双保险。

### 11.3 CHANGE B —— Settlement ↔ Snapshot 唯一且不可漂移

| 规则 | 实现 |
| --- | --- |
| 已记录 Settlement **必须**绑定一个 immutable ReceiptSnapshot | `receiptSnapshotId` 在状态进入 RECEIVED/PARTIAL 时非空；由 S1 CHECK + S2 服务层共同保证 |
| `receiptSnapshotId` **创建后不可改** | `Settlement` 受控变更触发器：`receiptSnapshotId`、身份四列、`financialEventFingerprint` 两列一旦非空即拒绝 UPDATE |
| snapshot `digest` / `snapshotVersion` **不可改** | `SettlementReceiptSnapshot` append-only（BEFORE UPDATE OR DELETE → 拒绝） |
| 更正 receipt evidence | **新 snapshot（新 version + 新 digest）+ 新 Settlement/adjustment path**；不得 UPDATE 已确认 Settlement 的 receipt basis |

> 冻结：Settlement 的到账事实**不得**在审批后重新指向另一个 snapshot。

### 11.4 CHANGE C —— Invoice 不得从 Fee 自动产生

```text
FeeCalculation exists ≠ Invoice may automatically issue
```

S5 必须先设计/实现：`fee eligibility` → `invoice candidate` → `invoice draft linkage` → `separate authorization`。
除既有 `billing.invoice_issue` Gate 已明确批准外，**S5 不得**把 FeeCalculation 自动推进为 ISSUED invoice（`BillingInvoice` / `BillingStatus` 在 R46-A/B/S1 均不变）。

### 11.5 CHANGE C1 修正 —— adjustment 符号契约

| 规则 | 说明 |
| --- | --- |
| 存储 | adjustment 行**只存正数** `amount` |
| 方向 | 由 `kind` 决定：`REVERSAL → −amount`；`VOID → −originalFeeAmount`；`CORRECTION → 由明确 correction semantics 决定` |
| 计算 | 统一由 projector / service 计算 effect，**禁止**在数据层自行写负数造成 `-(-100)` 双重符号歧义 |

`FeeCalculationSettlement.amountContribution` 保留带符号语义（membership 是计算结果，不是输入契约）。

### 11.6 FeeCalculationAdjustment 三分类语义（MSG-54 ①）

| kind | 含义 | 必备规则 |
| --- | --- | --- |
| `VOID` | 原 FeeCalculation **从业务事实起点**就不应成立 | 必须有 `reasonCode`；`amount == originalFeeAmount`（正数存储）；`triggerSettlementAdjustmentIds` 可为空 |
| `REVERSAL` | 原计算当时成立，后来因 Settlement reversal 等后续资金事实需要冲减 | 必须引用 ≥1 个 `SettlementAdjustment`；evidence ≥ 1 |
| `CORRECTION` | 原计算的输入 / 政策 / 费率事实后来被纠正 | 必须携带纠正后的依据引用（`feePolicyRef` / `feeBasisVersion`）+ evidence ≥ 1 |

三者**不得只是 UI 标签**；`reasonCode` / `evidence` / `sourceFact` / `amount` 规则必须可被 DB CHECK 或触发器区分。**任何 Adjustment 均不得直接修改历史 `FeeCalculation.status` / `amount`**；净值只能由 `original + immutable adjustments` 推导。

### 11.7 S1 范围（MSG-54 ④）

S1 **只允许**：

1. `schema.prisma`：4 新表 + 2 表纯增列 + 新增枚举；
2. migration：表 / 列 / FK（含复合 FK）/ unique / partial unique / index / CHECK；
3. 触发器：租户保护（tgtype 23）× 4 新表；append-only（tgtype 27）× 4 新表；`Settlement` 新列受控变更；`SettlementAdjustment` 跨行不变量；
4. `tools/tenant-triggers/{required,append-only}-triggers.json` 清单同步；
5. fresh deploy + two-stage upgrade 测试 + architecture contract 更新。

S1 **不得**：创建 Settlement · 记录 receipt · 创建 reversal · 计算 Fee · 创建 Invoice · 修改 RecoveryLedger · 激活 Payment（**零资金业务行为证明**必须出现在 S1 Checkpoint 中）。

### 11.8 S1 Checkpoint 必报项（MSG-54 NEXT）

1. fee-chain identity / uniqueness 最终方案（§11.1）；
2. Settlement ↔ Snapshot immutability（§11.3）；
3. full-reversal unique 语义（§11.2）；
4. FK / partial unique / CHECK / triggers 清单；
5. trigger inventories；
6. fresh deploy；
7. two-stage upgrade；
8. architecture contract；
9. **零资金行为证明**。

### 11.9 MSG-54 新增 10 项永久验收的归属

| # | 验收 | Stage |
| --- | --- | --- |
| 1 | 同一 Settlement 在同一 fee calculation 内重复 membership → 拒绝 | S1 / S4 |
| 2 | 同一 Settlement 在合法 superseding fee chain 中如何处理 → 明确并测试 | S4 |
| 3 | 两个无关 active fee chains 同时消费同一 Settlement → fail-closed | S1 / S4 |
| 4 | Settlement 创建后修改 receiptSnapshotId → DB/service 拒绝 | S1 |
| 5 | ReceiptSnapshot digest / version UPDATE → 拒绝 | S1 |
| 6 | full reversal 第二个不同事件 → 拒绝 | S1 / S3 |
| 7 | same reversal replay → REUSED | S3 |
| 8 | FeeCalculationAdjustment 不修改历史 FeeCalculation | S4 |
| 9 | adjustment effect 符号由 kind 统一解释 | S4 |
| 10 | FeeCalculation 创建后 BillingInvoice 仍为 0，直到独立 invoice authorization | S5 |
