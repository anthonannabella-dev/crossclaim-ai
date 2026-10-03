-- G9 续：引用 / 类型 / 状态列的形状约束（不猜枚举值；只禁止空串与非法 mime 形状）
-- 这些列的允许值来自外部平台 / 工件，故不做枚举 CHECK，改为形状与非空约束 + 应用层校验。

ALTER TABLE "FileAsset"
  ADD CONSTRAINT "FileAsset_mimeType_shape_check" CHECK ("mimeType" ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$');

ALTER TABLE "FileAsset"
  ADD CONSTRAINT "FileAsset_sourceRef_shape_check" CHECK (length("sourceRef") > 0);

ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_entityType_shape_check" CHECK (length("entityType") > 0);

ALTER TABLE "SourceTransaction"
  ADD CONSTRAINT "SourceTransaction_referenceType_shape_check" CHECK (length("referenceType") > 0);

ALTER TABLE "CanonicalFact"
  ADD CONSTRAINT "CanonicalFact_referenceType_shape_check" CHECK (length("referenceType") > 0);

ALTER TABLE "RecoveryOpportunity"
  ADD CONSTRAINT "RecoveryOpportunity_opportunityType_shape_check" CHECK (length("opportunityType") > 0);

ALTER TABLE "ClaimItem"
  ADD CONSTRAINT "ClaimItem_claimType_shape_check" CHECK (length("claimType") > 0);

ALTER TABLE "ClaimItem"
  ADD CONSTRAINT "ClaimItem_platformType_shape_check" CHECK (length("platformType") > 0);

ALTER TABLE "ExpectedRecoveryBasis"
  ADD CONSTRAINT "ExpectedRecoveryBasis_basisSource_shape_check" CHECK (length("basisSource") > 0);

ALTER TABLE "ProviderOutcomeFact"
  ADD CONSTRAINT "ProviderOutcomeFact_sourceRef_shape_check" CHECK (length("sourceRef") > 0);
