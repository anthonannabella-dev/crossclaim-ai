-- ============================================================
-- CrossClaim — R46 S1 / M2 —— 租户保护触发器
-- ------------------------------------------------------------
-- a) 4 新表：归属不可变（BEFORE UPDATE, tgtype 19）
-- b) 4 新表：跨租户引用拒绝（BEFORE INSERT OR UPDATE, tgtype 23）
-- c) 新增 FK 列的租户守卫（Settlement / FeeCalculation 既有表）
-- 依据：MSG-20261002-54 = PASS WITH REVISE（R46-B §11 S1 实施口径）。
-- 边界：零资金业务行为 —— 不创建 Settlement / receipt / reversal / Fee / Invoice，不改 RecoveryLedger。
-- ============================================================

-- ---------- a) 归属不可变 ----------
DROP TRIGGER IF EXISTS "cc_tenant_immutable__SettlementReceiptSnapshot" ON "SettlementReceiptSnapshot";
DROP TRIGGER IF EXISTS cc_tenant_immutable__settlementreceiptsnapshot ON "SettlementReceiptSnapshot";
CREATE TRIGGER "cc_tenant_immutable__SettlementReceiptSnapshot"
  BEFORE UPDATE ON "SettlementReceiptSnapshot"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__SettlementAdjustment" ON "SettlementAdjustment";
DROP TRIGGER IF EXISTS cc_tenant_immutable__settlementadjustment ON "SettlementAdjustment";
CREATE TRIGGER "cc_tenant_immutable__SettlementAdjustment"
  BEFORE UPDATE ON "SettlementAdjustment"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__FeeCalculationSettlement" ON "FeeCalculationSettlement";
DROP TRIGGER IF EXISTS cc_tenant_immutable__feecalculationsettlement ON "FeeCalculationSettlement";
CREATE TRIGGER "cc_tenant_immutable__FeeCalculationSettlement"
  BEFORE UPDATE ON "FeeCalculationSettlement"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__FeeCalculationAdjustment" ON "FeeCalculationAdjustment";
DROP TRIGGER IF EXISTS cc_tenant_immutable__feecalculationadjustment ON "FeeCalculationAdjustment";
CREATE TRIGGER "cc_tenant_immutable__FeeCalculationAdjustment"
  BEFORE UPDATE ON "FeeCalculationAdjustment"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- ---------- b) 表级租户完整性 ----------
DROP TRIGGER IF EXISTS cc_tenant_settlementreceiptsnapshot ON "SettlementReceiptSnapshot";
CREATE TRIGGER cc_tenant_settlementreceiptsnapshot
  BEFORE INSERT OR UPDATE ON "SettlementReceiptSnapshot"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS cc_tenant_settlementadjustment ON "SettlementAdjustment";
CREATE TRIGGER cc_tenant_settlementadjustment
  BEFORE INSERT OR UPDATE ON "SettlementAdjustment"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS cc_tenant_feecalculationsettlement ON "FeeCalculationSettlement";
CREATE TRIGGER cc_tenant_feecalculationsettlement
  BEFORE INSERT OR UPDATE ON "FeeCalculationSettlement"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS cc_tenant_feecalculationadjustment ON "FeeCalculationAdjustment";
CREATE TRIGGER cc_tenant_feecalculationadjustment
  BEFORE INSERT OR UPDATE ON "FeeCalculationAdjustment"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

-- ---------- c) FK 租户守卫 ----------
DROP TRIGGER IF EXISTS cc_tenant_settlement_claimitemid ON "Settlement";
CREATE TRIGGER cc_tenant_settlement_claimitemid
  BEFORE INSERT OR UPDATE ON "Settlement"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('claimItemId', 'ClaimItem');

DROP TRIGGER IF EXISTS cc_tenant_settlement_receiptsnapshotid ON "Settlement";
CREATE TRIGGER cc_tenant_settlement_receiptsnapshotid
  BEFORE INSERT OR UPDATE ON "Settlement"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('receiptSnapshotId', 'SettlementReceiptSnapshot');

DROP TRIGGER IF EXISTS cc_tenant_feecalculation_claimitemid ON "FeeCalculation";
CREATE TRIGGER cc_tenant_feecalculation_claimitemid
  BEFORE INSERT OR UPDATE ON "FeeCalculation"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('claimItemId', 'ClaimItem');

DROP TRIGGER IF EXISTS cc_tenant_feecalculation_feechainrootfeecalculationid ON "FeeCalculation";
CREATE TRIGGER cc_tenant_feecalculation_feechainrootfeecalculationid
  BEFORE INSERT OR UPDATE ON "FeeCalculation"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('feeChainRootFeeCalculationId', 'FeeCalculation');

DROP TRIGGER IF EXISTS cc_tenant_feecalculation_supersededbyfeecalculationid ON "FeeCalculation";
CREATE TRIGGER cc_tenant_feecalculation_supersededbyfeecalculationid
  BEFORE INSERT OR UPDATE ON "FeeCalculation"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('supersededByFeeCalculationId', 'FeeCalculation');

DROP TRIGGER IF EXISTS cc_tenant_settlementreceiptsnapshot_claimitemid ON "SettlementReceiptSnapshot";
CREATE TRIGGER cc_tenant_settlementreceiptsnapshot_claimitemid
  BEFORE INSERT OR UPDATE ON "SettlementReceiptSnapshot"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('claimItemId', 'ClaimItem');

DROP TRIGGER IF EXISTS cc_tenant_settlementadjustment_originalsettlementid ON "SettlementAdjustment";
CREATE TRIGGER cc_tenant_settlementadjustment_originalsettlementid
  BEFORE INSERT OR UPDATE ON "SettlementAdjustment"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('originalSettlementId', 'Settlement');

DROP TRIGGER IF EXISTS cc_tenant_feecalculationsettlement_feecalculationid ON "FeeCalculationSettlement";
CREATE TRIGGER cc_tenant_feecalculationsettlement_feecalculationid
  BEFORE INSERT OR UPDATE ON "FeeCalculationSettlement"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('feeCalculationId', 'FeeCalculation');

DROP TRIGGER IF EXISTS cc_tenant_feecalculationsettlement_settlementid ON "FeeCalculationSettlement";
CREATE TRIGGER cc_tenant_feecalculationsettlement_settlementid
  BEFORE INSERT OR UPDATE ON "FeeCalculationSettlement"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('settlementId', 'Settlement');

DROP TRIGGER IF EXISTS cc_tenant_feecalculationsettlement_adjustmentid ON "FeeCalculationSettlement";
CREATE TRIGGER cc_tenant_feecalculationsettlement_adjustmentid
  BEFORE INSERT OR UPDATE ON "FeeCalculationSettlement"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('adjustmentId', 'SettlementAdjustment');

DROP TRIGGER IF EXISTS cc_tenant_feecalculationadjustment_targetfeecalculationid ON "FeeCalculationAdjustment";
CREATE TRIGGER cc_tenant_feecalculationadjustment_targetfeecalculationid
  BEFORE INSERT OR UPDATE ON "FeeCalculationAdjustment"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('targetFeeCalculationId', 'FeeCalculation');

