-- P0-2：Customer Qualification / Recovery Economics 判定投影（append-only）
CREATE TABLE "RecoveryQualificationAssessmentRecord" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "platformAccountId" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "algorithmVersion" TEXT NOT NULL,
  "inputDigest" TEXT NOT NULL,
  "resultDigest" TEXT NOT NULL,
  "qualificationStatus" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "estimatedRecoveryAmount" DECIMAL(38,6) NOT NULL,
  "estimatedExternalApiCost" DECIMAL(38,6) NOT NULL,
  "estimatedBrokerCost" DECIMAL(38,6) NOT NULL,
  "expectedNetRecovery" DECIMAL(38,6) NOT NULL,
  "costRatio" DECIMAL(38,6),
  "payload" JSONB NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecoveryQualificationAssessmentRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RecoveryQualificationAssessmentRecord_status_check" CHECK ("qualificationStatus" IN ('QUALIFIED', 'CONDITIONAL', 'NOT_QUALIFIED', 'INDETERMINATE')),
  CONSTRAINT "RecoveryQualificationAssessmentRecord_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "RecoveryQualificationAssessmentRecord_input_digest_shape" CHECK ("inputDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "RecoveryQualificationAssessmentRecord_result_digest_shape" CHECK ("resultDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "RecoveryQualificationAssessmentRecord_non_negative_costs_check" CHECK ("estimatedRecoveryAmount" >= 0 AND "estimatedExternalApiCost" >= 0 AND "estimatedBrokerCost" >= 0)
);
CREATE INDEX "RecoveryQualificationAssessmentRecord_organizationId_platformAccountId_computedAt_idx" ON "RecoveryQualificationAssessmentRecord"("organizationId", "platformAccountId", "computedAt");
CREATE INDEX "RecoveryQualificationAssessmentRecord_organizationId_inputDigest_idx" ON "RecoveryQualificationAssessmentRecord"("organizationId", "inputDigest");
ALTER TABLE "RecoveryQualificationAssessmentRecord" ADD CONSTRAINT "RecoveryQualificationAssessmentRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TRIGGER IF EXISTS cc_tenant_recoveryqualificationassessmentrecord ON "RecoveryQualificationAssessmentRecord";
CREATE TRIGGER cc_tenant_recoveryqualificationassessmentrecord
  BEFORE INSERT OR UPDATE ON "RecoveryQualificationAssessmentRecord"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();
DROP TRIGGER IF EXISTS "cc_tenant_immutable__RecoveryQualificationAssessmentRecord" ON "RecoveryQualificationAssessmentRecord";
CREATE TRIGGER "cc_tenant_immutable__RecoveryQualificationAssessmentRecord"
  BEFORE UPDATE ON "RecoveryQualificationAssessmentRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();
CREATE OR REPLACE FUNCTION cc_recovery_qualification_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'RECOVERY_QUALIFICATION_APPEND_ONLY: % is not allowed on append-only qualification assessments', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "cc_append_only__RecoveryQualificationAssessmentRecord" ON "RecoveryQualificationAssessmentRecord";
CREATE TRIGGER "cc_append_only__RecoveryQualificationAssessmentRecord"
  BEFORE UPDATE OR DELETE ON "RecoveryQualificationAssessmentRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_recovery_qualification_append_only();
