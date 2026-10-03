-- CUSTOMS GAP G4 / Q2 Schema Delta 第二批（MSG-20261003-127 Q2 APPROVED WITH CHANGES）
-- 四个 append-only 计算投影：latest 由 ORDER BY computedAt DESC / view 推导，禁止 UPDATE 覆盖历史。
CREATE OR REPLACE FUNCTION cc_customs_projection_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CUSTOMS_PROJECTION_APPEND_ONLY: % is not allowed on append-only computation projections', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE "CustomsDutyTruthRecord" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "inputFactId" TEXT NOT NULL,
  "inputDigest" TEXT NOT NULL,
  "algorithmVersion" TEXT NOT NULL,
  "resultDigest" TEXT NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomsDutyTruthRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsDutyTruthRecord_input_digest_shape" CHECK ("inputDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CustomsDutyTruthRecord_result_digest_shape" CHECK ("resultDigest" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "CustomsDutyTruthRecord_organizationId_inputFactId_computedAt_idx" ON "CustomsDutyTruthRecord"("organizationId", "inputFactId", "computedAt");
ALTER TABLE "CustomsDutyTruthRecord" ADD CONSTRAINT "CustomsDutyTruthRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomsDutyTruthRecord" ADD CONSTRAINT "CustomsDutyTruthRecord_inputFactId_fkey" FOREIGN KEY ("inputFactId") REFERENCES "CustomsEntryFactRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TRIGGER IF EXISTS cc_tenant_customsdutytruthrecord ON "CustomsDutyTruthRecord";
CREATE TRIGGER cc_tenant_customsdutytruthrecord
  BEFORE INSERT OR UPDATE ON "CustomsDutyTruthRecord"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('inputFactId', 'CustomsEntryFactRecord');
DROP TRIGGER IF EXISTS "cc_tenant_immutable__CustomsDutyTruthRecord" ON "CustomsDutyTruthRecord";
CREATE TRIGGER "cc_tenant_immutable__CustomsDutyTruthRecord"
  BEFORE UPDATE ON "CustomsDutyTruthRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();
DROP TRIGGER IF EXISTS "cc_append_only__CustomsDutyTruthRecord" ON "CustomsDutyTruthRecord";
CREATE TRIGGER "cc_append_only__CustomsDutyTruthRecord"
  BEFORE UPDATE OR DELETE ON "CustomsDutyTruthRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_customs_projection_append_only();

CREATE TABLE "CustomsDiscrepancyRecord" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "inputFactId" TEXT NOT NULL,
  "inputDigest" TEXT NOT NULL,
  "algorithmVersion" TEXT NOT NULL,
  "resultDigest" TEXT NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomsDiscrepancyRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsDiscrepancyRecord_input_digest_shape" CHECK ("inputDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CustomsDiscrepancyRecord_result_digest_shape" CHECK ("resultDigest" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "CustomsDiscrepancyRecord_organizationId_inputFactId_computedAt_idx" ON "CustomsDiscrepancyRecord"("organizationId", "inputFactId", "computedAt");
ALTER TABLE "CustomsDiscrepancyRecord" ADD CONSTRAINT "CustomsDiscrepancyRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomsDiscrepancyRecord" ADD CONSTRAINT "CustomsDiscrepancyRecord_inputFactId_fkey" FOREIGN KEY ("inputFactId") REFERENCES "CustomsEntryFactRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TRIGGER IF EXISTS cc_tenant_customsdiscrepancyrecord ON "CustomsDiscrepancyRecord";
CREATE TRIGGER cc_tenant_customsdiscrepancyrecord
  BEFORE INSERT OR UPDATE ON "CustomsDiscrepancyRecord"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('inputFactId', 'CustomsEntryFactRecord');
DROP TRIGGER IF EXISTS "cc_tenant_immutable__CustomsDiscrepancyRecord" ON "CustomsDiscrepancyRecord";
CREATE TRIGGER "cc_tenant_immutable__CustomsDiscrepancyRecord"
  BEFORE UPDATE ON "CustomsDiscrepancyRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();
DROP TRIGGER IF EXISTS "cc_append_only__CustomsDiscrepancyRecord" ON "CustomsDiscrepancyRecord";
CREATE TRIGGER "cc_append_only__CustomsDiscrepancyRecord"
  BEFORE UPDATE OR DELETE ON "CustomsDiscrepancyRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_customs_projection_append_only();

CREATE TABLE "CustomsEligibilityRecord" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "inputFactId" TEXT NOT NULL,
  "inputDigest" TEXT NOT NULL,
  "algorithmVersion" TEXT NOT NULL,
  "resultDigest" TEXT NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  "policyId" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomsEligibilityRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsEligibilityRecord_input_digest_shape" CHECK ("inputDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CustomsEligibilityRecord_result_digest_shape" CHECK ("resultDigest" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "CustomsEligibilityRecord_organizationId_inputFactId_computedAt_idx" ON "CustomsEligibilityRecord"("organizationId", "inputFactId", "computedAt");
ALTER TABLE "CustomsEligibilityRecord" ADD CONSTRAINT "CustomsEligibilityRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomsEligibilityRecord" ADD CONSTRAINT "CustomsEligibilityRecord_inputFactId_fkey" FOREIGN KEY ("inputFactId") REFERENCES "CustomsEntryFactRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TRIGGER IF EXISTS cc_tenant_customseligibilityrecord ON "CustomsEligibilityRecord";
CREATE TRIGGER cc_tenant_customseligibilityrecord
  BEFORE INSERT OR UPDATE ON "CustomsEligibilityRecord"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('inputFactId', 'CustomsEntryFactRecord');
DROP TRIGGER IF EXISTS "cc_tenant_immutable__CustomsEligibilityRecord" ON "CustomsEligibilityRecord";
CREATE TRIGGER "cc_tenant_immutable__CustomsEligibilityRecord"
  BEFORE UPDATE ON "CustomsEligibilityRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();
DROP TRIGGER IF EXISTS "cc_append_only__CustomsEligibilityRecord" ON "CustomsEligibilityRecord";
CREATE TRIGGER "cc_append_only__CustomsEligibilityRecord"
  BEFORE UPDATE OR DELETE ON "CustomsEligibilityRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_customs_projection_append_only();

CREATE TABLE "CustomsRecoveryEstimateRecord" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "inputFactId" TEXT NOT NULL,
  "inputDigest" TEXT NOT NULL,
  "algorithmVersion" TEXT NOT NULL,
  "resultDigest" TEXT NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  "policyId" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomsRecoveryEstimateRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsRecoveryEstimateRecord_input_digest_shape" CHECK ("inputDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CustomsRecoveryEstimateRecord_result_digest_shape" CHECK ("resultDigest" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "CustomsRecoveryEstimateRecord_organizationId_inputFactId_computedAt_idx" ON "CustomsRecoveryEstimateRecord"("organizationId", "inputFactId", "computedAt");
ALTER TABLE "CustomsRecoveryEstimateRecord" ADD CONSTRAINT "CustomsRecoveryEstimateRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomsRecoveryEstimateRecord" ADD CONSTRAINT "CustomsRecoveryEstimateRecord_inputFactId_fkey" FOREIGN KEY ("inputFactId") REFERENCES "CustomsEntryFactRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TRIGGER IF EXISTS cc_tenant_customsrecoveryestimaterecord ON "CustomsRecoveryEstimateRecord";
CREATE TRIGGER cc_tenant_customsrecoveryestimaterecord
  BEFORE INSERT OR UPDATE ON "CustomsRecoveryEstimateRecord"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('inputFactId', 'CustomsEntryFactRecord');
DROP TRIGGER IF EXISTS "cc_tenant_immutable__CustomsRecoveryEstimateRecord" ON "CustomsRecoveryEstimateRecord";
CREATE TRIGGER "cc_tenant_immutable__CustomsRecoveryEstimateRecord"
  BEFORE UPDATE ON "CustomsRecoveryEstimateRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();
DROP TRIGGER IF EXISTS "cc_append_only__CustomsRecoveryEstimateRecord" ON "CustomsRecoveryEstimateRecord";
CREATE TRIGGER "cc_append_only__CustomsRecoveryEstimateRecord"
  BEFORE UPDATE OR DELETE ON "CustomsRecoveryEstimateRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_customs_projection_append_only();

-- 迁移不使用 DISABLE TRIGGER；不写任何凭据 / 资金字段。
