-- CUSTOMS GAP G4 / Q2 Schema Delta（MSG-20261003-127 Q2 APPROVED WITH CHANGES）
-- 事实层：CustomsEntryFactRecord + CustomsEntryDutyLineRecord（append-only evidence snapshot）
--   · Decimal(38,6) 金额 + 独立 currency；无 credential / raw payload / PII 列
--   · CHANGE C：DutyLine 唯一键 = (factId, lineOrdinal)；rawCode 仅索引

CREATE TABLE "CustomsEntryFactRecord" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "entryNumber" TEXT NOT NULL,
  "entryDate" DATE NOT NULL,
  "jurisdiction" TEXT NOT NULL,
  "portOfEntry" TEXT NOT NULL,
  "importerOfRecordRef" TEXT NOT NULL,
  "rawReference" TEXT NOT NULL,
  "contentDigest" TEXT NOT NULL,
  "totalDutyAmountByCurrency" JSONB NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomsEntryFactRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsEntryFactRecord_source_check" CHECK ("source" IN ('BROKER_DOCUMENT', 'ABI_VENDOR', 'EDI_SFTP', 'USER_UPLOAD')),
  CONSTRAINT "CustomsEntryFactRecord_jurisdiction_check" CHECK ("jurisdiction" ~ '^[A-Z]{2,3}$'),
  CONSTRAINT "CustomsEntryFactRecord_content_digest_shape" CHECK ("contentDigest" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "CustomsEntryFactRecord_organizationId_contentDigest_key" ON "CustomsEntryFactRecord"("organizationId", "contentDigest");
CREATE INDEX "CustomsEntryFactRecord_organizationId_entryNumber_idx" ON "CustomsEntryFactRecord"("organizationId", "entryNumber");
ALTER TABLE "CustomsEntryFactRecord" ADD CONSTRAINT "CustomsEntryFactRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CustomsEntryDutyLineRecord" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "factId" TEXT NOT NULL,
  "lineOrdinal" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "rawCode" TEXT NOT NULL,
  "amount" DECIMAL(38,6) NOT NULL,
  "currency" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomsEntryDutyLineRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomsEntryDutyLineRecord_kind_check" CHECK ("kind" IN ('DUTY', 'TAX', 'FEE', 'INTEREST', 'OTHER')),
  CONSTRAINT "CustomsEntryDutyLineRecord_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "CustomsEntryDutyLineRecord_line_ordinal_check" CHECK ("lineOrdinal" >= 0),
  CONSTRAINT "CustomsEntryDutyLineRecord_amount_range_check" CHECK ("amount" > -1000000000000 AND "amount" < 1000000000000)
);

-- CHANGE C：唯一键用 lineOrdinal（重复 rawCode 必须可落库，否则 C2 DUPLICATE_RAW_CODE 无法从事实重建）
CREATE UNIQUE INDEX "CustomsEntryDutyLineRecord_factId_lineOrdinal_key" ON "CustomsEntryDutyLineRecord"("factId", "lineOrdinal");
CREATE INDEX "CustomsEntryDutyLineRecord_factId_rawCode_currency_idx" ON "CustomsEntryDutyLineRecord"("factId", "rawCode", "currency");
CREATE INDEX "CustomsEntryDutyLineRecord_organizationId_factId_idx" ON "CustomsEntryDutyLineRecord"("organizationId", "factId");
ALTER TABLE "CustomsEntryDutyLineRecord" ADD CONSTRAINT "CustomsEntryDutyLineRecord_factId_fkey" FOREIGN KEY ("factId") REFERENCES "CustomsEntryFactRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomsEntryDutyLineRecord" ADD CONSTRAINT "CustomsEntryDutyLineRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- tenant 归属完整性 + 归属不可变 ----------
DROP TRIGGER IF EXISTS cc_tenant_customsentryfactrecord ON "CustomsEntryFactRecord";
CREATE TRIGGER cc_tenant_customsentryfactrecord
  BEFORE INSERT OR UPDATE ON "CustomsEntryFactRecord"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();
DROP TRIGGER IF EXISTS "cc_tenant_immutable__CustomsEntryFactRecord" ON "CustomsEntryFactRecord";
CREATE TRIGGER "cc_tenant_immutable__CustomsEntryFactRecord"
  BEFORE UPDATE ON "CustomsEntryFactRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();
DROP TRIGGER IF EXISTS cc_tenant_customsentrydutylinerecord ON "CustomsEntryDutyLineRecord";
CREATE TRIGGER cc_tenant_customsentrydutylinerecord
  BEFORE INSERT OR UPDATE ON "CustomsEntryDutyLineRecord"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('factId', 'CustomsEntryFactRecord');
DROP TRIGGER IF EXISTS "cc_tenant_immutable__CustomsEntryDutyLineRecord" ON "CustomsEntryDutyLineRecord";
CREATE TRIGGER "cc_tenant_immutable__CustomsEntryDutyLineRecord"
  BEFORE UPDATE ON "CustomsEntryDutyLineRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- ---------- append-only evidence snapshot（UPDATE / DELETE 一律拒绝）----------
CREATE OR REPLACE FUNCTION cc_customs_entry_fact_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CUSTOMS_ENTRY_FACT_APPEND_ONLY: % is not allowed on append-only evidence facts', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "cc_append_only__CustomsEntryFactRecord" ON "CustomsEntryFactRecord";
CREATE TRIGGER "cc_append_only__CustomsEntryFactRecord"
  BEFORE UPDATE OR DELETE ON "CustomsEntryFactRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_customs_entry_fact_append_only();

CREATE OR REPLACE FUNCTION cc_customs_entry_duty_line_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CUSTOMS_ENTRY_DUTY_LINE_APPEND_ONLY: % is not allowed on append-only duty lines', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "cc_append_only__CustomsEntryDutyLineRecord" ON "CustomsEntryDutyLineRecord";
CREATE TRIGGER "cc_append_only__CustomsEntryDutyLineRecord"
  BEFORE UPDATE OR DELETE ON "CustomsEntryDutyLineRecord"
  FOR EACH ROW EXECUTE FUNCTION cc_customs_entry_duty_line_append_only();

-- 迁移不使用 DISABLE TRIGGER；不写任何凭据 / 资金字段。
