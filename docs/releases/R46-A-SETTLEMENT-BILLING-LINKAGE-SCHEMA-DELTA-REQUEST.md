# R46-A — Settlement / Billing Linkage — Schema Delta Request

> 依据：**MSG-20261002-52 = PASS WITH REVISE**（R46 Design Proposal 裁决）：原则批准事实分层；批准 Q2 / Q11；下达 **CHANGE A/B/C/D/E**；登记 3 项 RISK 与 **15 项永久验收**；NEXT 要求**同一原子资金模型一次完整送审**（不逐表分批）。
> 状态：**docs-only 请求** —— 本文件**不实施** Schema 变更、**不写** migration、**不改**代码；等架构方批准后再提交 R46-B Implementation Plan。
> 边界：**NO Settlement creation from R45 · NO FeeCalculation creation · NO BillingInvoice issuance · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials**；R13 **Payment Activation Gate 继续 HOLD**。
> 继承线：R12（Success Fee / Billing 红线）、R13（支付授权分离 / Onboarding）、R14（Customs / BrokerConnector）。

---

## 0. 本次请求的完整性承诺

MSG-20261002-52 明确要求「同一原子资金模型应一次完整送审，避免分批 Schema 形成临时不完整资金状态」。因此本请求**一次性**定义以下全部内容，任何一项被裁为不可接受都不单独落地：

| 编号 | 内容 | 对应要求 |
| --- | --- | --- |
| ① | Settlement 外部资金身份 | CHANGE A |
| ② | Settlement reversal / adjustment | CHANGE B |
| ③ | provenance / evidence | MSG-52 NEXT |
| ④ | Settlement ↔ Claim / Case linkage | MSG-52 NEXT / Q2 |
| ⑤ | FeeCalculation ↔ Settlement membership | CHANGE C |
| ⑥ | net billable basis | CHANGE C / R12 |
| ⑦ | idempotency | CHANGE A / E / Q10 |
| ⑧ | approval-bound receipt snapshot | CHANGE E |
| ⑨ | invoice linkage 边界 | CHANGE D |
| ⑩ | indexes / unique / CHECK / triggers | MSG-52 NEXT |
| ⑪ | migration impact | MSG-52 NEXT |

**本请求不包含**：BillingInvoice 状态机变更（CHANGE D 明令不得在 R46-A 顺便修改）、Payment / PaymentEvent / PaymentProcessingAttempt 变更、FX / 换汇、平台外写、transport、生产凭据。

---

## 1. 现状核对（CHANGE D 的前置动作）

CHANGE D 要求「R46-A 必须先核对现有 BillingInvoice 状态机」。核对对象为当前 `apps/api/prisma/schema.prisma`（模型 51 / 枚举 51）。

### 1.1 `Settlement`（现有，44→51 模型基线内）

| 现有字段 | 类型 | 与本请求的关系 |
| --- | --- | --- |
| `id` / `organizationId` / `caseId?` | — | 保留；`caseId` 为弱引用 |
| `status` | `SettlementStatus`（`EXPECTED` / `RECEIVED` / `PARTIAL` / `DISPUTED` / `VOID`） | 保留 |
| `source` | `SettlementSource`（`PLATFORM_CREDIT` … `OTHER`） | 保留；与新增 `externalIdentityKind` 正交 |
| `amount` / `currency` | `Decimal(18,4)` / `String` | 保留；**不改写历史金额** |
| `receivedAt?` | `DateTime?` | 保留；进入 receipt snapshot |
| `externalRef?` | `String?` | **缺口**：无唯一约束、无 kind、无版本、无 digest |
| `evidenceId?` | `String?` | 保留；快照中扩展为 evidence 集合 + digest |
| `confirmedBy` / `confirmedAt` / `confirmedByUserId` | — | 保留 |
| `confirmationStatus` | `CONFIRMED` / `PENDING_CONFIRMATION` / `REJECTED_BY_REVIEW` | 保留 |
| `reconciliationStatus` | `NOT_STARTED` / `PARTIAL` / `RECONCILED` / `DISPUTED` / `REVERSED` | 保留 |
| `reversedBySettlementId?` | 自引用 FK | **v1 legacy 冲回链**；与 CHANGE B 冲突（见 §5.4、§11.3） |

**结论**：Settlement **缺少 CHANGE A 要求的不可变外部资金身份**，也**没有 ClaimItem / linkage basis 字段**、**没有 receipt snapshot 绑定**。

### 1.2 `BillingInvoice` / `BillingStatus`

`BillingStatus` 现有取值：`DRAFT` / `ISSUED` / `PAID` / `PARTIALLY_PAID` / `VOID` / `WRITTEN_OFF`。

**核对结论（CHANGE D）**：

1. `VOID` 与 `WRITTEN_OFF` **已存在**；
2. `CREDIT` / `CREDIT_NOTE` **不存在**；
3. 因此「已签发 Invoice 走 VOID/WRITTEN_OFF」中涉及 credit / credit-note 的部分**当前无状态可表达**；
4. **裁决落地**：R46-A **不修改 `BillingInvoice` / `BillingStatus`**；VOID（本不应成立）/ CREDIT·CREDIT_NOTE（已成立后冲回）/ WRITTEN_OFF（仍应收但决定不收）三者的 semantics 由**独立提案**提出（本文件 §7.3 只登记边界与触发条件）。

### 1.3 `FeeCalculation`

现有：`billingInvoiceId?` / `settlementId?` / `caseId?` / `basis`(`FeeBasis`) / `rate?` / `baseAmount` / `feeAmount` / `currency` / `computation Json` / `calculatedAt`。

**缺口（CHANGE C）**：只有单个可空 `settlementId`，**无法表达「这笔 fee 由哪些 Settlement / adjustment 构成」**，多笔到账、部分到账、reversal 后无法逐笔追溯。

### 1.4 `RecoveryLedgerEntry`

现有：append-only（`cc_append_only__*` 清单）+ `entryType`(`DISCOVERED`/`RECOVERED`/`ADJUSTMENT`/`REVERSAL`/`WRITE_OFF`) + `voidsEntryId` / `voidedAt` / `voidReason` + `settlementId?`。

**结论**：账本层**已具备**「冲正以新行表达、不覆盖历史」的语义；R46-A **不改其结构**，仅在 §10 登记触发器等清单不变。

### 1.5 触发器 / 清单现状

| 清单 | 路径 | R46-A 影响 |
| --- | --- | --- |
| append-only / 受控变更 | `tools/tenant-triggers/append-only-triggers.json` | **新表必须登记**（SettlementAdjustment 等） |
| 租户保护必需触发器 | `tools/tenant-triggers/required-triggers.json` | **新 tenant-owned 表必须登记**，否则 CI 失败 |
| 一致性 checker | `tools/consistency/check-reconciliation.mjs`（R45 S5） | R46 收口时扩展；**不得**在 R46-A 阶段改动 |
| two-stage upgrade | `tools/upgrade-verify/two-stage-upgrade.mjs` | R46 迁移需通过保数据升级 |

### 1.6 既有 Settlement 写入路径（migration impact 输入）

已存在的写入 / 依赖点（**R46-A 不改动任何一行代码**，仅登记影响面）：

- `apps/api/src/services/workflow/recovery-outcome.ts`（`tx.settlement.create`）
- `apps/api/src/services/recovery/closure-service.ts`（`tx.settlement.create` / `findFirst`）
- `apps/api/src/services/recovery/recovery-confirmation.ts`（`updateMany`：确认 / 冲回）
- `apps/api/src/services/workflow/commission-reconciliation.ts`、`dashboard-projection.ts`、`notification-projection.ts`（只读聚合）
- R12 红线判定中的 `Settlement.reversedBySettlementId IS NULL`

---

## 2. 目标不变量（R46 v1，Schema 层必须可强制）

| 编号 | 不变量 | 强制手段 |
| --- | --- | --- |
| I1 | 每条 Settlement 有**唯一、不可变、外部可验证的资金身份** | §4 unique + append-only 列 |
| I2 | 同一外部到账事件重复录入 → **仍只有 1 条 Settlement**（复用，不报错、不双计） | §4 unique + 幂等读回 |
| I3 | 不同外部到账事件 → **允许**形成多笔 Settlement（同一 Claim 可 1:N） | §4（不同 identity 即不同行） |
| I4 | Settlement 归属某 Claim/Case 必须有**可追溯 linkage basis**，不得「无归属到账」 | §4.4 必填绑定 + CHECK |
| I5 | reversal / correction **不修改、不删除**原 Settlement | §5（新事实表）+ append-only 触发器 |
| I6 | 同一 reversal event 幂等；**不允许重复 full reversal** | §5.3 unique + 净额 CHECK |
| I7 | reversal 后**净可计费金额可重算**，且降额正确 | §6.4 净额定义 + checker |
| I8 | Fee 必须能回答「由哪些 Settlement / adjustment 构成」 | §6 membership 关系 |
| I9 | 同一 Settlement 不得进入两个重复 FeeCalculation | §6.3 unique + checker |
| I10 | `settlement.record` 的 humanApproval 绑定 **receipt snapshot**；审批后关键字段变化 → approval 失效 | §8 snapshotDigest + boundExtra |
| I11 | v1 **不换汇**；币种不一致 fail-closed | §6.5 CHECK |
| I12 | Invoice creation ≠ Payment collected | §7 边界（Payment 仍 HOLD） |

---

## 3. Schema Delta 总览（一次完整）

| 变更 | 类型 | 说明 |
| --- | --- | --- |
| `Settlement` **增列**（全部 nullable，向后兼容） | ALTER TABLE | 外部资金身份三元组 + linkage basis + receipt snapshot 指针 + `status` 之外的净额无关字段（见 §4.1 / §8.2） |
| `SettlementAdjustment` | **新表（append-only）** | 独立 reversal / correction 财务事实，引用原 Settlement（§5） |
| `FeeCalculationSettlement` | **新表（append-only membership）** | Fee ↔ Settlement / adjustment 逐笔关系（§6） |
| `BillingInvoice` / `BillingStatus` | **不变** | CHANGE D：credit semantics 单列（§7.3） |
| `RecoveryLedgerEntry` | **不变** | 既有 append-only 语义已满足 |
| 触发器 / 清单 | **登记** | 新表进 append-only 与租户保护清单（§10） |

> 设计原则：**新增能力一律用「新表 / 新列 + append-only」，不改造既有列的语义**。任何需要「改历史行」才能成立的方案在本请求中被否决。

---

## 4. Settlement 外部资金身份（CHANGE A）

### 4.1 新增列（`Settlement`）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `externalIdentityKind` | enum `SettlementExternalIdentityKind` | `BANK_TRANSACTION` \| `PSP_SETTLEMENT` \| `PLATFORM_SETTLEMENT_REPORT` \| `CARRIER_SETTLEMENT` \| `INSURER_PAYOUT` \| `CHECK_REFERENCE` \| `MANUAL_DOCUMENT` \| `OTHER` |
| `externalIdentityValue` | `String?` | **服务端 canonical 化**后的外部引用原文（trim → NFKC → 去零宽 → 折叠空白；**不 lower-case**，与 R43 S4 canonicalizer 同规则族） |
| `externalIdentityValueHash` | `String?` | `sha256(externalIdentityValue)` 十六进制小写；用于唯一约束（避免大小写/长度噪声） |
| `externalIdentityVersion` | `String?` | `'v1'`；canonical 规则版本化 |
| `financialEventFingerprint` | `String?` | 无稳定外部 ID 时由服务端构造：`sha256('sfp-v1' \| provider/source \| caseRefCanonical \| occurredAt(UTC ms) \| amount(canonical 4dp) \| currency)` |
| `financialEventFingerprintVersion` | `String?` | `'sfp-v1'` |
| `claimItemId` | `String?` | **linkage basis**：该笔到账归属的 ClaimItem（弱引用，同租户强校验） |
| `linkageBasisKind` | enum `SettlementLinkageBasisKind` | `CLAIM_ITEM_DIRECT` \| `CASE_LEVEL_ALLOCATION` \| `MANUAL_BASIS`（v1 至少支持前两者） |
| `linkageBasisRef` | `String?` | 依据引用（如 allocation note / 人工依据 id）；`MANUAL_BASIS` 必填 |
| `receiptSnapshotId` | `String?` | 指向 §8 的 receipt snapshot |

### 4.2 唯一约束（CHANGE A 的核心）

```text
-- 稳定外部 ID 路径
UNIQUE (organizationId, externalIdentityKind, externalIdentityValueHash)
  WHERE externalIdentityValueHash IS NOT NULL

-- 无稳定 ID 路径（版本化指纹）
UNIQUE (organizationId, financialEventFingerprint)
  WHERE financialEventFingerprint IS NOT NULL

-- 二者必须有其一（不允许「无身份到账」）
CHECK (externalIdentityValueHash IS NOT NULL OR financialEventFingerprint IS NOT NULL)
CHECK (externalIdentityVersion IS NULL OR externalIdentityVersion = 'v1')
CHECK (financialEventFingerprintVersion IS NULL OR financialEventFingerprintVersion = 'sfp-v1')
CHECK (externalIdentityValueHash IS NULL OR externalIdentityValueHash ~ '^[0-9a-f]{64}$')
CHECK (financialEventFingerprint IS NULL OR financialEventFingerprint ~ '^[0-9a-f]{64}$')
CHECK (amount > 0)
CHECK (currency ~ '^[A-Z]{3}$')
```

### 4.3 幂等语义（与 R45 S2 对齐）

| 场景 | 行为 |
| --- | --- |
| 同一 external identity **完全重放**（金额 / 币种 / receivedAt / evidence 一致） | **RESULT = REUSED**：读回既有 Settlement，**不新建、不报错、不双计** |
| identity 相同但关键事实冲突（金额 / 币种 / receivedAt / receipt identity 不一致） | **EVENT_IDENTITY_CONFLICT** → fail-closed，零写入 |
| identity 不同 | **distinct Settlement**（允许同一 Claim 多笔） |
| 无稳定 ID 且 fingerprint 为空 | 拒绝（`MISSING_EXTERNAL_IDENTITY`） |

> 明确沿用 MSG-20261002-50 CHANGE A 的术语纪律：**「完全重放」= 幂等复用；「身份冲突」= 业务冲突 fail-closed**。二者不得都叫「幂等失败」。

### 4.4 linkage basis（Q2 的落地）

- `FULLY_RECONCILED` **不是**创建 Settlement 的前提（Q2）。
- 但每条 Settlement **必须**能回答「这笔钱归哪个 Claim / Case」。v1 规则：
  1. `claimItemId` 非空 → `linkageBasisKind = CLAIM_ITEM_DIRECT`；
  2. `claimItemId` 为空但 `caseId` 非空且带 `CASE_LEVEL_ALLOCATION` 依据 → 允许，**但不产生可计费 basis**，直到后续被显式分配到 ClaimItem；
  3. `MANUAL_BASIS` 必须有 `linkageBasisRef` + humanApproval（§8）。
- **禁止**「无归属到账」：`linkageBasisKind IS NULL` 的 Settlement 不得存在。

---

## 5. Settlement reversal / adjustment（CHANGE B）

### 5.1 新表 `SettlementAdjustment`（append-only）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` / `organizationId` | — | 租户边界 |
| `originalSettlementId` | FK → `Settlement.id` | **引用原 Settlement**；`ON DELETE RESTRICT`（原记录不可删） |
| `adjustmentKind` | enum `SettlementAdjustmentKind` | `REVERSAL`（全额或部分冲回） \| `CORRECTION`（金额更正，正负皆可，`amount` 带符号） |
| `amount` | `Decimal(18,4)` | `REVERSAL` 恒 > 0；`CORRECTION` 可为负；`amount <> 0` |
| `currency` | `String` | 必须与原 Settlement 一致（`CURRENCY_MISMATCH` fail-closed） |
| `occurredAt` | `DateTime` | 外部事件时间 |
| `externalIdentityKind` / `Value` / `ValueHash` / `Version` | 同 §4.1 | **reversal 自身必须有外部 identity / provenance** |
| `financialEventFingerprint` / `Version` | 同 §4.1 | 无稳定 ID 时的版本化指纹 |
| `evidenceArtifactIds` | `String[]`（或关系表） | ≥1；逐条校验存在 / 同租户 / 不重复 |
| `reasonCode` / `reasonText` | `String` / `String?` | 结构化理由 |
| `approvalId` | `String` | humanApproval 绑定（同租户唯一，沿用 R43 `UNIQUE(organizationId, approvalId)` 模式） |
| `createdByUserId` / `createdAt` | — | actor |

### 5.2 不变量（Schema + CHECK + 触发器）

```text
UNIQUE (organizationId, externalIdentityKind, externalIdentityValueHash)   -- adjustment 间去重
UNIQUE (organizationId, financialEventFingerprint)
UNIQUE (organizationId, approvalId)                                        -- 每个审批恰好消费一次
CHECK  (amount <> 0)
CHECK  (adjustmentKind <> 'REVERSAL' OR amount > 0)
CHECK  (currency ~ '^[A-Z]{3}$')
-- 触发器：BEFORE UPDATE OR DELETE → 拒绝（cc_append_only__SettlementAdjustment）
```

### 5.3 reversal 语义

1. **同 reversal event 幂等**：同 external identity 重放 → 复用既有 adjustment；
2. **不允许重复 full reversal**：净冲回额不得超过原 Settlement 的 `amount`（`OVER_REVERSAL` fail-closed）；
3. **原 Settlement 永久保留**：`amount` / `receivedAt` / `externalRef` / `evidenceId` 一律不可改；
4. **reversal 后净可计费金额可重算**（§6.4）；
5. `Settlement.status` **不因 reversal 被改写历史值**；v1 保持原状态，冲回关系由 `SettlementAdjustment` 表达。

### 5.4 legacy `Settlement.reversedBySettlementId` 的处置（**需架构方裁定**）

现状：`reversedBySettlementId` 是 v1 冲回链，指向**另一条 Settlement 行**，并被 R12 红线判定、`recovery-confirmation.ts`、`check-reconciliation.mjs` 引用。

本请求提出**兼容策略（推荐）**：

1. **不删除**该列、**不改语义**（避免破坏 R12 红线与既有测试基线）；
2. 新增 `SettlementAdjustment` 作为 R46 的**规范冲回事实**；
3. 由 R46-B Plan 决定迁移顺序：先双写（legacy 链 + 新 adjustment），再在 R46-C 收口为单一来源；
4. R46 一致性 checker 增加「legacy 链与新 adjustment 一致」检查（DETECT ≠ REPAIR）。

> 备选（不推荐，仅登记）：给 `Settlement` 加 `kind`(RECEIPT/REVERSAL) 判别列，把冲回也建成 Settlement 行。否证理由：会让「Settlement = 到账事实」这一核心语义被稀释，且与 CHANGE A 的唯一身份约束相互作用复杂。

---

## 6. FeeCalculation ↔ Settlement membership（CHANGE C）

### 6.1 新表 `FeeCalculationSettlement`（membership，append-only）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` / `organizationId` | — | 租户边界 |
| `feeCalculationId` | FK → `FeeCalculation.id` | 所属计费事实 |
| `settlementId` | FK → `Settlement.id` | 参与计费的具体到账 |
| `adjustmentId` | FK → `SettlementAdjustment.id`? | 冲回 / 更正项（负向贡献） |
| `basisRole` | enum | `POSITIVE`（到账） \| `NEGATIVE`（冲回 / 更正） |
| `amountContribution` | `Decimal(18,4)` | `POSITIVE` 恒 > 0，`NEGATIVE` 恒 < 0 |
| `currency` | `String` | 与 Settlement / Fee 一致（不一致 fail-closed） |
| `createdAt` | — | — |

```text
UNIQUE (feeCalculationId, settlementId, adjustmentId)
CHECK  (basisRole = 'POSITIVE' AND adjustmentId IS NULL OR basisRole = 'NEGATIVE' AND adjustmentId IS NOT NULL)
CHECK  (basisRole = 'POSITIVE' AND amountContribution > 0 OR basisRole = 'NEGATIVE' AND amountContribution < 0)
-- 触发器：BEFORE UPDATE OR DELETE → 拒绝
```

### 6.2 FeeCalculation 侧的增量

- 新增 `membershipDigest`（`String?`）：`sha256(canonical(membership 集合 + 金额 + 币种 + basis version))`；用于「同一 Settlement 不得进入两个重复 FeeCalculation」的判定与审计；
- 新增 `feeBasisVersion`（`String?`）/ `policyRef`（`String?`）：记录本笔计费所依据的费率版本（R12「依据存在且唯一」口径的延伸）；
- 保留 `settlementId?` 作为 **legacy 单笔指针**：仅当 membership 恰好 1 条且 `basisRole = POSITIVE` 时等于该 settlementId，否则 `NULL`。**禁止**用它做金额推导。
- `FeeCalculation.baseAmount` 必须 = `Σ amountContribution`（由服务端计算 + checker 校验）。

### 6.3 唯一性 / 防重复计费

```text
-- v1：同一 Settlement 在同一 effective 期间最多进入一个「未作废」FeeCalculation
PARTIAL UNIQUE (organizationId, settlementId)
  WHERE voidedAt IS NULL        -- 需要 FeeCalculation 增加 void 语义或使用独立作废表（见 §6.6）
```

> 该约束按 §6.6 的作废模型确定最终形态；本请求先固定**语义**：同一 Settlement（或同一 adjustment）在同一有效期内**不得**被重复计入两个有效 FeeCalculation。

### 6.4 net billable basis（可计费净额）

```text
netBillable(claimItem) =
      Σ Settlement.amount           [eligible: status ∈ {RECEIVED, PARTIAL}
                                     ∧ confirmationStatus = CONFIRMED
                                     ∧ reconciliationStatus ∈ {RECONCILED, PARTIAL}
                                     ∧ evidenceId 非空
                                     ∧ currency = basis.currency
                                     ∧ claimItemId = claimItem]
    − Σ SettlementAdjustment.amount [kind ∈ {REVERSAL, CORRECTION} 且指向上述 Settlement]
```

- 单笔 Settlement 只按其**已到账部分**（`amount`，而不是 projection 的 expected）计入；
- 币种不一致 → 该笔**不计入**，并产出 `CURRENCY_MISMATCH` 例外（v1 不换汇）；
- `netBillable <= 0` → **不可计费**（不产生 FeeCalculation）。

### 6.5 与 R12 红线的一致性

本请求的 membership 与净额定义**不替换** R12 的可计费判定，而是把 R12 第 5 条（「未被冲回」）从「单个 `reversedBySettlementId IS NULL`」升级为「净额口径」，并保持 R12 其余判定逐条不变。

### 6.6 FeeCalculation 作废语义（**需架构方裁定**）

reversal 到来后，既有 FeeCalculation 必须可重算。三种候选：

1. **不动作 + 新 FeeCalculation 覆盖**（append-only，用 `supersededByFeeCalculationId` 指针）；
2. 新增 `FeeCalculationVoid` 作废事实（append-only，引用被作废的 FeeCalculation + 理由 + approval）；
3. 给 `FeeCalculation` 加 `voidedAt` / `voidReason`（受控变更）。

本请求**推荐方案 2**（与 SettlementAdjustment、R45 受控 supersede 的模式一致），但该决定影响 §6.3 的 partial unique 形态，因此显式请架构方裁定。

---

## 7. invoice linkage 边界（CHANGE D）

### 7.1 R46-A 允许做的

- **不改** `BillingInvoice` / `BillingStatus`；
- 保留既有 `FeeCalculation.billingInvoiceId` → `BillingInvoice` 关系；
- 在文档层固定可追溯链：`BillingInvoice ← FeeCalculation ← FeeCalculationSettlement ← Settlement / SettlementAdjustment`。

### 7.2 R46-A 明确禁止的

- 新增 / 修改 BillingStatus 枚举值；
- 把「发票已开」解释为「已收款」（`Invoice creation ≠ Payment collected`）；
- 依据 Invoice 状态推导 Settlement / Fee。

### 7.3 需单列的 Billing reversal / credit semantics（不在 R46-A）

| 语义 | 含义 | 当前枚举 | 处置 |
| --- | --- | --- | --- |
| `VOID` | 账单**本来就不应成立**（错开、重复开） | ✅ 已有 | R46-A 不动；由独立提案定义适用条件 |
| `CREDIT` / `CREDIT_NOTE` | 已成立，后来**部分或全部冲回**（对应 reversal） | ❌ **缺失** | **独立提案**（Billing Reversal / Credit Semantics）提出后再实施 |
| `WRITTEN_OFF` | 应收**仍成立**，但决定不再收取 | ✅ 已有 | R46-A 不动；适用条件由独立提案定义 |

> 触发条件（本文件只登记、不实施）：当 `SettlementAdjustment` 导致已签发 Invoice 的计费基数下降时，系统必须进入「需要 credit 处理」的显式状态，而**不是**直接修改 Invoice 金额。

---

## 8. approval-bound receipt snapshot（CHANGE E）

### 8.1 新表 `SettlementReceiptSnapshot`（服务端构造）

| 字段 | 说明 |
| --- | --- |
| `id` / `organizationId` | — |
| `claimItemId?` / `caseId?` | claim / case linkage |
| `externalIdentityKind` / `ValueHash` / `Version` | external receipt identity |
| `financialEventFingerprint` / `Version` | 无稳定 ID 路径 |
| `amount` / `currency` / `receivedAt` | 资金事实 |
| `evidenceReferences` | `{ evidenceArtifactId, digest, kind }[]` |
| `sourceKind` | `OFFICIAL_API` \| `PLATFORM_REPORT` \| `BANK_STATEMENT` \| `PSP_SETTLEMENT_REPORT` \| `MANUAL_DOCUMENT` |
| `snapshotVersion` | `'v1'` |
| `snapshotDigest` | `sha256(canonical(上述全部字段))` |
| `createdByUserId` / `createdAt` | — |

### 8.2 审批绑定

- `settlement.record` 的 approval 创建时，`boundExtra` **必须**包含 `receiptSnapshotDigest`（服务端构造，客户端不得自证；沿用 R44-A「服务端额外绑定键」模式）；
- 执行时**锁后重验**：快照 digest 与当前请求载荷不一致 → `APPROVAL_BINDING_MISMATCH` fail-closed；
- **审批后** `amount` / `currency` / `receipt identity` / `evidence` / `receivedAt` 任一变化 → **原 approval 失效**（不得复用）；
- `Settlement.receiptSnapshotId` 指向实际使用的快照，供 checker 交叉验证。

### 8.3 动作与闸门（与 R46 Design §Q12 一致）

| 动作 | 类型 | 闸门 |
| --- | --- | --- |
| `settlement.record` | `INTERNAL_WRITE` | humanApproval + **receipt snapshot 绑定** + 锁后 ACTIVE membership/role 重验 + evidence 校验 |
| `settlement.adjust`（reversal / correction） | `INTERNAL_WRITE` | 同上 + 原 Settlement 引用校验 + 净额 CHECK |
| `billing.fee_calculate` | `INTERNAL_WRITE` | humanApproval + net billable basis + membership 唯一 |
| `billing.invoice_issue` | `INTERNAL_WRITE` | humanApproval + 有效 FeeCalculation（沿用 `billing.draft` 锁后重读 / 依据唯一 / `BILLING_BASIS_REQUIRED`） |
| `payment.capture` | `MONEY_MOVEMENT` | **productionGate（HOLD）** |

---

## 9. 幂等 / 并发 / 重跑（Q10 四道防线）

1. **分层隔离**：R45 reconciliation 重跑**只**产生 projection（derived），**不得**触碰 Settlement / Adjustment / Fee / Invoice（永久验收第 12、11 项）；
2. **服务端幂等键**：Settlement 走 §4.2 的两个 unique；Adjustment 走 §5.2；Fee 走 §6.3 + `membershipDigest`；Invoice 沿用既有 `BILL-<caseNo>` 唯一口径；
3. **approval 恰好消费一次**：`UNIQUE(organizationId, approvalId)`（Settlement / Adjustment / Override / Fee 各处同模式）；
4. **R46 checker**：在 R46 收口阶段新增只读检查（DETECT ≠ REPAIR），覆盖 §12 的映射表。

并发约束沿用既有模版：`SELECT … FOR UPDATE`（claim / settlement 作用域）+ CAS（`WHERE id = ? AND version = ?`）+ advisory lock（如需要）+ 任何一步失败**整体回滚**。

---

## 10. 索引 / 唯一 / CHECK / 触发器清单（一次完整）

| 表 | unique / index | CHECK | 触发器清单 |
| --- | --- | --- | --- |
| `Settlement`（增列） | `UNIQUE(org, externalIdentityKind, externalIdentityValueHash) WHERE …`；`UNIQUE(org, financialEventFingerprint) WHERE …`；`INDEX(org, claimItemId, receivedAt)` | `amount > 0`；`currency ~ '^[A-Z]{3}$'`；身份二选一；fingerprint/hash 形状 | 租户保护（既有清单模式）；**金额 / 身份列不可改**（受控变更函数） |
| `SettlementAdjustment`（新） | `UNIQUE(org, kind, valueHash)`；`UNIQUE(org, fingerprint)`；`UNIQUE(org, approvalId)`；`INDEX(org, originalSettlementId)` | `amount <> 0`；`REVERSAL ⇒ amount > 0`；`currency` 形状 | `cc_append_only__SettlementAdjustment`（tgtype 27）+ 租户保护（tgtype 23） |
| `FeeCalculationSettlement`（新） | `UNIQUE(feeCalculationId, settlementId, adjustmentId)`；`INDEX(org, settlementId)` | `basisRole/amountContribution` 符号一致性 | `cc_append_only__FeeCalculationSettlement` + 租户保护 |
| `SettlementReceiptSnapshot`（新） | `INDEX(org, createdAt)` | `snapshotDigest ~ '^[0-9a-f]{64}$'`；evidence ≥1 | `cc_append_only__SettlementReceiptSnapshot` + 租户保护 |
| `BillingInvoice` / `BillingStatus` | **不变** | **不变** | **不变** |

> 所有新增 tenant-owned 表**必须**同步登记到 `tools/tenant-triggers/required-triggers.json` 与 `append-only-triggers.json`，否则 CI 失败（B2-FIX R1 / MSG-20260930-06 CHANGE D）。

---

## 11. migration impact（迁移影响）

### 11.1 结构影响

- `Settlement`：**纯增列**（全部 nullable）；无 backfill 强制要求 → 既有行仍合法（身份列可为空，由 checker 标记 `UNIDENTIFIED_EXTERNAL_IDENTITY` 而非阻断）；
- 新表 3 张（SettlementAdjustment / FeeCalculationSettlement / SettlementReceiptSnapshot）；
- 触发器：新增 3 组 append-only + 3 组租户保护；更新两份清单；
- **不删列、不改列类型、不改枚举既有值**。

### 11.2 数据迁移策略

1. 既有 Settlement 的 `externalRef` **不自动**升格为 `externalIdentityValue`（无法证明唯一性 / canonical 规则）；
2. 仅当同一 `(org, externalRef)` 在既有数据中**唯一**时可回填，且回填脚本必须**显式列出**回填集合；
3. 其余保持 NULL + checker 例外清单（v1 允许历史遗留存在，但**不允许新建**无身份 Settlement）。

### 11.3 legacy 路径改造顺序（R46-B Plan 决定）

`recovery-outcome.ts` / `closure-service.ts` / `recovery-confirmation.ts` 的改造必须**在 R46-B Plan 中显式排期**（含双写期与收口期）；R46-A 不修改任何代码。

### 11.4 回归保护

- R45 永久基线（S1–S5 / fresh migration / two-stage upgrade / tenant·append-only·controlled-mutation inventories / 176 files 1730 tests）**不得删除、skip 或弱化**；
- two-stage upgrade 必须覆盖 R46 新迁移（保数据 + 两套清单 + R45/R43 checker）。

---

## 12. 永久验收（MSG-20261002-52 的 15 项 → 设计归属）

| # | 永久验收 | 设计承载 | 归属阶段 |
| --- | --- | --- | --- |
| 1 | 同一到账事件重复录入 → Settlement 仍 1 | §4.2 / §4.3 | R46 S-settlement |
| 2 | 不同到账事件 → 可形成多笔 Settlement | §4.2 | R46 S-settlement |
| 3 | Settlement 无可信 evidence → 零写入 | §8.1 / §8.3 | R46 S-settlement |
| 4 | approval 后 amount/currency/reference/evidence 变化 → fail-closed | §8.2 | R46 S-settlement |
| 5 | partial Settlement 只按已到账部分进入 fee basis | §6.4 | R46 S-fee |
| 6 | reversal 不修改原 Settlement | §5.2 / §5.3 | R46 S-adjustment |
| 7 | duplicate reversal → 拒绝 / 幂等复用 | §5.2 / §5.3 | R46 S-adjustment |
| 8 | reversal 后净 fee basis 正确下降 | §6.4 | R46 S-adjustment |
| 9 | 同一 Settlement 不得进入两个重复 FeeCalculation | §6.3 | R46 S-fee |
| 10 | FeeCalculation 可追溯到具体 Settlement membership | §6.1 | R46 S-fee |
| 11 | reconciliation override 不产生 Settlement/Fee | §2 I12 / §9-1 | R46 S-checker |
| 12 | R45 projection 重跑不产生资金副作用 | §9-1 | R46 S-checker |
| 13 | currency mismatch 不自动换汇 | §6.4 / §6.5 | R46 S-checker |
| 14 | Invoice creation 不等于 Payment collected | §7 | R46 S-checker |
| 15 | Payment / R13 全程继续 HOLD | §7 / §8.3 | 全程 |

---

## 13. 与 R12 / R13 / R14 的关系

- **R12**：本请求把「未被冲回」从单列判定升级为净额口径（§6.5），其余判定逐条不变；
- **R13**：Payment Authorization 与 Platform OAuth 继续严格分离；`PaymentMethod` / `Mandate` / autopay **不**在本请求范围内；Payment Activation Gate 继续 HOLD；
- **R14**：BrokerConnector 与 Customs 资金回流不进入本次资金模型；退款优先进入 claimant 合法账户的约束不变。

---

## 14. 风险（回应 MSG-20261002-52 RISKS）

| 风险 | 载入点 | 缓解 |
| --- | --- | --- |
| 重复到账 → 重复 Settlement → 重复成功费 | §4.2 / §6.3 | 双重唯一约束 + membership 唯一 + checker |
| reversal 通过改历史金额破坏审计链 | §5.2 / §5.3 | append-only + 原 Settlement 只读 + 净额重算 |
| Fee 与 Settlement 缺逐笔关系，无法证明「这笔钱是否已收费」 | §6.1 | membership 表 + `membershipDigest` |
| （新增）partial unique 依赖作废模型未定 | §6.3 / §6.6 | 请架构方裁定作废语义后再定最终 DDL |

---

## 15. 裁决请求（编号）

1. §1 现状核对结论（尤其 CHANGE D：`BillingStatus` 已有 `VOID`/`WRITTEN_OFF`、缺 `CREDIT`/`CREDIT_NOTE`，故 R46-A **不改** BillingInvoice 状态机）是否认可？
2. §4 Settlement 外部资金身份（身份三元组 + versioned fingerprint + 双 unique + 「完全重放 = REUSED / 身份冲突 = fail-closed」）是否满足 CHANGE A？
3. §5 `SettlementAdjustment` 独立事实模型与 §5.4 的 legacy `reversedBySettlementId` 兼容策略（不删不改、新表为规范、双写→收口）是否批准？请特别裁定 §5.4 的选型（新表 vs `Settlement.kind` 判别列）。
4. §6 `FeeCalculationSettlement` membership + net billable basis 是否满足 CHANGE C？并请裁定 §6.6 的 FeeCalculation 作废语义（推荐方案 2：独立作废事实）。
5. §7 invoice linkage 边界 + §7.3 三项 semantics 单列（VOID / CREDIT·CREDIT_NOTE / WRITTEN_OFF）是否批准？
6. §8 receipt snapshot 与 approval 绑定规则是否满足 CHANGE E？
7. §10 索引 / 唯一 / CHECK / 触发器清单与 §11 migration impact 是否完整、可实施？
8. 批准后是否按 **R46-B Implementation Plan → S1…Sn**（同一原子资金模型，不逐表分批）推进？

> 边界（重申）：本请求为 docs-only；实施前保持 **NO Settlement creation from R45 · NO FeeCalculation · NO BillingInvoice issuance · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials**；R13 Payment Activation Gate 继续 HOLD。
