# G9 — DB 约束覆盖扫描（MASTER GAP CLOSURE）

- 扫描方式：枚举 `String` 列（status / state / kind / type / level / mode / source / currency）并检查迁移 SQL 是否包含 CHECK。
- 扫描结果：27 个候选（其中 currency 形状类 4 个、枚举状态类其余）。

## 本批已补（migration `20261003120000_currency_shape_checks`）

- `ReimbursementFact.currency` / `ExpectedRecoveryBasis.currency` / `ClaimReconciliationProjection.currency` → `CHECK ("currency" ~ '^[A-Z]{3}$')`。
- 事实层与四个计算投影（Q2）已自带 CHECK（source / jurisdiction / kind / currency / digest 形状 / lineOrdinal / amount range）+ tenant / immutable / append-only 触发器。

## 待逐个核对的枚举候选（需先确认允许值集合再补 CHECK）

- `PaymentProcessingAttempt.resultStatus` / `actorType`；`PlatformWriteAttempt.reconciledStatus`；
- `CarrierManualSubmission.carrierConfirmationStatus` / `submissionMode`；`CustomsSubmissionAttempt.remedyType`；
- `ClaimItem.claimType` / `platformType`；`RecoveryOpportunity.opportunityType`；`ProviderOutcomeFact.sourceRef`；`RecoveryPayout.sourceType`。

## 守卫

- `apps/api/src/__tests__/db-constraint-coverage.test.ts`：静态断言关键 CHECK 与 append-only 触发器存在，且投影表不存在 UPDATE 语句（防止「latest 覆盖」式回归）。

## 收口结论（G9 第三单元后）

- 已补：`RecoveryPayout.sourceType`（代码内闭合枚举 `PAYOUT_SOURCE_TYPES`）→ `CHECK ("sourceType" IN ('PLATFORM_SETTLEMENT', 'BANK_TRANSFER', 'OTHER'))`。
- 判定为**非缺口**（外部/平台提供的动态字符串，无闭合值集合，DB 枚举 CHECK 不适用）：`ClaimItem.claimType` / `ClaimItem.platformType`、`RecoveryOpportunity.opportunityType`、`ExpectedRecoveryBasis.basisSource`、`PaymentProcessingAttempt.resultStatus`、`AuditLog.entityType`、`PaymentEvent.eventType`、`SourceTransaction.referenceType`、`CanonicalFact.referenceType`、`ProviderOutcomeFact.sourceRef`、`ReimbursementFact.sourceRef`、`FileAsset.mimeType` 等——保留形状/非空约束 + 应用层校验。
- 守卫断言现为 **21** 项（`db-constraint-coverage`）。
