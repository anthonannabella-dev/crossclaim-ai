-- ============================================================
-- CrossClaim — PROVIDER FOLLOW-UP INTELLIGENCE / P3（HOST 2026-10-06）
-- Provider case / contact 事实层（append-only）+ canonical projection
--   * ProviderCaseFact / ProviderContactFact：原始 provider 事实，UPDATE/DELETE 一律拒绝
--   * ProviderCaseProjection：只由事实派生（generation 单调推进；身份不可改写）
-- tenant 保护：3×cc_tenant_* 基线 + 3×cc_tenant_immutable__*；清单同步 required-triggers.json / append-only-triggers.json
-- ============================================================

CREATE TABLE "ProviderCaseFact" (
  "id"                TEXT         NOT NULL,
  "organizationId"    TEXT         NOT NULL,
  "platformAccountId" TEXT         NOT NULL,
  "platform"          TEXT         NOT NULL,
  "providerCaseId"    TEXT         NOT NULL,
  "factDigest"        TEXT         NOT NULL,
  "status"            TEXT         NOT NULL,
  "subject"           TEXT,
  "providerCreatedAt" TIMESTAMP(3),
  "providerUpdatedAt" TIMESTAMP(3),
  "lastContactAt"     TIMESTAMP(3),
  "contactKinds"      TEXT         NOT NULL,
  "attachmentCount"   INTEGER      NOT NULL DEFAULT 0,
  "adapterId"         TEXT         NOT NULL,
  "adapterVersion"    TEXT         NOT NULL,
  "credentialRef"     TEXT         NOT NULL,
  "connectionRef"     TEXT,
  "fetchedAt"         TIMESTAMP(3) NOT NULL,
  "snapshot"          TEXT         NOT NULL,
  "recordedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderCaseFact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderCaseFact_status_chk" CHECK (
    "status" IN ('OPEN','PENDING_MERCHANT_ACTION','PENDING_AMAZON_ACTION','RESOLVED','CLOSED','UNKNOWN')
  ),
  CONSTRAINT "ProviderCaseFact_attachment_chk" CHECK ("attachmentCount" >= 0)
);
CREATE UNIQUE INDEX "ProviderCaseFact_identity_digest_key"
  ON "ProviderCaseFact"("organizationId", "platformAccountId", "providerCaseId", "factDigest");
CREATE UNIQUE INDEX "ProviderCaseFact_organizationId_id_key"
  ON "ProviderCaseFact"("organizationId", "id");
CREATE INDEX "ProviderCaseFact_case_recordedAt_idx"
  ON "ProviderCaseFact"("organizationId", "platformAccountId", "providerCaseId", "recordedAt");

CREATE TABLE "ProviderContactFact" (
  "id"                TEXT         NOT NULL,
  "organizationId"    TEXT         NOT NULL,
  "platformAccountId" TEXT         NOT NULL,
  "platform"          TEXT         NOT NULL,
  "providerCaseId"    TEXT         NOT NULL,
  "contactId"         TEXT         NOT NULL,
  "factDigest"        TEXT         NOT NULL,
  "kind"              TEXT         NOT NULL,
  "direction"         TEXT         NOT NULL,
  "occurredAt"        TIMESTAMP(3) NOT NULL,
  "bodyText"          TEXT,
  "bodyDigest"        TEXT,
  "attachments"       TEXT         NOT NULL,
  "attachmentCount"   INTEGER      NOT NULL DEFAULT 0,
  "adapterId"         TEXT         NOT NULL,
  "adapterVersion"    TEXT         NOT NULL,
  "credentialRef"     TEXT         NOT NULL,
  "connectionRef"     TEXT,
  "fetchedAt"         TIMESTAMP(3) NOT NULL,
  "recordedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderContactFact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderContactFact_kind_chk" CHECK ("kind" IN ('EMAIL','CHAT','PHONE','UNKNOWN')),
  CONSTRAINT "ProviderContactFact_direction_chk" CHECK ("direction" IN ('INBOUND','OUTBOUND','UNKNOWN')),
  CONSTRAINT "ProviderContactFact_attachment_chk" CHECK ("attachmentCount" >= 0)
);
CREATE UNIQUE INDEX "ProviderContactFact_identity_digest_key"
  ON "ProviderContactFact"("organizationId", "platformAccountId", "providerCaseId", "contactId", "factDigest");
CREATE UNIQUE INDEX "ProviderContactFact_organizationId_id_key"
  ON "ProviderContactFact"("organizationId", "id");
CREATE INDEX "ProviderContactFact_case_occurredAt_idx"
  ON "ProviderContactFact"("organizationId", "platformAccountId", "providerCaseId", "occurredAt");

CREATE TABLE "ProviderCaseProjection" (
  "id"                TEXT         NOT NULL,
  "organizationId"    TEXT         NOT NULL,
  "platformAccountId" TEXT         NOT NULL,
  "platform"          TEXT         NOT NULL,
  "providerCaseId"    TEXT         NOT NULL,
  "status"            TEXT         NOT NULL,
  "subject"           TEXT,
  "lastContactAt"     TIMESTAMP(3),
  "contactCount"      INTEGER      NOT NULL DEFAULT 0,
  "attachmentCount"   INTEGER      NOT NULL DEFAULT 0,
  "contactKinds"      TEXT         NOT NULL,
  "generation"        INTEGER      NOT NULL DEFAULT 0,
  "lastFactDigest"    TEXT         NOT NULL,
  "firstFactAt"       TIMESTAMP(3) NOT NULL,
  "lastFactAt"        TIMESTAMP(3) NOT NULL,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderCaseProjection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderCaseProjection_status_chk" CHECK (
    "status" IN ('OPEN','PENDING_MERCHANT_ACTION','PENDING_AMAZON_ACTION','RESOLVED','CLOSED','UNKNOWN')
  ),
  CONSTRAINT "ProviderCaseProjection_generation_chk" CHECK ("generation" >= 0),
  CONSTRAINT "ProviderCaseProjection_counts_chk" CHECK ("contactCount" >= 0 AND "attachmentCount" >= 0)
);
CREATE UNIQUE INDEX "ProviderCaseProjection_identity_key"
  ON "ProviderCaseProjection"("organizationId", "platformAccountId", "providerCaseId");
CREATE UNIQUE INDEX "ProviderCaseProjection_organizationId_id_key"
  ON "ProviderCaseProjection"("organizationId", "id");

-- ---------- append-only：原始事实不可改写 ----------
CREATE OR REPLACE FUNCTION "cc_provider_case_fact_append_only"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'PROVIDER_CASE_FACT_APPEND_ONLY: provider facts must not be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_append_only__ProviderCaseFact" ON "ProviderCaseFact";
CREATE TRIGGER "cc_append_only__ProviderCaseFact"
  BEFORE UPDATE OR DELETE ON "ProviderCaseFact"
  FOR EACH ROW EXECUTE FUNCTION "cc_provider_case_fact_append_only"();

DROP TRIGGER IF EXISTS "cc_append_only__ProviderContactFact" ON "ProviderContactFact";
CREATE TRIGGER "cc_append_only__ProviderContactFact"
  BEFORE UPDATE OR DELETE ON "ProviderContactFact"
  FOR EACH ROW EXECUTE FUNCTION "cc_provider_case_fact_append_only"();

-- ---------- projection 身份不可改写（派生列可推进） ----------
CREATE OR REPLACE FUNCTION "cc_provider_case_projection_identity"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."organizationId"    IS DISTINCT FROM OLD."organizationId"
     OR NEW."platformAccountId" IS DISTINCT FROM OLD."platformAccountId"
     OR NEW."platform"          IS DISTINCT FROM OLD."platform"
     OR NEW."providerCaseId"    IS DISTINCT FROM OLD."providerCaseId"
     OR NEW."firstFactAt"       IS DISTINCT FROM OLD."firstFactAt"
     OR NEW."generation" < OLD."generation"
  THEN
    RAISE EXCEPTION 'PROVIDER_CASE_PROJECTION_IDENTITY_IMMUTABLE: projection identity must not be rewritten';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_provider_case_projection_identity__ProviderCaseProjection" ON "ProviderCaseProjection";
CREATE TRIGGER "cc_provider_case_projection_identity__ProviderCaseProjection"
  BEFORE UPDATE ON "ProviderCaseProjection"
  FOR EACH ROW EXECUTE FUNCTION "cc_provider_case_projection_identity"();

-- ---------- tenant 保护（基线 + 归属不可变） ----------
DROP TRIGGER IF EXISTS "cc_tenant_providercasefact" ON "ProviderCaseFact";
CREATE TRIGGER "cc_tenant_providercasefact"
  BEFORE INSERT OR UPDATE ON "ProviderCaseFact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_providercontactfact" ON "ProviderContactFact";
CREATE TRIGGER "cc_tenant_providercontactfact"
  BEFORE INSERT OR UPDATE ON "ProviderContactFact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_providercaseprojection" ON "ProviderCaseProjection";
CREATE TRIGGER "cc_tenant_providercaseprojection"
  BEFORE INSERT OR UPDATE ON "ProviderCaseProjection"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__ProviderCaseFact" ON "ProviderCaseFact";
CREATE TRIGGER "cc_tenant_immutable__ProviderCaseFact"
  BEFORE UPDATE ON "ProviderCaseFact"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__ProviderContactFact" ON "ProviderContactFact";
CREATE TRIGGER "cc_tenant_immutable__ProviderContactFact"
  BEFORE UPDATE ON "ProviderContactFact"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__ProviderCaseProjection" ON "ProviderCaseProjection";
CREATE TRIGGER "cc_tenant_immutable__ProviderCaseProjection"
  BEFORE UPDATE ON "ProviderCaseProjection"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- 回滚（人工）：DROP TRIGGER / DROP TABLE（见上）
