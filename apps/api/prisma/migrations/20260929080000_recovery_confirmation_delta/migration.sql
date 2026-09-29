-- MSG-20260929-26 批准的 Recovery Confirmation Schema Delta（R1a / R1b / R2a / R4 + RecoveryPayout + 索引）
-- 性质：纯扩展。新增 2 个 TYPE、4 个 ADD COLUMN、1 张表、5 个索引。
-- 已批准的前提：**不新增/不修改任何触发器**（迁移后仍应为 27 个 cc_tenant% 触发器）。
-- 金额口径零改动：不改 FeeCalculation / RecoveryLedgerEntry / BillingInvoice；不含任何资金动作（D5 HOLD）。

-- R1a / R1b：把「业务确认」与「到账对账」拆成两个互不覆盖的状态轴（MSG-20260929-24 的 C1）
CREATE TYPE "SettlementConfirmationStatus" AS ENUM ('CONFIRMED', 'PENDING_CONFIRMATION', 'REJECTED_BY_REVIEW');
CREATE TYPE "SettlementReconciliationStatus" AS ENUM ('NOT_STARTED', 'PARTIAL', 'RECONCILED', 'DISPUTED', 'REVERSED');

-- 历史行默认：CONFIRMED（历史回收都经过人工确认）+ NOT_STARTED（当时无到账数据）→ 无需回填
ALTER TABLE "Settlement" ADD COLUMN "confirmationStatus" "SettlementConfirmationStatus" NOT NULL DEFAULT 'CONFIRMED';
ALTER TABLE "Settlement" ADD COLUMN "reconciliationStatus" "SettlementReconciliationStatus" NOT NULL DEFAULT 'NOT_STARTED';
-- R2a：业务确认留痕（R2b 的 confirmedAt 已存在于 Settlement，不重复新增，避免第二个时间事实源）
ALTER TABLE "Settlement" ADD COLUMN "confirmedByUserId" TEXT;
-- R4：冲回链（不删除原记录；冲回后的财务处置由 FINANCE 人工处理，D3）
ALTER TABLE "Settlement" ADD COLUMN "reversedBySettlementId" TEXT;

-- 索引：运营「待人工确认」视图 / 财务「待对账、部分到账、争议」视图
CREATE INDEX "Settlement_organizationId_confirmationStatus_idx" ON "Settlement"("organizationId", "confirmationStatus");
CREATE INDEX "Settlement_organizationId_reconciliationStatus_idx" ON "Settlement"("organizationId", "reconciliationStatus");

-- RecoveryPayout：到账事实的**唯一来源**（金额只存在这里；receivedAmount 为投影，不落库）
CREATE TABLE "RecoveryPayout" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "payoutRef" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "sourceType" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryPayout_pkey" PRIMARY KEY ("id")
);

-- I6：同一租户内 payoutRef 唯一（幂等键；不同租户可存在同名引用）
CREATE UNIQUE INDEX "RecoveryPayout_organizationId_payoutRef_key" ON "RecoveryPayout"("organizationId", "payoutRef");
-- C-0002 CHANGE #2 契约：tenant-owned 表一律具备 (organizationId, id) 复合唯一键
CREATE UNIQUE INDEX "RecoveryPayout_organizationId_id_key" ON "RecoveryPayout"("organizationId", "id");
-- D4：按期间扫描到账，与既有 payment-reconciliation 差异层比对
CREATE INDEX "RecoveryPayout_organizationId_receivedAt_idx" ON "RecoveryPayout"("organizationId", "receivedAt");
CREATE INDEX "RecoveryPayout_organizationId_settlementId_idx" ON "RecoveryPayout"("organizationId", "settlementId");

ALTER TABLE "RecoveryPayout" ADD CONSTRAINT "RecoveryPayout_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecoveryPayout" ADD CONSTRAINT "RecoveryPayout_settlementId_fkey"
    FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_reversedBySettlementId_fkey"
    FOREIGN KEY ("reversedBySettlementId") REFERENCES "Settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ------------------------------------------------------------------
-- 迁移后校验（MSG-20260929-26 要求）
--   1) 触发器数量仍为 27：
--      select count(*) from pg_trigger where tgname like 'cc_tenant%';
--   2) 历史 Settlement 计数一致（默认值不得漏行）：
--      select count(*) from "Settlement"
--      where "confirmationStatus" <> 'CONFIRMED' or "reconciliationStatus" <> 'NOT_STARTED';
--      -- 期望：0
--
-- 回滚（人工执行；新表存到账记录，**回滚前必须先导出**）：
--   1) 先回滚应用代码（恢复对 Settlement 旧列的读写）；
--   2) ALTER TABLE "Settlement" DROP CONSTRAINT "Settlement_reversedBySettlementId_fkey";
--   3) DROP TABLE "RecoveryPayout";
--   4) DROP INDEX "Settlement_organizationId_reconciliationStatus_idx";
--      DROP INDEX "Settlement_organizationId_confirmationStatus_idx";
--   5) ALTER TABLE "Settlement" DROP COLUMN "reversedBySettlementId";
--      ALTER TABLE "Settlement" DROP COLUMN "confirmedByUserId";
--      ALTER TABLE "Settlement" DROP COLUMN "reconciliationStatus";
--      ALTER TABLE "Settlement" DROP COLUMN "confirmationStatus";
--   6) DROP TYPE "SettlementReconciliationStatus";
--      DROP TYPE "SettlementConfirmationStatus";
-- ------------------------------------------------------------------
