-- ============================================================
-- CrossClaim — PROVIDER FOLLOW-UP INTELLIGENCE / P3 slice A-S4（HOST 2026-10-06）
-- ProviderCaseResponseInterpretation：AI 回复解读（advisory only、append-only、与 Provider Truth 分层）
-- tenant 保护：cc_tenant_* 基线 + 归属不可变 + append-only 守卫（清单同步）
-- ============================================================

CREATE TABLE "ProviderCaseResponseInterpretation" (
  "id"                    TEXT         NOT NULL,
  "organizationId"        TEXT         NOT NULL,
  "platformAccountId"     TEXT         NOT NULL,
  "platform"              TEXT         NOT NULL,
  "providerCaseId"        TEXT         NOT NULL,
  "sourceContactId"       TEXT         NOT NULL,
  "sourceBodyDigest"      TEXT,
  "classification"        TEXT         NOT NULL,
  "confidenceBp"          INTEGER      NOT NULL,
  "requiredEvidence"      TEXT         NOT NULL,
  "extractedRequirements" TEXT         NOT NULL,
  "recommendedNextAction" TEXT         NOT NULL,
  "disposition"           TEXT         NOT NULL,
  "dispositionReasons"    TEXT         NOT NULL,
  "injectionSuspected"    BOOLEAN      NOT NULL DEFAULT false,
  "model"                 TEXT         NOT NULL,
  "promptVersion"         TEXT         NOT NULL,
  "classifierVersion"     TEXT         NOT NULL,
  "interpretationDigest"  TEXT         NOT NULL,
  "createdAt"             TIMESTAMP(3) NOT NULL,
  "recordedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderCaseResponseInterpretation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderCaseResponseInterpretation_classification_chk" CHECK (
    "classification" IN ('NEED_INVOICE','NEED_POD','NEED_PURCHASE_PROOF','NEED_TRACKING','NEED_DIMENSION_EVIDENCE',
      'NEED_CUSTOMS_DOCUMENT','NEED_RETURN_PROOF','NEED_DESTRUCTION_PROOF','NEED_MORE_INFO','APPROVED','REJECTED',
      'PARTIALLY_APPROVED','CLOSED','WAITING_PROVIDER','WAITING_SELLER','UNKNOWN')
  ),
  CONSTRAINT "ProviderCaseResponseInterpretation_action_chk" CHECK (
    "recommendedNextAction" IN ('EVIDENCE_RESOLUTION','CUSTOMER_EVIDENCE_REQUEST','WAIT','RECORD_OUTCOME','RECORD_REJECTION','CLOSE_CASE','HUMAN_REVIEW')
  ),
  CONSTRAINT "ProviderCaseResponseInterpretation_disposition_chk" CHECK ("disposition" IN ('AUTO','NEEDS_MANUAL_REVIEW')),
  CONSTRAINT "ProviderCaseResponseInterpretation_confidence_chk" CHECK ("confidenceBp" >= 0 AND "confidenceBp" <= 10000)
);

CREATE UNIQUE INDEX "ProviderCaseResponseInterpretation_identity_key"
  ON "ProviderCaseResponseInterpretation"("organizationId", "platformAccountId", "sourceContactId", "classifierVersion", "model", "promptVersion");
CREATE UNIQUE INDEX "ProviderCaseResponseInterpretation_organizationId_id_key"
  ON "ProviderCaseResponseInterpretation"("organizationId", "id");
CREATE INDEX "ProviderCaseResponseInterpretation_case_recordedAt_idx"
  ON "ProviderCaseResponseInterpretation"("organizationId", "platformAccountId", "providerCaseId", "recordedAt");

CREATE OR REPLACE FUNCTION "cc_provider_interpretation_append_only"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'PROVIDER_INTERPRETATION_APPEND_ONLY: AI interpretations must not be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_append_only__ProviderCaseResponseInterpretation" ON "ProviderCaseResponseInterpretation";
CREATE TRIGGER "cc_append_only__ProviderCaseResponseInterpretation"
  BEFORE UPDATE OR DELETE ON "ProviderCaseResponseInterpretation"
  FOR EACH ROW EXECUTE FUNCTION "cc_provider_interpretation_append_only"();

DROP TRIGGER IF EXISTS "cc_tenant_providercaseresponseinterpretation" ON "ProviderCaseResponseInterpretation";
CREATE TRIGGER "cc_tenant_providercaseresponseinterpretation"
  BEFORE INSERT OR UPDATE ON "ProviderCaseResponseInterpretation"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__ProviderCaseResponseInterpretation" ON "ProviderCaseResponseInterpretation";
CREATE TRIGGER "cc_tenant_immutable__ProviderCaseResponseInterpretation"
  BEFORE UPDATE ON "ProviderCaseResponseInterpretation"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- 回滚（人工）：DROP TRIGGER / DROP TABLE（见上）
