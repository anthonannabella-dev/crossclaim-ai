-- ============================================================
-- CrossClaim — R45 S1 / M2
-- Outcome / Reimbursement Reconciliation 七表的**租户保护触发器** + projection 受控更新
-- ------------------------------------------------------------
-- 规则来源：tools/tenant-triggers/emit-check-sql.mjs（清单 required-triggers.json 同批更新）
--   a) 每张含 organizationId 的表必须有 cc_tenant_<table>（BEFORE INSERT OR UPDATE）
--   b) 每个指向 tenant-owned 表的外键必须成对登记 (fk_column, ref_table) 触发器
--   c) 每张含 organizationId 的表必须有 cc_tenant_immutable__<Table>（BEFORE UPDATE，tgtype 19）
-- 受控更新：ClaimReconciliationProjection 是 derived cache，允许受控整体替换，
--   但 organizationId / claimItemId / createdAt 不可变，projectionVersion 单调 +1（CAS）。
-- ============================================================

-- ---------- a) 基线触发器 ----------
DROP TRIGGER IF EXISTS cc_tenant_provideroutcomefact ON "ProviderOutcomeFact";
CREATE TRIGGER cc_tenant_provideroutcomefact
  BEFORE INSERT OR UPDATE ON "ProviderOutcomeFact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS cc_tenant_reimbursementfact ON "ReimbursementFact";
CREATE TRIGGER cc_tenant_reimbursementfact
  BEFORE INSERT OR UPDATE ON "ReimbursementFact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS cc_tenant_expectedrecoverybasis ON "ExpectedRecoveryBasis";
CREATE TRIGGER cc_tenant_expectedrecoverybasis
  BEFORE INSERT OR UPDATE ON "ExpectedRecoveryBasis"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS cc_tenant_reconciliationoverridedecision ON "ReconciliationOverrideDecision";
CREATE TRIGGER cc_tenant_reconciliationoverridedecision
  BEFORE INSERT OR UPDATE ON "ReconciliationOverrideDecision"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS cc_tenant_claimreconciliationprojection ON "ClaimReconciliationProjection";
CREATE TRIGGER cc_tenant_claimreconciliationprojection
  BEFORE INSERT OR UPDATE ON "ClaimReconciliationProjection"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS cc_tenant_claimreconciliationprojectionfact ON "ClaimReconciliationProjectionFact";
CREATE TRIGGER cc_tenant_claimreconciliationprojectionfact
  BEFORE INSERT OR UPDATE ON "ClaimReconciliationProjectionFact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

-- 系统级容差策略（organizationId 可空 = 显式常量记录）：触发器在 NULL 归属时自动跳过
DROP TRIGGER IF EXISTS cc_tenant_reconciliationtolerancepolicy ON "ReconciliationTolerancePolicy";
CREATE TRIGGER cc_tenant_reconciliationtolerancepolicy
  BEFORE INSERT OR UPDATE ON "ReconciliationTolerancePolicy"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

-- ---------- b) FK 级触发器（跨租户引用拒绝） ----------
DROP TRIGGER IF EXISTS cc_tenant_reimbursementfact_reversesfactid ON "ReimbursementFact";
CREATE TRIGGER cc_tenant_reimbursementfact_reversesfactid
  BEFORE INSERT OR UPDATE ON "ReimbursementFact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('reversesFactId', 'ReimbursementFact');

DROP TRIGGER IF EXISTS cc_tenant_expectedrecoverybasis_claimitemid ON "ExpectedRecoveryBasis";
CREATE TRIGGER cc_tenant_expectedrecoverybasis_claimitemid
  BEFORE INSERT OR UPDATE ON "ExpectedRecoveryBasis"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('claimItemId', 'ClaimItem');

DROP TRIGGER IF EXISTS cc_tenant_reconciliationoverridedecision_claimitemid ON "ReconciliationOverrideDecision";
CREATE TRIGGER cc_tenant_reconciliationoverridedecision_claimitemid
  BEFORE INSERT OR UPDATE ON "ReconciliationOverrideDecision"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('claimItemId', 'ClaimItem');

DROP TRIGGER IF EXISTS cc_tenant_reconciliationoverridedecision_reimbursementfactid ON "ReconciliationOverrideDecision";
CREATE TRIGGER cc_tenant_reconciliationoverridedecision_reimbursementfactid
  BEFORE INSERT OR UPDATE ON "ReconciliationOverrideDecision"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('reimbursementFactId', 'ReimbursementFact');

DROP TRIGGER IF EXISTS cc_tenant_claimreconciliationprojection_claimitemid ON "ClaimReconciliationProjection";
CREATE TRIGGER cc_tenant_claimreconciliationprojection_claimitemid
  BEFORE INSERT OR UPDATE ON "ClaimReconciliationProjection"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('claimItemId', 'ClaimItem');

DROP TRIGGER IF EXISTS cc_tenant_claimreconciliationprojectionfact_projectionid ON "ClaimReconciliationProjectionFact";
CREATE TRIGGER cc_tenant_claimreconciliationprojectionfact_projectionid
  BEFORE INSERT OR UPDATE ON "ClaimReconciliationProjectionFact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('projectionId', 'ClaimReconciliationProjection');

DROP TRIGGER IF EXISTS cc_tenant_claimreconciliationprojectionfact_reimbursementfactid ON "ClaimReconciliationProjectionFact";
CREATE TRIGGER cc_tenant_claimreconciliationprojectionfact_reimbursementfactid
  BEFORE INSERT OR UPDATE ON "ClaimReconciliationProjectionFact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('reimbursementFactId', 'ReimbursementFact');

-- ---------- c) 归属不可变（cc_tenant_immutable__<表>，tgtype 19） ----------
DROP TRIGGER IF EXISTS "cc_tenant_immutable__ProviderOutcomeFact" ON "ProviderOutcomeFact";
CREATE TRIGGER "cc_tenant_immutable__ProviderOutcomeFact"
  BEFORE UPDATE ON "ProviderOutcomeFact"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__ReimbursementFact" ON "ReimbursementFact";
CREATE TRIGGER "cc_tenant_immutable__ReimbursementFact"
  BEFORE UPDATE ON "ReimbursementFact"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__ExpectedRecoveryBasis" ON "ExpectedRecoveryBasis";
CREATE TRIGGER "cc_tenant_immutable__ExpectedRecoveryBasis"
  BEFORE UPDATE ON "ExpectedRecoveryBasis"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__ReconciliationOverrideDecision" ON "ReconciliationOverrideDecision";
CREATE TRIGGER "cc_tenant_immutable__ReconciliationOverrideDecision"
  BEFORE UPDATE ON "ReconciliationOverrideDecision"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__ClaimReconciliationProjection" ON "ClaimReconciliationProjection";
CREATE TRIGGER "cc_tenant_immutable__ClaimReconciliationProjection"
  BEFORE UPDATE ON "ClaimReconciliationProjection"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__ClaimReconciliationProjectionFact" ON "ClaimReconciliationProjectionFact";
CREATE TRIGGER "cc_tenant_immutable__ClaimReconciliationProjectionFact"
  BEFORE UPDATE ON "ClaimReconciliationProjectionFact"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__ReconciliationTolerancePolicy" ON "ReconciliationTolerancePolicy";
CREATE TRIGGER "cc_tenant_immutable__ReconciliationTolerancePolicy"
  BEFORE UPDATE ON "ReconciliationTolerancePolicy"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- ---------- d) projection 受控更新（derived cache，非 append-only） ----------
CREATE OR REPLACE FUNCTION cc_reconciliationprojection_guard_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD."organizationId" IS DISTINCT FROM NEW."organizationId"
     OR OLD."claimItemId" IS DISTINCT FROM NEW."claimItemId"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  THEN
    RAISE EXCEPTION 'RECONCILIATION_PROJECTION_IDENTITY_IMMUTABLE: %', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;

  IF NEW."projectionVersion" < OLD."projectionVersion"
     OR NEW."projectionVersion" > OLD."projectionVersion" + 1
  THEN
    RAISE EXCEPTION 'RECONCILIATION_PROJECTION_VERSION_STEP_INVALID: % -> %',
      OLD."projectionVersion", NEW."projectionVersion"
      USING ERRCODE = '23514';
  END IF;

  -- CHANGE A：generation 一致性必须**在同一事务内立即可判定**。
  -- 经实测，Prisma 客户端会吞掉 COMMIT 阶段 deferred 约束的错误（静默回滚、调用方无感），
  -- 因此不使用 DEFERRABLE 约束触发器；改为：提升 projectionVersion 之前必须先删除上一代成员关系。
  IF NEW."projectionVersion" IS DISTINCT FROM OLD."projectionVersion" THEN
    IF EXISTS (
      SELECT 1 FROM "ClaimReconciliationProjectionFact" f
       WHERE f."projectionId" = NEW."id"
         AND f."projectionVersion" <> NEW."projectionVersion"
    ) THEN
      RAISE EXCEPTION 'PROJECTION_MEMBERSHIP_STALE_GENERATION: % (bump to % requires deleting previous generation members first)',
        NEW."id", NEW."projectionVersion"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_reconciliationprojection_controlled_mutation ON "ClaimReconciliationProjection";
CREATE TRIGGER cc_reconciliationprojection_controlled_mutation
  BEFORE UPDATE ON "ClaimReconciliationProjection"
  FOR EACH ROW EXECUTE FUNCTION cc_reconciliationprojection_guard_mutation();

-- 回滚（人工）：
--   DROP TRIGGER IF EXISTS <name> ON <table>;  ×15
--   DROP FUNCTION IF EXISTS cc_reconciliationprojection_guard_mutation();
