-- ============================================================
-- CrossClaim — R46 S1 / M4 —— 资金域不变量
-- ------------------------------------------------------------
-- a) Settlement 到账依据不可漂移（MSG-20261002-54 CHANGE B）
-- b) v1 full reversal 等额/同币种（CHANGE B1）
-- c) fee chain 内资金事实唯一（CHANGE A / F3 修正）
-- d) FeeCalculationAdjustment VOID 等额（CHANGE C1 / 三分类）
-- 依据：MSG-20261002-54 = PASS WITH REVISE（R46-B §11 S1 实施口径）。
-- 边界：零资金业务行为 —— 不创建 Settlement / receipt / reversal / Fee / Invoice，不改 RecoveryLedger。
-- ============================================================

-- ---------- a) Settlement 到账依据不可漂移 ----------
CREATE OR REPLACE FUNCTION cc_settlement_receipt_basis_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."receiptSnapshotId" IS DISTINCT FROM NEW."receiptSnapshotId"
     AND OLD."receiptSnapshotId" IS NOT NULL THEN
    RAISE EXCEPTION 'SETTLEMENT_RECEIPT_BASIS_IMMUTABLE'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."externalIdentityValueHash" IS DISTINCT FROM NEW."externalIdentityValueHash"
     AND OLD."externalIdentityValueHash" IS NOT NULL THEN
    RAISE EXCEPTION 'SETTLEMENT_EXTERNAL_IDENTITY_IMMUTABLE'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."financialEventFingerprint" IS DISTINCT FROM NEW."financialEventFingerprint"
     AND OLD."financialEventFingerprint" IS NOT NULL THEN
    RAISE EXCEPTION 'SETTLEMENT_FINGERPRINT_IMMUTABLE'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_settlement_receipt_basis_immutable ON "Settlement";
CREATE TRIGGER cc_settlement_receipt_basis_immutable
  BEFORE UPDATE ON "Settlement"
  FOR EACH ROW EXECUTE FUNCTION cc_settlement_receipt_basis_immutable();

-- ---------- b) v1 full reversal：等额 + 同币种 + 同租户 ----------
CREATE OR REPLACE FUNCTION cc_settlementadjustment_full_reversal_guard() RETURNS trigger AS $$
DECLARE
  orig "Settlement"%ROWTYPE;
BEGIN
  SELECT * INTO orig FROM "Settlement" WHERE "id" = NEW."originalSettlementId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVERSAL_ORIGINAL_SETTLEMENT_NOT_FOUND'
      USING ERRCODE = '23514';
  END IF;
  IF orig."organizationId" IS DISTINCT FROM NEW."organizationId" THEN
    RAISE EXCEPTION 'REVERSAL_CROSS_TENANT'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."adjustmentKind" = 'REVERSAL' AND NEW."amount" IS DISTINCT FROM orig."amount" THEN
    RAISE EXCEPTION 'REVERSAL_AMOUNT_MISMATCH'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."currency" IS DISTINCT FROM orig."currency" THEN
    RAISE EXCEPTION 'REVERSAL_CURRENCY_MISMATCH'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_settlementadjustment_full_reversal_guard ON "SettlementAdjustment";
CREATE TRIGGER cc_settlementadjustment_full_reversal_guard
  BEFORE INSERT ON "SettlementAdjustment"
  FOR EACH ROW EXECUTE FUNCTION cc_settlementadjustment_full_reversal_guard();

-- ---------- c) fee chain 内资金事实唯一 ----------
CREATE OR REPLACE FUNCTION cc_feecalculationsettlement_chain_unique() RETURNS trigger AS $$
DECLARE
  chain text;
  dup_count integer;
BEGIN
  SELECT "feeChainId" INTO chain FROM "FeeCalculation"
   WHERE "id" = NEW."feeCalculationId" AND "organizationId" = NEW."organizationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FEE_CHAIN_NOT_FOUND'
      USING ERRCODE = '23514';
  END IF;
  IF chain IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."settlementId" IS NOT NULL THEN
    SELECT count(*) INTO dup_count
      FROM "FeeCalculationSettlement" m
      JOIN "FeeCalculation" f ON f."id" = m."feeCalculationId"
     WHERE m."organizationId" = NEW."organizationId"
       AND m."settlementId" IS NOT NULL
       AND m."settlementId" = NEW."settlementId"
       AND f."feeChainId" = chain;
    IF dup_count > 0 THEN
      RAISE EXCEPTION 'FEE_CHAIN_SETTLEMENT_ALREADY_CONSUMED'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."adjustmentId" IS NOT NULL THEN
    SELECT count(*) INTO dup_count
      FROM "FeeCalculationSettlement" m
      JOIN "FeeCalculation" f ON f."id" = m."feeCalculationId"
     WHERE m."organizationId" = NEW."organizationId"
       AND m."adjustmentId" IS NOT NULL
       AND m."adjustmentId" = NEW."adjustmentId"
       AND f."feeChainId" = chain;
    IF dup_count > 0 THEN
      RAISE EXCEPTION 'FEE_CHAIN_ADJUSTMENT_ALREADY_CONSUMED'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_feecalculationsettlement_chain_unique ON "FeeCalculationSettlement";
CREATE TRIGGER cc_feecalculationsettlement_chain_unique
  BEFORE INSERT ON "FeeCalculationSettlement"
  FOR EACH ROW EXECUTE FUNCTION cc_feecalculationsettlement_chain_unique();

-- ---------- d) FeeCalculationAdjustment：VOID 等额 ----------
CREATE OR REPLACE FUNCTION cc_feecalculationadjustment_void_amount() RETURNS trigger AS $$
DECLARE
  target_amount numeric;
BEGIN
  IF NEW."adjustmentKind" <> 'VOID' THEN
    RETURN NEW;
  END IF;
  SELECT "feeAmount" INTO target_amount FROM "FeeCalculation"
   WHERE "id" = NEW."targetFeeCalculationId" AND "organizationId" = NEW."organizationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FEE_ADJUSTMENT_TARGET_NOT_FOUND'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."amount" IS DISTINCT FROM target_amount THEN
    RAISE EXCEPTION 'FEE_VOID_AMOUNT_MISMATCH'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_feecalculationadjustment_void_amount ON "FeeCalculationAdjustment";
CREATE TRIGGER cc_feecalculationadjustment_void_amount
  BEFORE INSERT ON "FeeCalculationAdjustment"
  FOR EACH ROW EXECUTE FUNCTION cc_feecalculationadjustment_void_amount();
