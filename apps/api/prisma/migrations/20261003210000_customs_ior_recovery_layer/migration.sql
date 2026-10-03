-- ENTERPRISE IOR RECOVERY LAYER（HOST DIRECTIVE；MSG-20261003-136 APPROVED TO IMPLEMENT）
-- 三张独立 append-only 事实表 + 5 枚举：身份事实 ≠ 权利归属事实 ≠ Broker 授权事实。
-- DB 级不变量（不依赖 service 校验）：machine-safe reference、digest 形状、4811 拒绝、
-- POA 一致性、VERIFIED 必须带 evidence 且 source ≠ NONE、有效期窗口、scope 非空。

CREATE TYPE "CustomsIorPrincipalType" AS ENUM ('IMPORTER_OF_RECORD', 'DRAWBACK_CLAIMANT');
CREATE TYPE "CustomsIorVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REVOKED', 'UNKNOWN');
CREATE TYPE "CustomsIorVerificationSource" AS ENUM ('BROKER_ATTESTATION', 'ACE_LOOKUP', 'CUSTOMER_DOCUMENT', 'MANUAL_REVIEW', 'NONE');
CREATE TYPE "CustomsBrokerAuthorizationType" AS ENUM ('CBP_FORM_5291', 'EQUIVALENT_REGULATORY_POA');
CREATE TYPE "CustomsRightLineageOutcome" AS ENUM ('COMPLETE', 'NEEDS_MANUAL', 'BROKER_REVIEW');

-- ① IOR / CLAIMANT 身份事实
CREATE TABLE "CustomsIorIdentityFact" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "jurisdiction" TEXT NOT NULL,
  "principalType" "CustomsIorPrincipalType" NOT NULL,
  "importerOfRecordRef" TEXT NOT NULL,
  "legalEntityRef" TEXT NOT NULL,
  "aceAccountRef" TEXT,
  "verificationStatus" "CustomsIorVerificationStatus" NOT NULL,
  "verificationSource" "CustomsIorVerificationSource" NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "effectiveFrom" TIMESTAMP(3),
  "effectiveTo" TIMESTAMP(3),
  "contentDigest" TEXT NOT NULL,
  "sourceReference" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomsIorIdentityFact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsIorIdentityFact_digest_shape" CHECK ("contentDigest" ~ '^[0-9a-f]{64}$'),
  -- machine-safe reference：拒绝含空格自由文本 / 裸 credential
  CONSTRAINT "CustomsIorIdentityFact_ior_ref_shape" CHECK ("importerOfRecordRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "CustomsIorIdentityFact_legal_ref_shape" CHECK ("legalEntityRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "CustomsIorIdentityFact_source_ref_shape" CHECK ("sourceReference" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "CustomsIorIdentityFact_ace_ref_shape" CHECK ("aceAccountRef" IS NULL OR "aceAccountRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  -- 裸 EIN 形状 / 纯数字 importer number 一律拒绝（DB 级）
  CONSTRAINT "CustomsIorIdentityFact_ior_ref_not_ein" CHECK ("importerOfRecordRef" !~ '^[0-9]{2}-[0-9]{7}$'),
  CONSTRAINT "CustomsIorIdentityFact_ior_ref_not_numeric" CHECK ("importerOfRecordRef" !~ '^[0-9]{6,12}$'),
  CONSTRAINT "CustomsIorIdentityFact_legal_ref_not_numeric" CHECK ("legalEntityRef" !~ '^[0-9]{6,12}$'),
  CONSTRAINT "CustomsIorIdentityFact_ace_ref_not_numeric" CHECK ("aceAccountRef" IS NULL OR "aceAccountRef" !~ '^[0-9]{6,12}$'),
  -- 有效期窗口形状
  CONSTRAINT "CustomsIorIdentityFact_effective_window" CHECK (
    "effectiveFrom" IS NULL OR "effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"
  )
);
CREATE UNIQUE INDEX "CustomsIorIdentityFact_organizationId_contentDigest_key" ON "CustomsIorIdentityFact"("organizationId", "contentDigest");
CREATE INDEX "CustomsIorIdentityFact_org_ior_observed_idx" ON "CustomsIorIdentityFact"("organizationId", "importerOfRecordRef", "observedAt");
CREATE INDEX "CustomsIorIdentityFact_org_status_idx" ON "CustomsIorIdentityFact"("organizationId", "verificationStatus");
ALTER TABLE "CustomsIorIdentityFact" ADD CONSTRAINT "CustomsIorIdentityFact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ② RECOVERY RIGHT LINEAGE 事实
CREATE TABLE "CustomsRightLineageFact" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "entryReference" TEXT NOT NULL,
  "importerOfRecordRef" TEXT NOT NULL,
  "claimantRef" TEXT NOT NULL,
  "remedyRoute" TEXT NOT NULL,
  "iorRightsForRemedy" TEXT NOT NULL,
  "claimantRightsForRemedy" TEXT NOT NULL,
  "filingAuthorized" BOOLEAN NOT NULL,
  "outcome" "CustomsRightLineageOutcome" NOT NULL,
  "reasonCodes" JSONB NOT NULL,
  "evidenceKinds" JSONB NOT NULL,
  "contentDigest" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomsRightLineageFact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsRightLineageFact_digest_shape" CHECK ("contentDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CustomsRightLineageFact_entry_ref_shape" CHECK ("entryReference" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "CustomsRightLineageFact_ior_ref_shape" CHECK ("importerOfRecordRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "CustomsRightLineageFact_claimant_ref_shape" CHECK ("claimantRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "CustomsRightLineageFact_ior_ref_not_ein" CHECK ("importerOfRecordRef" !~ '^[0-9]{2}-[0-9]{7}$'),
  CONSTRAINT "CustomsRightLineageFact_ior_ref_not_numeric" CHECK ("importerOfRecordRef" !~ '^[0-9]{6,12}$'),
  -- 权利判定只能是三态之一（NULL / 自由文本一律拒绝）
  CONSTRAINT "CustomsRightLineageFact_ior_rights_check" CHECK ("iorRightsForRemedy" IN ('CONFIRMED', 'UNCLEAR', 'ABSENT')),
  CONSTRAINT "CustomsRightLineageFact_claimant_rights_check" CHECK ("claimantRightsForRemedy" IN ('CONFIRMED', 'UNCLEAR', 'ABSENT')),
  CONSTRAINT "CustomsRightLineageFact_remedy_route_check" CHECK ("remedyRoute" IN ('DRAWBACK', 'PROTEST', 'POST_SUMMARY_CORRECTION', 'EXCLUSION_REFUND', 'CLASSIFICATION_CORRECTION', 'DUPLICATE_DUTY', 'OTHER')),
  CONSTRAINT "CustomsRightLineageFact_reason_codes_array" CHECK (jsonb_typeof("reasonCodes") = 'array'),
  CONSTRAINT "CustomsRightLineageFact_evidence_kinds_array" CHECK (jsonb_typeof("evidenceKinds") = 'array')
);
CREATE UNIQUE INDEX "CustomsRightLineageFact_organizationId_contentDigest_key" ON "CustomsRightLineageFact"("organizationId", "contentDigest");
CREATE INDEX "CustomsRightLineageFact_org_entry_observed_idx" ON "CustomsRightLineageFact"("organizationId", "entryReference", "observedAt");
CREATE INDEX "CustomsRightLineageFact_org_claimant_idx" ON "CustomsRightLineageFact"("organizationId", "claimantRef");
ALTER TABLE "CustomsRightLineageFact" ADD CONSTRAINT "CustomsRightLineageFact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ③ BROKER POA 事实（仅 5291 / equivalent；4811 由 CHECK 拒绝）
CREATE TABLE "CustomsBrokerPoaFact" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "principalRef" TEXT NOT NULL,
  "brokerRef" TEXT NOT NULL,
  "jurisdiction" TEXT NOT NULL,
  "authorizationType" "CustomsBrokerAuthorizationType" NOT NULL,
  "scope" JSONB NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "evidenceArtifactRef" TEXT,
  "verificationStatus" "CustomsIorVerificationStatus" NOT NULL,
  "verificationSource" "CustomsIorVerificationSource" NOT NULL,
  "contentDigest" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomsBrokerPoaFact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsBrokerPoaFact_digest_shape" CHECK ("contentDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CustomsBrokerPoaFact_principal_ref_shape" CHECK ("principalRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "CustomsBrokerPoaFact_broker_ref_shape" CHECK ("brokerRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "CustomsBrokerPoaFact_principal_ref_not_ein" CHECK ("principalRef" !~ '^[0-9]{2}-[0-9]{7}$'),
  CONSTRAINT "CustomsBrokerPoaFact_principal_ref_not_numeric" CHECK ("principalRef" !~ '^[0-9]{6,12}$'),
  CONSTRAINT "CustomsBrokerPoaFact_evidence_ref_shape" CHECK ("evidenceArtifactRef" IS NULL OR "evidenceArtifactRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  -- scope 必须是非空数组
  CONSTRAINT "CustomsBrokerPoaFact_scope_array" CHECK (jsonb_typeof("scope") = 'array' AND jsonb_array_length("scope") > 0),
  -- expiresAt >= effectiveAt
  CONSTRAINT "CustomsBrokerPoaFact_expiry_window" CHECK ("expiresAt" IS NULL OR "expiresAt" >= "effectiveAt"),
  -- VERIFIED 必须有 evidence 且 source ≠ NONE
  CONSTRAINT "CustomsBrokerPoaFact_verified_needs_evidence" CHECK ("verificationStatus" <> 'VERIFIED' OR "evidenceArtifactRef" IS NOT NULL),
  CONSTRAINT "CustomsBrokerPoaFact_verified_needs_source" CHECK ("verificationStatus" <> 'VERIFIED' OR "verificationSource" <> 'NONE')
);
CREATE UNIQUE INDEX "CustomsBrokerPoaFact_organizationId_contentDigest_key" ON "CustomsBrokerPoaFact"("organizationId", "contentDigest");
CREATE INDEX "CustomsBrokerPoaFact_org_principal_observed_idx" ON "CustomsBrokerPoaFact"("organizationId", "principalRef", "observedAt");
CREATE INDEX "CustomsBrokerPoaFact_org_broker_idx" ON "CustomsBrokerPoaFact"("organizationId", "brokerRef");
ALTER TABLE "CustomsBrokerPoaFact" ADD CONSTRAINT "CustomsBrokerPoaFact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 租户完整性 + 归属不可变 + append-only 守卫（与既有 G8/G9 同族）
DO $$
DECLARE
  t TEXT;
  lc TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['CustomsIorIdentityFact', 'CustomsRightLineageFact', 'CustomsBrokerPoaFact'] LOOP
    lc := lower(t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'cc_tenant_' || lc, t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity()', 'cc_tenant_' || lc, t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'cc_tenant_immutable__' || t, t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment()', 'cc_tenant_immutable__' || t, t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'cc_append_only__' || t, t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment()', 'cc_append_only__' || t, t);
  END LOOP;
END $$;

-- append-only 专用拒绝函数（UPDATE/DELETE 一律报错，语义与既有域一致）
CREATE OR REPLACE FUNCTION cc_customs_ior_fact_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CUSTOMS_IOR_FACT_APPEND_ONLY: % is not allowed on append-only IOR fact', TG_OP;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['CustomsIorIdentityFact', 'CustomsRightLineageFact', 'CustomsBrokerPoaFact'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'cc_append_only__' || t, t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cc_customs_ior_fact_append_only()', 'cc_append_only__' || t, t);
  END LOOP;
END $$;

-- 权利链 / Broker 授权的**同租户 lineage** 守卫（MSG-20261003-136 要求：tenant lineage 必须与引用的
-- identity/evidence 一致）——引用的 IOR 身份事实必须存在且属于同一 organizationId。
CREATE OR REPLACE FUNCTION cc_customs_ior_lineage_tenant() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'CustomsRightLineageFact' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "CustomsIorIdentityFact" f
      WHERE f."organizationId" = NEW."organizationId" AND f."importerOfRecordRef" = NEW."importerOfRecordRef"
    ) THEN
      RAISE EXCEPTION 'CUSTOMS_IOR_LINEAGE_TENANT: right lineage must reference a same-tenant IOR identity fact';
    END IF;
  ELSIF TG_TABLE_NAME = 'CustomsBrokerPoaFact' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "CustomsIorIdentityFact" f
      WHERE f."organizationId" = NEW."organizationId" AND f."importerOfRecordRef" = NEW."principalRef"
    ) THEN
      RAISE EXCEPTION 'CUSTOMS_IOR_LINEAGE_TENANT: broker POA must reference a same-tenant IOR identity fact';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_ior_lineage__CustomsRightLineageFact" ON "CustomsRightLineageFact";
CREATE TRIGGER "cc_ior_lineage__CustomsRightLineageFact"
  BEFORE INSERT ON "CustomsRightLineageFact"
  FOR EACH ROW EXECUTE FUNCTION cc_customs_ior_lineage_tenant();

DROP TRIGGER IF EXISTS "cc_ior_lineage__CustomsBrokerPoaFact" ON "CustomsBrokerPoaFact";
CREATE TRIGGER "cc_ior_lineage__CustomsBrokerPoaFact"
  BEFORE INSERT ON "CustomsBrokerPoaFact"
  FOR EACH ROW EXECUTE FUNCTION cc_customs_ior_lineage_tenant();
