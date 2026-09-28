-- ============================================================
-- CrossClaim — C-0010-B2 guards：把已批准的成功不变量下沉到数据库
-- ------------------------------------------------------------
-- MSG-20260928-94 REVISE-2 / MSG-20260928-96：
--   1. SUCCEEDED 必须带 paymentId（否则不算「成功执行」）；
--   2. SUCCEEDED 之后禁止改绑 paymentId / 改状态 / 换事件（执行历史不可改写）。
-- 只新增约束与触发器，不改任何表结构、不加列。
-- 该触发器命名为 cc_payment_...，不计入 cc_tenant_* 的 22 个租户触发器。
-- ============================================================

ALTER TABLE "PaymentProcessingAttempt"
  ADD CONSTRAINT "PaymentProcessingAttempt_succeeded_requires_payment"
  CHECK ("status" <> 'SUCCEEDED' OR "paymentId" IS NOT NULL);

CREATE OR REPLACE FUNCTION crossclaim_payment_attempt_immutable_success()
RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'SUCCEEDED' THEN
    IF NEW."status" <> OLD."status"
       OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId"
       OR NEW."paymentEventId" <> OLD."paymentEventId" THEN
      RAISE EXCEPTION 'payment attempt % is immutable once SUCCEEDED', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_payment_attempt_immutable_success ON "PaymentProcessingAttempt";
CREATE TRIGGER cc_payment_attempt_immutable_success
  BEFORE UPDATE ON "PaymentProcessingAttempt"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_payment_attempt_immutable_success();
