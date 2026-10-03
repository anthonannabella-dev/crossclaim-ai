-- ============================================================
-- CrossClaim — R43 Implementation S1 / M5
-- 约束收口：digest / sha256 格式 与 provider reference canonical 形态
-- ------------------------------------------------------------
-- 依据：MSG-20261001-31 CHANGE C（canonical value）+ MSG-20261001-32 CHANGE C
--   （approval basis 版本化绑定依赖 digest/version 可信；格式在 DB 层收口）
-- 说明：纯新增 CHECK 约束；表为空表，无数据回填风险。
-- ============================================================

-- digest：64 位小写 hex（与 sourceFingerprint / snapshotDigest 同口径）
ALTER TABLE "RecoveryPackage"
  ADD CONSTRAINT "RecoveryPackage_packageDigest_hex64"
  CHECK ("packageDigest" ~ '^[0-9a-f]{64}$');

ALTER TABLE "RecoveryManualSubmission"
  ADD CONSTRAINT "RecoveryManualSubmission_packageDigest_hex64"
  CHECK ("packageDigest" ~ '^[0-9a-f]{64}$');

ALTER TABLE "RecoveryPackageArtifact"
  ADD CONSTRAINT "RecoveryPackageArtifact_sha256_hex64"
  CHECK ("sha256" ~ '^[0-9a-f]{64}$');

-- canonical provider reference：
--   * 非空且已 trim（首尾无空白）
--   * 已 NFKC 规范（Postgres 13+ normalize()）
--   * 内部空白已折叠（不存在连续两个空格）
--   * **不做大小写折叠**（Amazon 语义未证明前不得 lower-case）——因此不加 case 约束
ALTER TABLE "RecoveryManualSubmissionReference"
  ADD CONSTRAINT "RecoveryManualSubmissionReference_canonical_shape"
  CHECK (
    char_length("providerCaseRefCanonical") > 0
    AND "providerCaseRefCanonical" = btrim("providerCaseRefCanonical")
    AND "providerCaseRefCanonical" = normalize("providerCaseRefCanonical", NFKC)
    AND "providerCaseRefCanonical" NOT LIKE '%  %'
  );

-- 回滚（人工）：ALTER TABLE <表> DROP CONSTRAINT <约束名>;
