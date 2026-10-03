-- ============================================================
-- CrossClaim — R46 S4-A membership concurrency boundary
-- ------------------------------------------------------------
-- 依据：MSG-20261002-61（PASS WITH REVISE）CHANGE A REQUIRED
--   A = 数据库 correctness boundary：`feeChainId` 服务端派生 + 部分唯一索引
--   B = 受保护写路径 transaction-scoped advisory lock（纵深防御，不在本迁移）
-- 边界：仅 membership concurrency boundary；不改 FeeCalculation 历史语义 /
--   Settlement / SettlementAdjustment / BillingInvoice / Payment / RecoveryLedger / R13。
-- ============================================================

-- 1) 冗余持久化不可变的 chain identity
ALTER TABLE "FeeCalculationSettlement" ADD COLUMN IF NOT EXISTS "feeChainId" TEXT;

-- 2) server-side backfill（append-only / immutability 触发器期间必须临时禁用）
ALTER TABLE "FeeCalculationSettlement" DISABLE TRIGGER USER;

UPDATE "FeeCalculationSettlement" m
   SET "feeChainId" = f."feeChainId"
  FROM "FeeCalculation" f
 WHERE f."id" = m."feeCalculationId"
   AND m."feeChainId" IS NULL;

ALTER TABLE "FeeCalculationSettlement" ENABLE TRIGGER USER;

-- 3) 回填校验：不得存在 null / mismatch（fail-closed，回滚整个迁移）
DO $$
DECLARE
  bad_null integer;
  bad_mismatch integer;
BEGIN
  SELECT count(*) INTO bad_null
    FROM "FeeCalculationSettlement" m
    LEFT JOIN "FeeCalculation" f ON f."id" = m."feeCalculationId"
   WHERE m."feeChainId" IS NULL AND f."feeChainId" IS NOT NULL;

  SELECT count(*) INTO bad_mismatch
    FROM "FeeCalculationSettlement" m
    JOIN "FeeCalculation" f ON f."id" = m."feeCalculationId"
   WHERE m."feeChainId" IS DISTINCT FROM f."feeChainId";

  IF bad_null > 0 OR bad_mismatch > 0 THEN
    RAISE EXCEPTION 'FEE_CHAIN_BACKFILL_FAILED null=% mismatch=%', bad_null, bad_mismatch
      USING ERRCODE = '23514';
  END IF;
END
$$;

-- 4) 派生守卫：membership.feeChainId 只能来自父 FeeCalculation（客户端不得提供或覆盖）
CREATE OR REPLACE FUNCTION cc_feemembership_chain_derive() RETURNS trigger AS $$
DECLARE
  derived text;
BEGIN
  SELECT f."feeChainId" INTO derived
    FROM "FeeCalculation" f
   WHERE f."id" = NEW."feeCalculationId"
     AND f."organizationId" = NEW."organizationId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'FEE_CHAIN_NOT_FOUND'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."feeChainId" IS NOT NULL AND NEW."feeChainId" IS DISTINCT FROM derived THEN
    RAISE EXCEPTION 'FEE_CHAIN_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  NEW."feeChainId" := derived;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_feemembership_chain_derive ON "FeeCalculationSettlement";
CREATE TRIGGER cc_feemembership_chain_derive
  BEFORE INSERT ON "FeeCalculationSettlement"
  FOR EACH ROW EXECUTE FUNCTION cc_feemembership_chain_derive();

-- 5) 真正的并发边界：部分唯一索引（不是全局 UNIQUE(org, settlementId)）
CREATE UNIQUE INDEX IF NOT EXISTS "FeeCalculationSettlement_org_chain_settlement_key"
  ON "FeeCalculationSettlement" ("organizationId", "feeChainId", "settlementId")
  WHERE "settlementId" IS NOT NULL AND "feeChainId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "FeeCalculationSettlement_org_chain_adjustment_key"
  ON "FeeCalculationSettlement" ("organizationId", "feeChainId", "adjustmentId")
  WHERE "adjustmentId" IS NOT NULL AND "feeChainId" IS NOT NULL;
