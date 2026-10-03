-- P0-1 收尾：Return→matching→evidence→qualification→claim-ready evidence 结果（append-only）
CREATE TABLE "CustomsReturnClaimEvidenceRecord" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "entryFactId" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "algorithmVersion" TEXT NOT NULL,
  "inputDigest" TEXT NOT NULL,
  "resultDigest" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "qualificationStatus" TEXT NOT NULL,
  "confirmedRecoverableAmountByCurrency" JSONB NOT NULL,
  "eligibleQuantityByLine" JSONB NOT NULL,
  "reasonCodes" JSONB NOT NULL,
  "payload" JSONB NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomsReturnClaimEvidenceRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsReturnClaimEvidenceRecord_status_check" CHECK ("status" IN ('READY', 'NOT_READY', 'RECONCILIATION_REQUIRED')),
  CONSTRAINT "CustomsReturnClaimEvidenceRecord_qualification_status_check" CHECK ("qualificationStatus" IN ('QUALIFIED', 'CONDITIONAL', 'NOT_QUALIFIED', 'INDETERMINATE')),
  CONSTRAINT "CustomsReturnClaimEvidenceRecord_input_digest_shape" CHECK ("inputDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CustomsReturnClaimEvidenceRecord_result_digest_shape" CHECK ("resultDigest" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "CustomsReturnClaimEvidenceRecord_organizationId_entryFactId_computedAt_idx" ON "CustomsReturnClaimEvidenceRecord"("organizationId", "entryFactId", "computedAt");
ALTER TABLE "CustomsReturnClaimEvidenceRecord" ADD CONSTRAINT "CustomsReturnClaimEvidenceRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomsReturnClaimEvidenceRecord" ADD CONSTRAINT "CustomsReturnClaimEvidenceRecord_entryFactId_fkey" FOREIGN KEY ("entryFactId") REFERENCES "CustomsEntryFactRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TRIGGER IF EXISTS cc_tenant_customsreturnclaimevidencerecord ON "CustomsReturnClaimEvidenceRecord";
CREATE TRIGGER cc_tenant_customsreturnclaimevidencerecord
  BEFORE INSERT OR UPDATE ON "CustomsReturnClaimEvidenceRecord"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('entryFactId', 'CustomsEntryFactRecord');
DROP TRIGGER IF EXISTS "cc_tenant_immutable__CustomsReturnClaimEvidenceRecord" ON "CustomsReturnClaimEvidenceRecord";
CREATE TRIGGER "cc_tenant_immutable__CustomsReturnClaimEvidenceRecord"
  BEFORE UPDATE ON "CustomsReturnClaimEvidenceRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();
CREATE OR REPLACE FUNCTION cc_customs_return_claim_evidence_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CUSTOMS_RETURN_CLAIM_EVIDENCE_APPEND_ONLY: % is not allowed on append-only claim evidence', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "cc_append_only__CustomsReturnClaimEvidenceRecord" ON "CustomsReturnClaimEvidenceRecord";
CREATE TRIGGER "cc_append_only__CustomsReturnClaimEvidenceRecord"
  BEFORE UPDATE OR DELETE ON "CustomsReturnClaimEvidenceRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_customs_return_claim_evidence_append_only();
