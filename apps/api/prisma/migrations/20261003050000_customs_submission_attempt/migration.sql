-- ============================================================
-- C17（MSG-20261003-124 ③④⑤⑥⑪⑫）Customs submission ledger：
--   root = 执行身份 / 幂等根（immutable）；fact = append-only 状态事实。
-- 不变式：UNIQUE(organizationId, provider, operation, idempotencyKey)；
--         status = SUBMITTED → providerSubmissionId IS NOT NULL；
--         append-only（UPDATE/DELETE 拒绝）；tenant guard 沿用既有体系；
--         packageDigest ^[0-9a-f]{64}$；不存 credential / raw payload。
-- 边界：真实 filing 仍 HOLD_EXTERNAL / HOST APPROVAL REQUIRED。
-- ============================================================

CREATE TABLE "CustomsSubmissionAttempt" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "opportunityId" TEXT NOT NULL,
  "caseId" TEXT,
  "claimItemId" TEXT,
  "packageId" TEXT NOT NULL,
  "packageDigest" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "jurisdiction" TEXT NOT NULL,
  "remedyType" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomsSubmissionAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsSubmissionAttempt_package_digest_shape" CHECK ("packageDigest" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "CustomsSubmissionAttempt_org_provider_operation_key_key"
  ON "CustomsSubmissionAttempt" ("organizationId", "provider", "operation", "idempotencyKey");
CREATE INDEX "CustomsSubmissionAttempt_organizationId_opportunityId_idx"
  ON "CustomsSubmissionAttempt" ("organizationId", "opportunityId");

ALTER TABLE "CustomsSubmissionAttempt" ADD CONSTRAINT "CustomsSubmissionAttempt_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CustomsSubmissionAttemptFact" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "providerSubmissionId" TEXT,
  "source" TEXT NOT NULL,
  "verificationLevel" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL,
  "providerReference" TEXT,
  "errorCode" TEXT,
  "reconciliationAttempt" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomsSubmissionAttemptFact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsSubmissionAttemptFact_status_check" CHECK ("status" IN (
    'ATTEMPTED', 'UNKNOWN_PROVIDER_RESPONSE', 'RECONCILING', 'SUBMITTED', 'FAILED_CONFIRMED', 'MANUAL_REVIEW')),
  CONSTRAINT "CustomsSubmissionAttemptFact_source_check" CHECK ("source" IN (
    'PROVIDER_API', 'PROVIDER_WEBHOOK', 'PROVIDER_DOCUMENT', 'PROVIDER_PORTAL_ARTIFACT', 'MANUAL')),
  CONSTRAINT "CustomsSubmissionAttemptFact_verification_check" CHECK ("verificationLevel" IN (
    'UNVERIFIED', 'PROVIDER_VERIFIED')),
  -- ⑦ SUBMITTED 必须携带 provider submission id（不允许「已提交但无回执标识」）
  CONSTRAINT "CustomsSubmissionAttemptFact_submitted_requires_id_check"
    CHECK ("status" <> 'SUBMITTED' OR "providerSubmissionId" IS NOT NULL)
);

CREATE INDEX "CustomsSubmissionAttemptFact_organizationId_attemptId_observedAt_idx"
  ON "CustomsSubmissionAttemptFact" ("organizationId", "attemptId", "observedAt");

ALTER TABLE "CustomsSubmissionAttemptFact" ADD CONSTRAINT "CustomsSubmissionAttemptFact_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "CustomsSubmissionAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomsSubmissionAttemptFact" ADD CONSTRAINT "CustomsSubmissionAttemptFact_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- ⑪ 租户守卫 / 归属不可变 ----------
DROP TRIGGER IF EXISTS cc_tenant_customssubmissionattempt ON "CustomsSubmissionAttempt";
CREATE TRIGGER cc_tenant_customssubmissionattempt
  BEFORE INSERT OR UPDATE ON "CustomsSubmissionAttempt"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__CustomsSubmissionAttempt" ON "CustomsSubmissionAttempt";
CREATE TRIGGER "cc_tenant_immutable__CustomsSubmissionAttempt"
  BEFORE UPDATE ON "CustomsSubmissionAttempt"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS cc_tenant_customssubmissionattemptfact ON "CustomsSubmissionAttemptFact";
CREATE TRIGGER cc_tenant_customssubmissionattemptfact
  BEFORE INSERT OR UPDATE ON "CustomsSubmissionAttemptFact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('attemptId', 'CustomsSubmissionAttempt');

DROP TRIGGER IF EXISTS "cc_tenant_immutable__CustomsSubmissionAttemptFact" ON "CustomsSubmissionAttemptFact";
CREATE TRIGGER "cc_tenant_immutable__CustomsSubmissionAttemptFact"
  BEFORE UPDATE ON "CustomsSubmissionAttemptFact"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- ---------- ④⑤⑥ append-only 状态事实 ----------
CREATE OR REPLACE FUNCTION cc_customs_submission_attempt_fact_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_TABLE: % rejects %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_append_only__CustomsSubmissionAttemptFact" ON "CustomsSubmissionAttemptFact";
CREATE TRIGGER "cc_append_only__CustomsSubmissionAttemptFact"
  BEFORE UPDATE OR DELETE ON "CustomsSubmissionAttemptFact"
  FOR EACH ROW EXECUTE FUNCTION cc_customs_submission_attempt_fact_append_only();

-- 迁移不使用 DISABLE TRIGGER；不写任何凭据 / 资金字段。
