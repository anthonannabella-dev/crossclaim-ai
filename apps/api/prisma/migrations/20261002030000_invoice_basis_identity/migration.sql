-- ============================================================
-- CrossClaim — R46 S5-A invoice basis identity（MSG-20261002-63 PASS WITH REVISE）
-- ------------------------------------------------------------
-- CHANGE A：basis identity 不可复用 —— UNIQUE(org, invoiceBasisDigest) WHERE digest IS NOT NULL
--           （不得用 status <> VOID；VOID 已是历史账单事实，不释放 basis identity）
-- 边界：Payment / autopay / RecoveryLedger / R13 均不触碰。
-- ============================================================

ALTER TABLE "BillingInvoice" ADD COLUMN IF NOT EXISTS "invoiceBasisDigest" TEXT;
ALTER TABLE "BillingInvoice" ADD COLUMN IF NOT EXISTS "invoiceBasisVersion" TEXT;
ALTER TABLE "BillingInvoice" ADD COLUMN IF NOT EXISTS "customerAccountIdentity" TEXT;

-- 历史数据重复审计（fail-closed；不得静默删除/覆盖历史 Invoice）
DO $$
DECLARE
  dup integer;
BEGIN
  SELECT count(*) INTO dup FROM (
    SELECT 1 FROM "BillingInvoice"
     WHERE "invoiceBasisDigest" IS NOT NULL
     GROUP BY "organizationId", "invoiceBasisDigest" HAVING count(*) > 1) x;
  IF dup > 0 THEN
    RAISE EXCEPTION 'INVOICE_BASIS_DUPLICATE_FOUND count=%', dup USING ERRCODE = '23514';
  END IF;
END
$$;

-- basis identity 唯一（VOID 不释放）
CREATE UNIQUE INDEX IF NOT EXISTS "BillingInvoice_org_basis_key"
  ON "BillingInvoice" ("organizationId", "invoiceBasisDigest")
  WHERE "invoiceBasisDigest" IS NOT NULL;

-- v1：一张发票 = 一笔 FeeCalculation（多费聚合 fail-closed）
CREATE UNIQUE INDEX IF NOT EXISTS "FeeCalculation_org_invoice_key"
  ON "FeeCalculation" ("organizationId", "billingInvoiceId")
  WHERE "billingInvoiceId" IS NOT NULL;

-- 发票：basis identity 写一次 + 非 DRAFT 内容不可变 + 状态迁移白名单
CREATE OR REPLACE FUNCTION cc_billinginvoice_issue_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."invoiceBasisDigest" IS NOT NULL
     AND (NEW."invoiceBasisDigest" IS DISTINCT FROM OLD."invoiceBasisDigest"
          OR NEW."invoiceBasisVersion" IS DISTINCT FROM OLD."invoiceBasisVersion"
          OR NEW."customerAccountIdentity" IS DISTINCT FROM OLD."customerAccountIdentity") THEN
    RAISE EXCEPTION 'INVOICE_BASIS_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."invoiceNo" <> OLD."invoiceNo"
       OR NEW."currency" <> OLD."currency"
       OR NEW."subtotal" <> OLD."subtotal"
       OR NEW."taxAmount" <> OLD."taxAmount"
       OR NEW."total" <> OLD."total"
       OR NEW."caseId" IS DISTINCT FROM OLD."caseId" THEN
      RAISE EXCEPTION 'INVOICE_CONTENT_IMMUTABLE_AFTER_ISSUE' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      (OLD."status" = 'DRAFT' AND NEW."status" IN ('ISSUED', 'VOID'))
      OR (OLD."status" = 'ISSUED' AND NEW."status" IN ('PAID', 'PARTIALLY_PAID', 'VOID', 'WRITTEN_OFF'))
      OR (OLD."status" = 'PARTIALLY_PAID' AND NEW."status" IN ('PAID', 'VOID', 'WRITTEN_OFF'))
    ) THEN
      RAISE EXCEPTION 'INVALID_INVOICE_STATUS_TRANSITION' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_billinginvoice_issue_guard ON "BillingInvoice";
CREATE TRIGGER cc_billinginvoice_issue_guard
  BEFORE UPDATE ON "BillingInvoice"
  FOR EACH ROW EXECUTE FUNCTION cc_billinginvoice_issue_guard();

-- FeeCalculation ↔ Invoice：链接写一次 + 币种一致 + 已发行后财务字段不可变
CREATE OR REPLACE FUNCTION cc_feecalculation_invoice_link_guard() RETURNS trigger AS $$
DECLARE
  inv_status text;
  inv_currency text;
BEGIN
  IF OLD."billingInvoiceId" IS NOT NULL AND NEW."billingInvoiceId" IS DISTINCT FROM OLD."billingInvoiceId" THEN
    RAISE EXCEPTION 'FEE_INVOICE_LINK_IMMUTABLE' USING ERRCODE = '23514';
  END IF;

  IF NEW."billingInvoiceId" IS NOT NULL AND NEW."billingInvoiceId" IS DISTINCT FROM OLD."billingInvoiceId" THEN
    SELECT "status", "currency" INTO inv_status, inv_currency
      FROM "BillingInvoice"
     WHERE "id" = NEW."billingInvoiceId" AND "organizationId" = NEW."organizationId";
    IF inv_status IS NULL THEN
      RAISE EXCEPTION 'FEE_INVOICE_LINK_NOT_FOUND' USING ERRCODE = '23514';
    END IF;
    IF inv_currency IS DISTINCT FROM NEW."currency" THEN
      RAISE EXCEPTION 'INVOICE_CURRENCY_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD."billingInvoiceId" IS NOT NULL THEN
    SELECT "status" INTO inv_status FROM "BillingInvoice" WHERE "id" = OLD."billingInvoiceId";
    IF inv_status IS NOT NULL AND inv_status <> 'DRAFT' THEN
      IF NEW."feeAmount" <> OLD."feeAmount"
         OR NEW."currency" <> OLD."currency"
         OR NEW."basis" <> OLD."basis"
         OR NEW."baseAmount" <> OLD."baseAmount"
         OR NEW."rate" IS DISTINCT FROM OLD."rate" THEN
        RAISE EXCEPTION 'FEE_CALCULATION_IMMUTABLE_AFTER_ISSUE' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_feecalculation_invoice_link_guard ON "FeeCalculation";
CREATE TRIGGER cc_feecalculation_invoice_link_guard
  BEFORE UPDATE ON "FeeCalculation"
  FOR EACH ROW EXECUTE FUNCTION cc_feecalculation_invoice_link_guard();
