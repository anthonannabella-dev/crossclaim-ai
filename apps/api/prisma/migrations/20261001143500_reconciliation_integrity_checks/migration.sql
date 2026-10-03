-- ============================================================
-- CrossClaim — R45 S1 / M5
-- 完整性收口：CHECK（语义 / 格式）+ reversal 同源性守卫 + projection generation 一致性
-- ------------------------------------------------------------
-- 依据：MSG-20261001-45 CHANGE A/B + MSG-20261001-46 Q1 / CHANGE A / CHANGE B
--   * OBSERVED.amount > 0；REIMBURSEMENT_REVERSED **不携带独立金额语义**（amount IS NULL）；
--   * reversesFactId 不得自指；kind 与 reversesFactId 必须一致；
--   * 冲正只能指向同租户 / 同 provider / 同 currency 的 OBSERVED 事实（跨租户由 M2 触发器拒绝）；
--   * providerEventFingerprint 64 hex + fingerprintVersion = 'v1'；
--   * 人工录入（MANUAL_WITH_EVIDENCE）必须带 ≥1 证据引用；
--   * ProjectionFact 的 projectionVersion 必须等于当前 projection generation（立即 + 提交时双重校验）。
-- 说明：表为空表，无数据回填风险。
-- ============================================================

-- ---------- CHECK ----------
ALTER TABLE "ProviderOutcomeFact"
  ADD CONSTRAINT "ProviderOutcomeFact_fingerprint_hex64"
  CHECK ("providerEventFingerprint" ~ '^[0-9a-f]{64}$');

ALTER TABLE "ProviderOutcomeFact"
  ADD CONSTRAINT "ProviderOutcomeFact_fingerprint_version_v1"
  CHECK ("fingerprintVersion" = 'v1');

ALTER TABLE "ProviderOutcomeFact"
  ADD CONSTRAINT "ProviderOutcomeFact_manual_requires_evidence"
  CHECK (
    "sourceKind" <> 'MANUAL_WITH_EVIDENCE'
    OR (cardinality("evidenceArtifactIds") >= 1 AND "reasonCode" IS NOT NULL)
  );

ALTER TABLE "ReimbursementFact"
  ADD CONSTRAINT "ReimbursementFact_fingerprint_hex64"
  CHECK ("providerEventFingerprint" ~ '^[0-9a-f]{64}$');

ALTER TABLE "ReimbursementFact"
  ADD CONSTRAINT "ReimbursementFact_fingerprint_version_v1"
  CHECK ("fingerprintVersion" = 'v1');

ALTER TABLE "ReimbursementFact"
  ADD CONSTRAINT "ReimbursementFact_currency_iso4217"
  CHECK ("currency" ~ '^[A-Z]{3}$');

-- CHANGE A：OBSERVED 必须 amount > 0；冲正行不携带独立金额语义
ALTER TABLE "ReimbursementFact"
  ADD CONSTRAINT "ReimbursementFact_amount_semantics"
  CHECK (
    ("kind" = 'OBSERVED' AND "amount" IS NOT NULL AND "amount" > 0)
    OR ("kind" = 'REIMBURSEMENT_REVERSED' AND "amount" IS NULL)
  );

-- CHANGE A：冲正不得自指；kind 与 reversesFactId 必须一致（v1 仅 full reversal）
ALTER TABLE "ReimbursementFact"
  ADD CONSTRAINT "ReimbursementFact_reversal_shape"
  CHECK (
    ("kind" = 'OBSERVED' AND "reversesFactId" IS NULL)
    OR ("kind" = 'REIMBURSEMENT_REVERSED' AND "reversesFactId" IS NOT NULL AND "reversesFactId" <> "id")
  );

ALTER TABLE "ReimbursementFact"
  ADD CONSTRAINT "ReimbursementFact_manual_requires_evidence"
  CHECK (
    "sourceKind" <> 'MANUAL_WITH_EVIDENCE'
    OR (cardinality("evidenceArtifactIds") >= 1 AND "reasonCode" IS NOT NULL)
  );

ALTER TABLE "ExpectedRecoveryBasis"
  ADD CONSTRAINT "ExpectedRecoveryBasis_amount_positive"
  CHECK ("expectedRecoveryAmount" > 0);

ALTER TABLE "ExpectedRecoveryBasis"
  ADD CONSTRAINT "ExpectedRecoveryBasis_currency_iso4217"
  CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "ExpectedRecoveryBasis"
  ADD CONSTRAINT "ExpectedRecoveryBasis_supersede_pair"
  CHECK (("supersededAt" IS NULL AND "supersededByBasisId" IS NULL) OR ("supersededAt" IS NOT NULL));

ALTER TABLE "ReconciliationOverrideDecision"
  ADD CONSTRAINT "ReconciliationOverrideDecision_reason_required"
  CHECK (char_length(btrim("reasonCode")) > 0 AND char_length(btrim("reasonText")) > 0);

ALTER TABLE "ClaimReconciliationProjection"
  ADD CONSTRAINT "ClaimReconciliationProjection_input_digest_hex64"
  CHECK ("inputDigest" ~ '^[0-9a-f]{64}$');

ALTER TABLE "ClaimReconciliationProjection"
  ADD CONSTRAINT "ClaimReconciliationProjection_currency_iso4217"
  CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$');

ALTER TABLE "ClaimReconciliationProjection"
  ADD CONSTRAINT "ClaimReconciliationProjection_net_non_negative"
  CHECK ("netMatchedObservedAmount" >= 0);

ALTER TABLE "ClaimReconciliationProjection"
  ADD CONSTRAINT "ClaimReconciliationProjection_version_positive"
  CHECK ("projectionVersion" >= 1);

ALTER TABLE "ReconciliationTolerancePolicy"
  ADD CONSTRAINT "ReconciliationTolerancePolicy_tolerance_non_negative"
  CHECK ("absoluteTolerance" >= 0 AND "relativeTolerance" >= 0 AND "relativeTolerance" <= 1);

-- ---------- CHANGE B：reversal 同源性守卫（同租户 / 同 provider / 同 currency / 目标为 OBSERVED） ----------
CREATE OR REPLACE FUNCTION cc_reimbursementfact_reversal_guard() RETURNS trigger AS $$
DECLARE
  target_kind     "ReimbursementFactKind";
  target_org      text;
  target_provider text;
  target_currency text;
BEGIN
  IF NEW."kind" <> 'REIMBURSEMENT_REVERSED' THEN
    RETURN NEW;
  END IF;

  SELECT "kind", "organizationId", "provider", "currency"
    INTO target_kind, target_org, target_provider, target_currency
    FROM "ReimbursementFact"
   WHERE "id" = NEW."reversesFactId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVERSAL_TARGET_NOT_FOUND: %', NEW."reversesFactId"
      USING ERRCODE = '23514';
  END IF;

  IF target_kind <> 'OBSERVED' THEN
    RAISE EXCEPTION 'REVERSAL_TARGET_NOT_OBSERVED: %', NEW."reversesFactId"
      USING ERRCODE = '23514';
  END IF;

  IF target_org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'REVERSAL_CROSS_TENANT: %', NEW."reversesFactId"
      USING ERRCODE = '23514';
  END IF;

  IF target_provider <> NEW."provider" THEN
    RAISE EXCEPTION 'REVERSAL_PROVIDER_MISMATCH: % -> %', NEW."provider", target_provider
      USING ERRCODE = '23514';
  END IF;

  IF target_currency <> NEW."currency" THEN
    RAISE EXCEPTION 'REVERSAL_CURRENCY_MISMATCH: % -> %', NEW."currency", target_currency
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_reimbursementfact_reversal_guard ON "ReimbursementFact";
CREATE TRIGGER cc_reimbursementfact_reversal_guard
  BEFORE INSERT ON "ReimbursementFact"
  FOR EACH ROW EXECUTE FUNCTION cc_reimbursementfact_reversal_guard();

-- ---------- CHANGE A：ProjectionFact 必须属于当前 projection generation ----------
-- 纯立即校验（无 deferred 约束触发器）：MEMBERSHIP 插入必须匹配当前 header 版本；
-- 「提升版本却不替换成员」由 M2 的 cc_reconciliationprojection_guard_mutation 立即拒绝。
-- 说明（实测证据）：Prisma 客户端在 COMMIT 阶段的 deferred 约束错误会表现为**静默回滚**
--   （调用方收不到异常，事务被丢弃），因此本域一律使用立即判定，避免不可观测的失败。
CREATE OR REPLACE FUNCTION cc_reconciliationprojectionfact_assert_current_generation() RETURNS trigger AS $$
DECLARE
  current_version integer;
BEGIN
  SELECT "projectionVersion" INTO current_version
    FROM "ClaimReconciliationProjection"
   WHERE "id" = NEW."projectionId";

  IF current_version IS NULL THEN
    RAISE EXCEPTION 'PROJECTION_FACT_ORPHAN: %', NEW."projectionId"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."projectionVersion" <> current_version THEN
    RAISE EXCEPTION 'PROJECTION_FACT_STALE_GENERATION: % (fact=%, current=%)',
      NEW."projectionId", NEW."projectionVersion", current_version
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_reconciliationprojectionfact_version_match ON "ClaimReconciliationProjectionFact";
CREATE TRIGGER cc_reconciliationprojectionfact_version_match
  BEFORE INSERT ON "ClaimReconciliationProjectionFact"
  FOR EACH ROW EXECUTE FUNCTION cc_reconciliationprojectionfact_assert_current_generation();

-- 回滚（人工）：ALTER TABLE <表> DROP CONSTRAINT <约束名>; DROP TRIGGER IF EXISTS <name> ON <table>; DROP FUNCTION IF EXISTS <fn>();
