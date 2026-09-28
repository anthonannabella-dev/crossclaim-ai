-- ============================================================
-- CrossClaim — C-0010-B2 PaymentProcessingAttempt（纯增量）
-- ------------------------------------------------------------
-- 新增 PaymentAttemptStatus 枚举与 PaymentProcessingAttempt 表；
-- 不改 Payment / BillingInvoice / Settlement / PaymentEvent 结构。
-- 租户完整性：attempt 必须与 PaymentEvent 同租户（触发器 20 → 21）。
-- 额外不变量（Prisma 不支持部分唯一索引，用原生 SQL 表达）：
--   同一 (organizationId, paymentEventId) 同一时刻最多一个进行中的 attempt。
-- ============================================================

CREATE TYPE "PaymentAttemptStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'RETRYABLE_FAILED', 'DEAD_LETTER');

CREATE TABLE "PaymentProcessingAttempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "paymentEventId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "resultStatus" TEXT,
    "errorCode" TEXT,
    "errorSummary" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "actorType" TEXT NOT NULL,
    "actorRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentProcessingAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentProcessingAttempt_organizationId_paymentEventId_attemptNo_key" ON "PaymentProcessingAttempt"("organizationId", "paymentEventId", "attemptNo");
CREATE UNIQUE INDEX "PaymentProcessingAttempt_organizationId_id_key" ON "PaymentProcessingAttempt"("organizationId", "id");
CREATE INDEX "PaymentProcessingAttempt_organizationId_status_nextRetryAt_idx" ON "PaymentProcessingAttempt"("organizationId", "status", "nextRetryAt");
CREATE INDEX "PaymentProcessingAttempt_paymentEventId_idx" ON "PaymentProcessingAttempt"("paymentEventId");

-- 同一事件同一时刻最多一个进行中的执行尝试（active execution only）
CREATE UNIQUE INDEX "PaymentProcessingAttempt_active_execution_key"
  ON "PaymentProcessingAttempt"("organizationId", "paymentEventId")
  WHERE "status" IN ('PENDING', 'RUNNING');

ALTER TABLE "PaymentProcessingAttempt" ADD CONSTRAINT "PaymentProcessingAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentProcessingAttempt" ADD CONSTRAINT "PaymentProcessingAttempt_paymentEventId_fkey" FOREIGN KEY ("paymentEventId") REFERENCES "PaymentEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TRIGGER IF EXISTS cc_tenant_PaymentProcessingAttempt_paymentEventId ON "PaymentProcessingAttempt";
CREATE TRIGGER cc_tenant_PaymentProcessingAttempt_paymentEventId
  BEFORE INSERT OR UPDATE ON "PaymentProcessingAttempt"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('paymentEventId', 'PaymentEvent');
