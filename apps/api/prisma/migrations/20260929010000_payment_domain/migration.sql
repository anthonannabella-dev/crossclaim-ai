-- ============================================================
-- CrossClaim · C-0010-A Payment domain（纯增量）
-- ------------------------------------------------------------
-- 新增：PaymentStatus / PaymentEventResult 枚举、Payment / PaymentEvent 表
-- 不改：BillingInvoice 结构、Settlement
-- 租户完整性：Payment.invoiceId → BillingInvoice 必须同租户（复用既有触发器函数）
-- 说明：PaymentEvent 无跨表引用，因此不需要租户完整性触发器（当前总数 19 → 20）
-- ============================================================

CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');
CREATE TYPE "PaymentEventResult" AS ENUM ('PROCESSED', 'IGNORED', 'REJECTED', 'DUPLICATE');

CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalPaymentId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingResult" "PaymentEventResult" NOT NULL,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Payment_organizationId_provider_externalPaymentId_key" ON "Payment"("organizationId", "provider", "externalPaymentId");
CREATE UNIQUE INDEX "Payment_organizationId_id_key" ON "Payment"("organizationId", "id");
CREATE INDEX "Payment_organizationId_status_idx" ON "Payment"("organizationId", "status");
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");

CREATE UNIQUE INDEX "PaymentEvent_provider_providerEventId_key" ON "PaymentEvent"("provider", "providerEventId");
CREATE UNIQUE INDEX "PaymentEvent_organizationId_id_key" ON "PaymentEvent"("organizationId", "id");
CREATE INDEX "PaymentEvent_organizationId_receivedAt_idx" ON "PaymentEvent"("organizationId", "receivedAt");

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 租户完整性：支付记录必须与账单同租户
DROP TRIGGER IF EXISTS cc_tenant_Payment_invoiceId ON "Payment";
CREATE TRIGGER cc_tenant_Payment_invoiceId
  BEFORE INSERT OR UPDATE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('invoiceId', 'BillingInvoice');
