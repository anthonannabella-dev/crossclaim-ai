-- CA-2（MSG-20261004-02 §六）— AUTHORIZED SIGNER FACT
-- 谁有权代表 claimant / importer 启动或签署 Customs recovery：tenant scoped、append-only、
-- VERIFIED 需 source + evidence、raw sensitive identity 禁止（引用必须是 opaque ref）。

CREATE TYPE "CustomsAuthorizedSignerType" AS ENUM (
  'LEGAL_REPRESENTATIVE',
  'AUTHORIZED_EMPLOYEE',
  'LICENSED_CUSTOMS_BROKER',
  'OTHER_REGULATORY_AUTHORIZED_SIGNER'
);

CREATE TABLE "CustomsAuthorizedSignerFact" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "principalRef" TEXT NOT NULL,
  "signerRef" TEXT NOT NULL,
  "signerType" "CustomsAuthorizedSignerType" NOT NULL,
  "authorityBasis" TEXT NOT NULL,
  "scope" JSONB NOT NULL,
  "jurisdiction" TEXT NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "verificationStatus" "CustomsIorVerificationStatus" NOT NULL,
  "verificationSource" "CustomsIorVerificationSource" NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "evidenceArtifactRef" TEXT,
  "revokedAt" TIMESTAMP(3),
  "supersededAt" TIMESTAMP(3),
  "contentDigest" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomsAuthorizedSignerFact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsAuthorizedSignerFact_digest_shape" CHECK ("contentDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "CustomsAuthorizedSignerFact_principal_ref_shape" CHECK ("principalRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "CustomsAuthorizedSignerFact_signer_ref_shape" CHECK ("signerRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "CustomsAuthorizedSignerFact_basis_shape" CHECK ("authorityBasis" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "CustomsAuthorizedSignerFact_evidence_ref_shape" CHECK ("evidenceArtifactRef" IS NULL OR "evidenceArtifactRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  -- raw sensitive identity 禁止：EIN-like 与纯数字 importer number 不得作为引用
  CONSTRAINT "CustomsAuthorizedSignerFact_principal_ref_not_ein" CHECK ("principalRef" !~ '^[0-9]{2}-[0-9]{7}$'),
  CONSTRAINT "CustomsAuthorizedSignerFact_principal_ref_not_numeric" CHECK ("principalRef" !~ '^[0-9]{6,12}$'),
  CONSTRAINT "CustomsAuthorizedSignerFact_signer_ref_not_ein" CHECK ("signerRef" !~ '^[0-9]{2}-[0-9]{7}$'),
  CONSTRAINT "CustomsAuthorizedSignerFact_signer_ref_not_numeric" CHECK ("signerRef" !~ '^[0-9]{6,12}$'),
  -- scope 必须是非空数组（remedy 列表）
  CONSTRAINT "CustomsAuthorizedSignerFact_scope_array" CHECK (jsonb_typeof("scope") = 'array' AND jsonb_array_length("scope") > 0),
  CONSTRAINT "CustomsAuthorizedSignerFact_expiry_window" CHECK ("expiresAt" IS NULL OR "expiresAt" >= "effectiveAt"),
  -- VERIFIED 必须可解释：source ≠ NONE、有 verifiedAt、有 evidence
  CONSTRAINT "CustomsAuthorizedSignerFact_verified_needs_source" CHECK ("verificationStatus" <> 'VERIFIED' OR "verificationSource" <> 'NONE'),
  CONSTRAINT "CustomsAuthorizedSignerFact_verified_needs_evidence" CHECK ("verificationStatus" <> 'VERIFIED' OR "evidenceArtifactRef" IS NOT NULL),
  CONSTRAINT "CustomsAuthorizedSignerFact_verified_needs_timestamp" CHECK ("verificationStatus" <> 'VERIFIED' OR "verifiedAt" IS NOT NULL),
  -- 撤销 / 取代必须带时间戳，且不得早于本次观察
  CONSTRAINT "CustomsAuthorizedSignerFact_revoked_consistent" CHECK ("verificationStatus" <> 'REVOKED' OR "revokedAt" IS NOT NULL),
  CONSTRAINT "CustomsAuthorizedSignerFact_supersede_window" CHECK ("supersededAt" IS NULL OR "supersededAt" >= "observedAt")
);
CREATE UNIQUE INDEX "CustomsAuthorizedSignerFact_organizationId_contentDigest_key" ON "CustomsAuthorizedSignerFact"("organizationId", "contentDigest");
CREATE INDEX "CustomsAuthorizedSignerFact_org_principal_observed_idx" ON "CustomsAuthorizedSignerFact"("organizationId", "principalRef", "observedAt");
CREATE INDEX "CustomsAuthorizedSignerFact_org_signer_idx" ON "CustomsAuthorizedSignerFact"("organizationId", "signerRef");
CREATE INDEX "CustomsAuthorizedSignerFact_org_status_idx" ON "CustomsAuthorizedSignerFact"("organizationId", "verificationStatus");
ALTER TABLE "CustomsAuthorizedSignerFact" ADD CONSTRAINT "CustomsAuthorizedSignerFact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 租户完整性 + 归属不可变 + append-only（与既有 IOR / POA 事实同族）
DROP TRIGGER IF EXISTS "cc_tenant_customsauthorizedsignerfact" ON "CustomsAuthorizedSignerFact";
CREATE TRIGGER "cc_tenant_customsauthorizedsignerfact"
  BEFORE INSERT OR UPDATE ON "CustomsAuthorizedSignerFact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__CustomsAuthorizedSignerFact" ON "CustomsAuthorizedSignerFact";
CREATE TRIGGER "cc_tenant_immutable__CustomsAuthorizedSignerFact"
  BEFORE UPDATE ON "CustomsAuthorizedSignerFact"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_append_only__CustomsAuthorizedSignerFact" ON "CustomsAuthorizedSignerFact";
CREATE TRIGGER "cc_append_only__CustomsAuthorizedSignerFact"
  BEFORE UPDATE OR DELETE ON "CustomsAuthorizedSignerFact"
  FOR EACH ROW EXECUTE FUNCTION cc_customs_ior_fact_append_only();

-- 同租户 lineage：签署人授权必须引用同租户、同 principal 的 IOR 身份事实
CREATE OR REPLACE FUNCTION cc_customs_authorized_signer_lineage() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "CustomsIorIdentityFact" f
    WHERE f."organizationId" = NEW."organizationId" AND f."importerOfRecordRef" = NEW."principalRef"
  ) THEN
    RAISE EXCEPTION 'CUSTOMS_AUTHORIZED_SIGNER_LINEAGE_TENANT: signer authority must reference a same-tenant IOR identity fact';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_ior_lineage__CustomsAuthorizedSignerFact" ON "CustomsAuthorizedSignerFact";
CREATE TRIGGER "cc_ior_lineage__CustomsAuthorizedSignerFact"
  BEFORE INSERT ON "CustomsAuthorizedSignerFact"
  FOR EACH ROW EXECUTE FUNCTION cc_customs_authorized_signer_lineage();
