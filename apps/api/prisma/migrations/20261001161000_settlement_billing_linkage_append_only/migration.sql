-- ============================================================
-- CrossClaim — R46 S1 / M3 —— append-only
-- ------------------------------------------------------------
-- 4 新表：BEFORE UPDATE OR DELETE → 拒绝（tgtype 27）
-- 依据：MSG-20261002-54 = PASS WITH REVISE（R46-B §11 S1 实施口径）。
-- 边界：零资金业务行为 —— 不创建 Settlement / receipt / reversal / Fee / Invoice，不改 RecoveryLedger。
-- ============================================================

CREATE OR REPLACE FUNCTION cc_money_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_TABLE: % rejects %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_append_only__SettlementReceiptSnapshot" ON "SettlementReceiptSnapshot";
CREATE TRIGGER "cc_append_only__SettlementReceiptSnapshot"
  BEFORE UPDATE OR DELETE ON "SettlementReceiptSnapshot"
  FOR EACH ROW EXECUTE FUNCTION cc_money_append_only();

DROP TRIGGER IF EXISTS "cc_append_only__SettlementAdjustment" ON "SettlementAdjustment";
CREATE TRIGGER "cc_append_only__SettlementAdjustment"
  BEFORE UPDATE OR DELETE ON "SettlementAdjustment"
  FOR EACH ROW EXECUTE FUNCTION cc_money_append_only();

DROP TRIGGER IF EXISTS "cc_append_only__FeeCalculationSettlement" ON "FeeCalculationSettlement";
CREATE TRIGGER "cc_append_only__FeeCalculationSettlement"
  BEFORE UPDATE OR DELETE ON "FeeCalculationSettlement"
  FOR EACH ROW EXECUTE FUNCTION cc_money_append_only();

DROP TRIGGER IF EXISTS "cc_append_only__FeeCalculationAdjustment" ON "FeeCalculationAdjustment";
CREATE TRIGGER "cc_append_only__FeeCalculationAdjustment"
  BEFORE UPDATE OR DELETE ON "FeeCalculationAdjustment"
  FOR EACH ROW EXECUTE FUNCTION cc_money_append_only();

