-- P0-1：Return / Export / Destruction 事实表（append-only evidence snapshot）
CREATE TABLE "CustomsReturnFactRecord" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "platformAccountId" TEXT NOT NULL,
  "entryNumber" TEXT NOT NULL,
  "htsCode" TEXT NOT NULL,
  "sku" TEXT,
  "kind" TEXT NOT NULL,
  "quantity" DECIMAL(38,6) NOT NULL,
  "currency" TEXT NOT NULL,
  "jurisdiction" TEXT NOT NULL,
  "importerOfRecordRef" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "rawReference" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "contentDigest" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomsReturnFactRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsReturnFactRecord_kind_check" CHECK ("kind" IN ('RETURN', 'EXPORT', 'DESTRUCTION')),
  CONSTRAINT "CustomsReturnFactRecord_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "CustomsReturnFactRecord_quantity_positive_check" CHECK ("quantity" > 0),
  CONSTRAINT "CustomsReturnFactRecord_content_digest_shape" CHECK ("contentDigest" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "CustomsReturnFactRecord_organizationId_contentDigest_key" ON "CustomsReturnFactRecord"("organizationId", "contentDigest");
CREATE INDEX "CustomsReturnFactRecord_organizationId_entryNumber_idx" ON "CustomsReturnFactRecord"("organizationId", "entryNumber");
CREATE INDEX "CustomsReturnFactRecord_organizationId_platformAccountId_htsCode_idx" ON "CustomsReturnFactRecord"("organizationId", "platformAccountId", "htsCode");
ALTER TABLE "CustomsReturnFactRecord" ADD CONSTRAINT "CustomsReturnFactRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TRIGGER IF EXISTS cc_tenant_customsreturnfactrecord ON "CustomsReturnFactRecord";
CREATE TRIGGER cc_tenant_customsreturnfactrecord
  BEFORE INSERT OR UPDATE ON "CustomsReturnFactRecord"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();
DROP TRIGGER IF EXISTS "cc_tenant_immutable__CustomsReturnFactRecord" ON "CustomsReturnFactRecord";
CREATE TRIGGER "cc_tenant_immutable__CustomsReturnFactRecord"
  BEFORE UPDATE ON "CustomsReturnFactRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();
CREATE OR REPLACE FUNCTION cc_customs_return_fact_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CUSTOMS_RETURN_FACT_APPEND_ONLY: % is not allowed on append-only return facts', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "cc_append_only__CustomsReturnFactRecord" ON "CustomsReturnFactRecord";
CREATE TRIGGER "cc_append_only__CustomsReturnFactRecord"
  BEFORE UPDATE OR DELETE ON "CustomsReturnFactRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_customs_return_fact_append_only();
