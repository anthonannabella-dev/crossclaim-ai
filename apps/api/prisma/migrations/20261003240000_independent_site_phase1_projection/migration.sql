-- CHANGE B（MSG-20261003-141）— Independent-site Phase 1 结果的只读投影（append-only）。
CREATE TABLE "IndependentSitePhase1Projection" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "disputeReference" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "algorithmVersion" TEXT NOT NULL,
  "qualificationStatus" TEXT NOT NULL,
  "qualificationReasonCodes" JSONB NOT NULL,
  "evidenceReadinessStatus" TEXT NOT NULL,
  "evidenceSummary" JSONB NOT NULL,
  "claimReadyStatus" TEXT NOT NULL,
  "packageId" TEXT,
  "packageDigest" TEXT,
  "externalWritePerformed" BOOLEAN NOT NULL DEFAULT false,
  "autoSubmitAllowed" BOOLEAN NOT NULL DEFAULT false,
  "resultDigest" TEXT NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IndependentSitePhase1Projection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IndependentSitePhase1Projection_digest_shape" CHECK ("resultDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "IndependentSitePhase1Projection_dispute_ref_shape" CHECK ("disputeReference" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "IndependentSitePhase1Projection_package_digest_shape" CHECK ("packageDigest" IS NULL OR "packageDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "IndependentSitePhase1Projection_qualification_status_check" CHECK ("qualificationStatus" IN ('QUALIFIED', 'CONDITIONAL', 'NOT_QUALIFIED', 'INDETERMINATE')),
  CONSTRAINT "IndependentSitePhase1Projection_evidence_status_check" CHECK ("evidenceReadinessStatus" IN ('READY', 'NOT_READY', 'INDETERMINATE')),
  CONSTRAINT "IndependentSitePhase1Projection_claim_ready_status_check" CHECK ("claimReadyStatus" IN ('READY', 'NOT_READY', 'INDETERMINATE')),
  -- 只读投影：不得表示任何外部执行或自动提交
  CONSTRAINT "IndependentSitePhase1Projection_no_external_write" CHECK ("externalWritePerformed" = false),
  CONSTRAINT "IndependentSitePhase1Projection_no_auto_submit" CHECK ("autoSubmitAllowed" = false),
  CONSTRAINT "IndependentSitePhase1Projection_reason_codes_array" CHECK (jsonb_typeof("qualificationReasonCodes") = 'array'),
  CONSTRAINT "IndependentSitePhase1Projection_evidence_summary_object" CHECK (jsonb_typeof("evidenceSummary") = 'object')
);
CREATE UNIQUE INDEX "IndependentSitePhase1Projection_org_dispute_digest_key" ON "IndependentSitePhase1Projection"("organizationId", "disputeReference", "resultDigest");
CREATE INDEX "IndependentSitePhase1Projection_org_dispute_computed_idx" ON "IndependentSitePhase1Projection"("organizationId", "disputeReference", "computedAt");
ALTER TABLE "IndependentSitePhase1Projection" ADD CONSTRAINT "IndependentSitePhase1Projection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TRIGGER IF EXISTS "cc_tenant_independentsitephase1projection" ON "IndependentSitePhase1Projection";
CREATE TRIGGER "cc_tenant_independentsitephase1projection"
  BEFORE INSERT OR UPDATE ON "IndependentSitePhase1Projection"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__IndependentSitePhase1Projection" ON "IndependentSitePhase1Projection";
CREATE TRIGGER "cc_tenant_immutable__IndependentSitePhase1Projection"
  BEFORE UPDATE ON "IndependentSitePhase1Projection"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

CREATE OR REPLACE FUNCTION cc_ps04_phase1_projection_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PS04_PHASE1_PROJECTION_APPEND_ONLY: % is not allowed on append-only phase-1 projection', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_append_only__IndependentSitePhase1Projection" ON "IndependentSitePhase1Projection";
CREATE TRIGGER "cc_append_only__IndependentSitePhase1Projection"
  BEFORE UPDATE OR DELETE ON "IndependentSitePhase1Projection"
  FOR EACH ROW EXECUTE FUNCTION cc_ps04_phase1_projection_append_only();
