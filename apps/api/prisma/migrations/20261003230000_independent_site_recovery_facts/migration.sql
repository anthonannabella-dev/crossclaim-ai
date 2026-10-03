-- BG-021 — INDEPENDENT-SITE / CHARGEBACK 事实层（MSG-20261003-139 APPROVED TO IMPLEMENT WITH REVISE）
-- 三张 append-only 事实表 + 3 枚举 + DB 级 CHECK/触发器（含同租户 lineage 与 VERIFIED settlement evidence）。

CREATE TYPE "Ps04HandoffChannel" AS ENUM ('MANUAL_PORTAL', 'MANUAL_EMAIL', 'FIXTURE');
CREATE TYPE "Ps04ResponseDisposition" AS ENUM ('WON', 'LOST', 'PARTIAL', 'UNKNOWN');
CREATE TYPE "Ps04SettlementVerification" AS ENUM ('VERIFIED', 'UNVERIFIED');

-- ① 人工递交事实（initial recovery handoff root：每 dispute 至多一条）
CREATE TABLE "IndependentSiteHandoffFact" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "merchantRef" TEXT NOT NULL,
  "paymentAccountRef" TEXT NOT NULL,
  "disputeReference" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "packageDigest" TEXT NOT NULL,
  "channel" "Ps04HandoffChannel" NOT NULL,
  "handoffReference" TEXT NOT NULL,
  "attestedByActorId" TEXT NOT NULL,
  "executionKey" TEXT NOT NULL,
  "contentDigest" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IndependentSiteHandoffFact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IndependentSiteHandoffFact_package_digest_shape" CHECK ("packageDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "IndependentSiteHandoffFact_content_digest_shape" CHECK ("contentDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "IndependentSiteHandoffFact_merchant_ref_shape" CHECK ("merchantRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "IndependentSiteHandoffFact_account_ref_shape" CHECK ("paymentAccountRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  -- PAN-like / raw numeric account 一律拒绝（tokenized opaque reference 才允许）
  CONSTRAINT "IndependentSiteHandoffFact_account_ref_not_numeric" CHECK ("paymentAccountRef" !~ '^[0-9]{6,19}$'),
  CONSTRAINT "IndependentSiteHandoffFact_dispute_ref_shape" CHECK ("disputeReference" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "IndependentSiteHandoffFact_handoff_ref_shape" CHECK ("handoffReference" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "IndependentSiteHandoffFact_attestor_ref_shape" CHECK ("attestedByActorId" ~ '^[A-Za-z0-9._:@#/-]{1,96}$')
);
CREATE UNIQUE INDEX "IndependentSiteHandoffFact_org_dispute_key" ON "IndependentSiteHandoffFact"("organizationId", "disputeReference");
CREATE UNIQUE INDEX "IndependentSiteHandoffFact_org_execution_key" ON "IndependentSiteHandoffFact"("organizationId", "executionKey");
CREATE UNIQUE INDEX "IndependentSiteHandoffFact_org_content_digest_key" ON "IndependentSiteHandoffFact"("organizationId", "contentDigest");
CREATE INDEX "IndependentSiteHandoffFact_org_account_observed_idx" ON "IndependentSiteHandoffFact"("organizationId", "paymentAccountRef", "observedAt");
ALTER TABLE "IndependentSiteHandoffFact" ADD CONSTRAINT "IndependentSiteHandoffFact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ② PSP 响应事实（append-only，可多条；WON ≠ 已到账）
CREATE TABLE "IndependentSiteResponseFact" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "disputeReference" TEXT NOT NULL,
  "disposition" "Ps04ResponseDisposition" NOT NULL,
  "amount" DECIMAL(38,6),
  "currency" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "contentDigest" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IndependentSiteResponseFact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IndependentSiteResponseFact_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "IndependentSiteResponseFact_amount_non_negative" CHECK ("amount" IS NULL OR "amount" >= 0),
  CONSTRAINT "IndependentSiteResponseFact_source_check" CHECK ("source" IN ('MANUAL_ENTRY', 'FIXTURE')),
  CONSTRAINT "IndependentSiteResponseFact_digest_shape" CHECK ("contentDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "IndependentSiteResponseFact_dispute_ref_shape" CHECK ("disputeReference" ~ '^[A-Za-z0-9._:@#/-]{1,96}$')
);
CREATE UNIQUE INDEX "IndependentSiteResponseFact_org_content_digest_key" ON "IndependentSiteResponseFact"("organizationId", "contentDigest");
CREATE INDEX "IndependentSiteResponseFact_org_dispute_observed_idx" ON "IndependentSiteResponseFact"("organizationId", "disputeReference", "observedAt");
ALTER TABLE "IndependentSiteResponseFact" ADD CONSTRAINT "IndependentSiteResponseFact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ③ 到账事实（append-only，可多条；只有带 evidence 的 VERIFIED 才能进入 recovered/billable）
CREATE TABLE "IndependentSiteSettlementFact" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "disputeReference" TEXT NOT NULL,
  "amount" DECIMAL(38,6) NOT NULL,
  "currency" TEXT NOT NULL,
  "verification" "Ps04SettlementVerification" NOT NULL,
  "reference" TEXT NOT NULL,
  "evidenceArtifactRef" TEXT,
  "contentDigest" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IndependentSiteSettlementFact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IndependentSiteSettlementFact_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
  -- 0 元 VERIFIED settlement 不得成为 recovered truth
  CONSTRAINT "IndependentSiteSettlementFact_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "IndependentSiteSettlementFact_digest_shape" CHECK ("contentDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "IndependentSiteSettlementFact_dispute_ref_shape" CHECK ("disputeReference" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "IndependentSiteSettlementFact_reference_shape" CHECK ("reference" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  CONSTRAINT "IndependentSiteSettlementFact_evidence_ref_shape" CHECK ("evidenceArtifactRef" IS NULL OR "evidenceArtifactRef" ~ '^[A-Za-z0-9._:@#/-]{1,96}$'),
  -- VERIFIED ⇒ 必须有可审计证据
  CONSTRAINT "IndependentSiteSettlementFact_verified_needs_evidence" CHECK ("verification" <> 'VERIFIED' OR "evidenceArtifactRef" IS NOT NULL)
);
CREATE UNIQUE INDEX "IndependentSiteSettlementFact_org_content_digest_key" ON "IndependentSiteSettlementFact"("organizationId", "contentDigest");
CREATE INDEX "IndependentSiteSettlementFact_org_dispute_received_idx" ON "IndependentSiteSettlementFact"("organizationId", "disputeReference", "receivedAt");
ALTER TABLE "IndependentSiteSettlementFact" ADD CONSTRAINT "IndependentSiteSettlementFact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 租户完整性 + 归属不可变 + append-only（与既有域同族）
DO $$
DECLARE
  t TEXT;
  lc TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['IndependentSiteHandoffFact', 'IndependentSiteResponseFact', 'IndependentSiteSettlementFact'] LOOP
    lc := lower(t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'cc_tenant_' || lc, t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity()', 'cc_tenant_' || lc, t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'cc_tenant_immutable__' || t, t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment()', 'cc_tenant_immutable__' || t, t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION cc_ps04_fact_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PS04_FACT_APPEND_ONLY: % is not allowed on append-only independent-site fact', TG_OP;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['IndependentSiteHandoffFact', 'IndependentSiteResponseFact', 'IndependentSiteSettlementFact'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'cc_append_only__' || t, t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION cc_ps04_fact_append_only()', 'cc_append_only__' || t, t);
  END LOOP;
END $$;

-- 同租户 lineage：响应 / 到账必须存在同租户、同 dispute 的 initial handoff root
CREATE OR REPLACE FUNCTION cc_ps04_lineage_tenant() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "IndependentSiteHandoffFact" h
    WHERE h."organizationId" = NEW."organizationId" AND h."disputeReference" = NEW."disputeReference"
  ) THEN
    RAISE EXCEPTION 'PS04_LINEAGE_TENANT: response/settlement must reference a same-tenant handoff root';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_ps04_lineage__IndependentSiteResponseFact" ON "IndependentSiteResponseFact";
CREATE TRIGGER "cc_ps04_lineage__IndependentSiteResponseFact"
  BEFORE INSERT ON "IndependentSiteResponseFact"
  FOR EACH ROW EXECUTE FUNCTION cc_ps04_lineage_tenant();

DROP TRIGGER IF EXISTS "cc_ps04_lineage__IndependentSiteSettlementFact" ON "IndependentSiteSettlementFact";
CREATE TRIGGER "cc_ps04_lineage__IndependentSiteSettlementFact"
  BEFORE INSERT ON "IndependentSiteSettlementFact"
  FOR EACH ROW EXECUTE FUNCTION cc_ps04_lineage_tenant();
