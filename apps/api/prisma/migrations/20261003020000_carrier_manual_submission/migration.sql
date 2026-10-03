-- ============================================================
-- CrossClaim — CARRIER QUEUE #9B FINAL（MSG-20261003-119 ⑲–㉜）
-- ------------------------------------------------------------
-- 人工提交事实（human attestation）：只记录「用户声称自己已完成人工提交」。
-- 不变量：
--   1) 逻辑幂等 identity = (organizationId, packageId) → UNIQUE 强制；
--   2) 租户归属不可变（cc_tenant_immutable__CarrierManualSubmission）；
--   3) append-only：创建后不得 UPDATE / DELETE（更正走未来 amendment 事实）；
--   4) 无 carrier confirmation 字段：carrierConfirmationStatus 只能是 NOT_VERIFIED。
-- 不存 credential / access token / raw claim payload / raw package payload / carrier secret。
-- 边界：不改 Payment；不启用 autopay / collection；R13 HOLD；TRANSPORT=false。
-- ============================================================

CREATE TABLE "CarrierManualSubmission" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "bundleId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalAccountId" TEXT NOT NULL,
  "trackingNumber" TEXT NOT NULL,
  "submittedByUserId" TEXT NOT NULL,
  "submittedAt" TIMESTAMP(3) NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL,
  "reportedCarrierSubmissionAt" TIMESTAMP(3),
  "carrierReference" TEXT,
  "carrierReferenceProvenance" TEXT,
  "note" TEXT,
  "carrierConfirmationStatus" TEXT NOT NULL,
  "submissionMode" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "eligibilityRuleSetId" TEXT NOT NULL,
  "eligibilityRuleSetVersion" TEXT NOT NULL,
  "estimateRuleSetId" TEXT NOT NULL,
  "estimateRuleSetVersion" TEXT NOT NULL,
  "packageSnapshotReference" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CarrierManualSubmission_pkey" PRIMARY KEY ("id")
);

-- ⑳ 逻辑幂等 identity：数据库必须真正强制（不能只靠 find-then-create）。
CREATE UNIQUE INDEX "CarrierManualSubmission_organizationId_packageId_key"
  ON "CarrierManualSubmission" ("organizationId", "packageId");
CREATE INDEX "CarrierManualSubmission_organizationId_submittedAt_idx"
  ON "CarrierManualSubmission" ("organizationId", "submittedAt");
CREATE INDEX "CarrierManualSubmission_organizationId_trackingNumber_idx"
  ON "CarrierManualSubmission" ("organizationId", "trackingNumber");

ALTER TABLE "CarrierManualSubmission" ADD CONSTRAINT "CarrierManualSubmission_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CarrierManualSubmission" ADD CONSTRAINT "CarrierManualSubmission_submittedByUserId_fkey"
  FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- 租户守卫 / 归属不可变 ----------
DROP TRIGGER IF EXISTS cc_tenant_carriermanualsubmission ON "CarrierManualSubmission";
CREATE TRIGGER cc_tenant_carriermanualsubmission
  BEFORE INSERT OR UPDATE ON "CarrierManualSubmission"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__CarrierManualSubmission" ON "CarrierManualSubmission";
CREATE TRIGGER "cc_tenant_immutable__CarrierManualSubmission"
  BEFORE UPDATE ON "CarrierManualSubmission"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- ---------- ㉜ append-only：核心提交事实创建后不可改 ----------
CREATE OR REPLACE FUNCTION cc_carrier_manual_submission_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_TABLE: % rejects %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_append_only__CarrierManualSubmission" ON "CarrierManualSubmission";
CREATE TRIGGER "cc_append_only__CarrierManualSubmission"
  BEFORE UPDATE OR DELETE ON "CarrierManualSubmission"
  FOR EACH ROW EXECUTE FUNCTION cc_carrier_manual_submission_append_only();

-- 迁移不使用任何 DISABLE TRIGGER；不写任何凭据 / 资金字段。
