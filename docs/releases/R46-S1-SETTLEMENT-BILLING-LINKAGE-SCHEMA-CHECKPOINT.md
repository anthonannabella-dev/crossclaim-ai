# R46 S1 — Settlement / Billing Linkage · Schema Implementation Checkpoint

> 依据：**MSG-20261002-54 = PASS WITH REVISE**（批准进入 R46 S1，前置 = 把 CHANGE A/B/C 写进 S1 最终 Schema 实施口径；S1 只允许 Schema + migration + FK + unique/index + CHECK + triggers + inventories + fresh/upgrade tests，**零资金业务行为**）。
> 前置文件：`docs/releases/R46-B-SETTLEMENT-BILLING-LINKAGE-IMPLEMENTATION-PLAN.md` §11「S1 最终 Schema 实施口径」。
> 边界：**NO automatic Settlement from R45 · NO automatic Fee · NO automatic Invoice issuance · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials**；R13 **Payment Activation Gate = HOLD**。

---

## 1. 交付物

| 类别 | 交付 |
| --- | --- |
| Schema | `apps/api/prisma/schema.prisma`：4 新表 + 2 表纯增列 + 6 新枚举（`prisma format` 规范化） |
| Migration M1 | `20261001160000_settlement_billing_linkage_tables`：表 / 列 / index / FK / CHECK / partial unique |
| Migration M2 | `20261001160500_settlement_billing_linkage_tenant_triggers`：归属不可变 + 表级租户完整性 + 11 个 FK 租户守卫 |
| Migration M3 | `20261001161000_settlement_billing_linkage_append_only`：4 新表 append-only（BEFORE UPDATE OR DELETE → 拒绝） |
| Migration M4 | `20261001161500_settlement_billing_linkage_invariants`：到账依据不可漂移 / full-reversal 等额 / fee-chain 唯一 / VOID 等额 |
| Inventories | `tools/tenant-triggers/required-triggers.json`（71 条）+ `tools/tenant-triggers/append-only-triggers.json`（20 条，含 5 个资金域不变量触发器） |
| 架构契约 | `architecture-contract.test.ts`（119 → **140** 断言；模型总数 51 → **55 = 49 core + 6 join**）+ `DOMAIN_MODEL.md` 同步 |

**新增表**：`SettlementReceiptSnapshot`、`SettlementAdjustment`、`FeeCalculationSettlement`、`FeeCalculationAdjustment`。

**增列**：`Settlement`（external identity 三元组 + versioned fingerprint + `claimItemId` / `linkageBasisKind` / `linkageBasisRef` + `receiptSnapshotId`）；`FeeCalculation`（`feeChainId` / `feeChainRootFeeCalculationId` / `supersededByFeeCalculationId` / `claimItemId` / `membershipDigest` / `feeBasisVersion` / `policyRef`）。

**未改**：`BillingInvoice` / `BillingStatus` / `RecoveryLedgerEntry`。

---

## 2. fee-chain identity / uniqueness 最终方案（MSG-54 CHANGE A / F3 修正）

```text
feeChainId                     -- 稳定服务端 identity = 链根 FeeCalculation.id；supersede 时沿用
feeChainRootFeeCalculationId   -- 链根指针（root 自身为 NULL）
supersededByFeeCalculationId   -- 链内前向指针（仅版本协调，禁止用于金额推导）

-- 1) 同一链内不得重复纳入同一资金事实
UNIQUE (feeCalculationId, settlementId) WHERE settlementId IS NOT NULL
UNIQUE (feeCalculationId, adjustmentId) WHERE adjustmentId IS NOT NULL
cc_feecalculationsettlement_chain_unique → FEE_CHAIN_SETTLEMENT_ALREADY_CONSUMED / FEE_CHAIN_ADJUSTMENT_ALREADY_CONSUMED

-- 2) 同一 claimItem 至多一条 active 链
UNIQUE (organizationId, claimItemId) WHERE supersededByFeeCalculationId IS NULL AND claimItemId IS NOT NULL
```

**明确不采用**（MSG-54 明令禁止）：`UNIQUE(organizationId, settlementId)` 全局锁死；架构契约新增**反向断言**，防止将来被误加回。

**不变量**：同一个资金事实不得同时进入两个互不相关的 active fee chain；合法的 superseding / recalculation 走同一 `feeChainId`。

---

## 3. Settlement ↔ Snapshot 不可漂移（MSG-54 CHANGE B）

| 规则 | 实现 |
| --- | --- |
| snapshot 不可改 | `cc_append_only__SettlementReceiptSnapshot`（BEFORE UPDATE OR DELETE → 拒绝） |
| Settlement 到账依据创建后不可改 | `cc_settlement_receipt_basis_immutable`（BEFORE UPDATE）：`receiptSnapshotId` / `externalIdentityValueHash` / `financialEventFingerprint` 一旦非空即拒绝变更（`SETTLEMENT_RECEIPT_BASIS_IMMUTABLE` / `..._EXTERNAL_IDENTITY_IMMUTABLE` / `..._FINGERPRINT_IMMUTABLE`） |
| 更正路径 | 生成新 snapshot（新 `snapshotVersion` + 新 `snapshotDigest`）→ 重新审批；不得 UPDATE 已确认 Settlement 的 receipt basis |

---

## 4. full-reversal unique 语义（MSG-54 CHANGE B1 收紧）

```text
有效 REVERSAL 数 ∈ {0, 1}（每个 original Settlement）
UNIQUE (organizationId, originalSettlementId)
CHECK  (adjustmentKind = 'REVERSAL')     -- partial reversal / CORRECTION 在 v1 fail-closed
CHECK  (amount > 0)

触发器 cc_settlementadjustment_full_reversal_guard（BEFORE INSERT）：
  amount   ≠ 原 Settlement.amount      → REVERSAL_AMOUNT_MISMATCH
  currency ≠ 原 Settlement.currency    → REVERSAL_CURRENCY_MISMATCH
  跨租户                                → REVERSAL_CROSS_TENANT
```

原 Settlement 未被触碰（金额 / 状态 / 到账依据均不可改）。同一 reversal event replay → 幂等复用；第二个**不同** reversal event 指向同一 Settlement → 唯一约束 fail-closed（服务层显式错误码在 S3）。

---

## 5. FK / partial unique / CHECK / triggers 清单

**Partial unique（M1）**：`Settlement_org_identity_unique`、`Settlement_org_fingerprint_unique`、`SettlementAdjustment_org_identity_unique`、`SettlementAdjustment_org_fingerprint_unique`、`FeeCalculationSettlement_calc_settlement_unique`、`FeeCalculationSettlement_calc_adjustment_unique`、`FeeCalculation_org_claimitem_active_unique`。

**CHECK（M1）**：身份二选一（Snapshot / Adjustment）、hash 与 fingerprint 64hex 形状、`identityVersion='v1'`、`fingerprintVersion='sfp-v1'`、`amount > 0`、`currency ~ '^[A-Z]{3}$'`、evidence ≥ 1、`snapshotDigest ~ '^[0-9a-f]{64}$'`、membership `settlementId` / `adjustmentId` 二选一 + 符号一致、`FeeCalculationAdjustment` REVERSAL 必须带 trigger 列表。

**租户保护（M2）**：4 新表各自 `cc_tenant_<table>`（tgtype 23）+ `cc_tenant_immutable__<Table>`（tgtype 19）；11 个 FK 租户守卫（Settlement→ClaimItem / ReceiptSnapshot、FeeCalculation→ClaimItem / 自引用 ×2、Snapshot→ClaimItem、Adjustment→Settlement、Membership→Fee / Settlement / Adjustment、FeeAdjustment→Fee）。

**append-only / 不变量（M3 + M4）**：4 表 append-only（tgtype 27）+ 5 个资金域不变量触发器（`cc_settlement_receipt_basis_immutable`、`cc_settlementadjustment_full_reversal_guard`、`cc_feecalculationsettlement_chain_unique`、`cc_feecalculationadjustment_void_amount`，以及 Settlement 到账依据守卫同函数）。

---

## 6. Trigger inventories 证据

```text
NOTICE:  OK: required tenant triggers=71 baseline, 53 immutable per contains-organizationId table, 2 scoped
NOTICE:  OK: append-only/controlled-mutation triggers=20 (checklist)
```

---

## 7. Fresh deploy 证据

- 临时库 `cc_s1_check`（throwaway）→ `prisma migrate deploy` **4 个新迁移全部应用成功**；
- 租户触发器清单 SQL → OK（71 baseline / 53 immutable / 2 scoped）；
- append-only 清单 SQL → OK（20 条）；
- 验证结束已删除临时库（`DROP DATABASE`）。

## 8. Two-stage upgrade 证据

`CC_PSQL_CMD="docker exec -i crossclaim-postgres psql -U crossclaim" node tools/upgrade-verify/two-stage-upgrade.mjs`：

```text
TWO_STAGE_UPGRADE_OK db=cc_upgrade_4c840000 preB2Migrations=37
  OK stage 1: pre-B2 migrations + synthetic legacy data (Case/Claim/RuleEvaluation = 1/1/2)
  OK stage 2: B2 migration 保留数据 + 关系完整
  OK stage 2: organizationId-immutability triggers installed per table :: immutable=53
  OK stage 2: checklist SQL（租户 + append-only）both OK
  OK stage 2: reconciliation consistency checker OK
  OK stage 2: recovery manual submission consistency checker OK
  OK stage 2: post-upgrade guards actually reject illegal writes
  OK stage 2: second migrate deploy is a no-op（幂等）
cleanup: dropped cc_upgrade_4c840000
```

## 9. Architecture contract 证据

- `prisma validate` → valid；`prisma format` → 已规范化；
- `tsc --noEmit` → **0 error**；
- `architecture-contract.test.ts` → **140/140 PASS**（模型总数 55 = 49 core + 6 join；新增 R46 S1 资金域断言，含「不存在全局 settlementId 唯一锁死」反向断言）；
- 全量回归 → **176 files / 1751 tests PASS**（R45 冻结基线 1730 之上为新增断言，无删除 / skip / 弱化）；
- `DOMAIN_MODEL.md` 同步（55 = 49 + 6，并新增 R46 段落）。

## 10. 零资金行为证明

1. 本批次**未新增或修改任何 `apps/api/src` 业务代码**（仅测试文件 + schema + migration + 清单 + 文档）；
2. 架构契约断言：R46 S1 的 4 个迁移中**不存在** `INSERT INTO "Settlement" | "FeeCalculation" | "BillingInvoice" | "RecoveryLedgerEntry" | "Payment"`；
3. 断言：R46 S1 迁移**未** `ALTER TABLE "BillingInvoice"` / `ALTER TYPE "BillingStatus"`；
4. migration 仅做 DDL + 触发器，无数据播种（two-stage upgrade 中播种的是既有 B2 验证夹具数据）。

## 11. 永久验收承接（S1 部分）

| 验收 | 状态 |
| --- | --- |
| Settlement 创建后修改 `receiptSnapshotId` → DB 拒绝 | S1 已落地并测试 |
| ReceiptSnapshot digest / version UPDATE → 拒绝 | S1 已落地并测试 |
| 同一 Settlement 在同一 fee calculation 内重复 membership → 拒绝 | S1 已落地（partial unique） |
| 两个无关 active fee chains 同时消费同一 Settlement → fail-closed | S1 已落地（chain 触发器 + claimItem active 唯一） |
| full reversal 第二个不同事件 → 拒绝 | S1 已落地（唯一约束） |
| 冲回后原 Settlement 完整存在 | S1 已落地（append-only + 依据不可变） |
| cross-tenant Claim / Settlement / Snapshot / Evidence → DB 拒绝 | S1 已落地（租户守卫触发器） |
| legacy reversal 可读、新写不触碰 `reversedBySettlementId` | Schema 层成立（服务层断言在 S3） |

## 12. 风险与边界

- 本批次仅 Schema / 触发器 / 清单 / 测试；**未开放任何资金写入路径**；
- `prisma format` 对 `schema.prisma` 做了整体规范化（含既有段落对齐），语义未变；
- 剩余风险（legacy 双表示矛盾、adjustment 后的 Fee 处理、snapshot 漂移、重复计费）分别在 S3 / S4 / S6 以服务层 + checker 收口。

## 13. 请裁决（编号）

1. §2 fee-chain identity / uniqueness 最终方案（含「明确不采用全局 `settlementId` 唯一」）是否满足 MSG-54 CHANGE A / F3 修正？
2. §3 Settlement ↔ Snapshot 不可漂移与 §4 full-reversal 0/1 等额语义是否满足 CHANGE B / B1？
3. §5–§6 约束 / 触发器 / 清单（71 baseline + 20 append-only）是否满足 CHANGE F 四项数据库级不变量？
4. §7–§10 证据（fresh deploy / two-stage upgrade / architecture contract / 零资金行为）是否满足 MSG-54 对 S1 的送审报告要求？是否批准进入 **R46 S2（receipt snapshot + Settlement ingest / record，受保护写路径）**？

> 边界（重申）：NO automatic Settlement from R45 · NO automatic Fee · NO automatic Invoice issuance · NO Payment activation · NO autopay · NO platform write · TRANSPORT=false · NO production credentials；R13 Payment Activation Gate = HOLD。
