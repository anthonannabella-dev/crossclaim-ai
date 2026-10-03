-- G9（MASTER GAP CLOSURE）第二单元：可枚举/引用列的 DB 级约束
-- 1) platform-write 账本状态：与 services/platform-write/types.ts 的 PLATFORM_WRITE_STATUSES 对齐（nullable 保留）。
-- 2) 引用 / 类型列非空：空串在语义上永远非法（此前仅应用层保证）。
-- 不改语义、不迁移数据；对既有非法值 fail-closed。

ALTER TABLE "PlatformWriteAttempt"
  ADD CONSTRAINT "PlatformWriteAttempt_reconciledStatus_check"
  CHECK ("reconciledStatus" IS NULL OR "reconciledStatus" IN ('BLOCKED', 'NEEDS_MANUAL', 'SUCCEEDED', 'REPLAYED', 'RETRYABLE', 'FAILED', 'DEAD_LETTER'));

ALTER TABLE "PlatformWriteAttempt"
  ADD CONSTRAINT "PlatformWriteAttempt_targetKind_non_empty_check" CHECK (length("targetKind") > 0);
ALTER TABLE "FileAsset"
  ADD CONSTRAINT "FileAsset_sourceRef_non_empty_check" CHECK (length("sourceRef") > 0);
ALTER TABLE "ClaimItem"
  ADD CONSTRAINT "ClaimItem_sourceFingerprint_non_empty_check" CHECK (length("sourceFingerprint") > 0);
ALTER TABLE "ProviderOutcomeFact"
  ADD CONSTRAINT "ProviderOutcomeFact_sourceRef_non_empty_check" CHECK (length("sourceRef") > 0);
ALTER TABLE "ReimbursementFact"
  ADD CONSTRAINT "ReimbursementFact_sourceRef_non_empty_check" CHECK (length("sourceRef") > 0);

-- 其余枚举候选（ClaimItem.claimType/platformType、RecoveryOpportunity.opportunityType、RecoveryPayout.sourceType、
-- PaymentProcessingAttempt.resultStatus、ExpectedRecoveryBasis.basisSource 等）需确认允许值集合后再补，见 G9 扫描文档。
