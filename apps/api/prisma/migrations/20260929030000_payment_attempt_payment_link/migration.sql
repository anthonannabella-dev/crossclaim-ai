-- ============================================================
-- CrossClaim — C-0010-B2 addendum：执行尝试 → 付款事实 的链路（纯增量）
-- ------------------------------------------------------------
-- MSG-20260928-92/94：给 PaymentProcessingAttempt 增加可空 paymentId。
--   · FK → Payment(id) ON DELETE SET NULL（attempt 是执行审计历史，不随 Payment 消失；
--     删除 Payment 本身仍是受控动作，需 OWNER/ADMIN + 审计 + 财务语义确认）
--   · 部分唯一索引：一个 Payment 最多一个成功执行来源（只限 SUCCEEDED）
--   · 租户完整性：attempt 的 paymentId 必须与 attempt 同租户（触发器 21 → 22）
-- 不改 PaymentEvent / Payment / BillingInvoice / Settlement 结构。
-- ============================================================

ALTER TABLE "PaymentProcessingAttempt" ADD COLUMN "paymentId" TEXT;

ALTER TABLE "PaymentProcessingAttempt" ADD CONSTRAINT "PaymentProcessingAttempt_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 一个 Payment 最多一个成功执行来源（失败 / 进行中的 attempt 不占用）
CREATE UNIQUE INDEX "PaymentProcessingAttempt_succeeded_payment_key"
  ON "PaymentProcessingAttempt"("organizationId", "paymentId")
  WHERE "status" = 'SUCCEEDED' AND "paymentId" IS NOT NULL;

DROP TRIGGER IF EXISTS cc_tenant_PaymentProcessingAttempt_paymentId ON "PaymentProcessingAttempt";
CREATE TRIGGER cc_tenant_PaymentProcessingAttempt_paymentId
  BEFORE INSERT OR UPDATE ON "PaymentProcessingAttempt"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('paymentId', 'Payment');
