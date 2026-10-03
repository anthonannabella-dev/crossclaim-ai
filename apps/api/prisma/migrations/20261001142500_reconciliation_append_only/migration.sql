-- ============================================================
-- CrossClaim — R45 S1 / M3
-- append-only（整行不可修改/删除）+ ExpectedRecoveryBasis 受控 supersede
-- ------------------------------------------------------------
-- 依据：MSG-20261001-45 CHANGE C + MSG-20261001-46 Q1
--   * ProviderOutcomeFact / ReimbursementFact / ReconciliationOverrideDecision 一律 append-only；
--   * ExpectedRecoveryBasis 永久保留，仅允许**受控 supersede**：
--     只允许 supersededAt 由 NULL 置为非空、同时写入 supersededByBasisId（一次、单向）；
--     其它任何列变更一律拒绝（不得在到账后反向改写已生效基准）。
-- 命名纪律：cc_append_only__ 前缀**不**进入 required-triggers.json（租户清单），
--   由 tools/tenant-triggers/append-only-triggers.json 独立覆盖（同批更新，否则 CI 反向校验失败）。
-- ============================================================

CREATE OR REPLACE FUNCTION cc_reconciliation_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_TABLE: % rejects %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_append_only__ProviderOutcomeFact" ON "ProviderOutcomeFact";
CREATE TRIGGER "cc_append_only__ProviderOutcomeFact"
  BEFORE UPDATE OR DELETE ON "ProviderOutcomeFact"
  FOR EACH ROW EXECUTE FUNCTION cc_reconciliation_append_only();

DROP TRIGGER IF EXISTS "cc_append_only__ReimbursementFact" ON "ReimbursementFact";
CREATE TRIGGER "cc_append_only__ReimbursementFact"
  BEFORE UPDATE OR DELETE ON "ReimbursementFact"
  FOR EACH ROW EXECUTE FUNCTION cc_reconciliation_append_only();

DROP TRIGGER IF EXISTS "cc_append_only__ReconciliationOverrideDecision" ON "ReconciliationOverrideDecision";
CREATE TRIGGER "cc_append_only__ReconciliationOverrideDecision"
  BEFORE UPDATE OR DELETE ON "ReconciliationOverrideDecision"
  FOR EACH ROW EXECUTE FUNCTION cc_reconciliation_append_only();

-- ExpectedRecoveryBasis：受控 supersede（白名单 = supersededAt / supersededByBasisId）
CREATE OR REPLACE FUNCTION cc_expectedrecoverybasis_guard_supersede() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EXPECTED_RECOVERY_BASIS_REJECTS_DELETE'
      USING ERRCODE = '23514';
  END IF;

  -- 白名单之外的一切列变化一律拒绝
  IF OLD."id"                      IS DISTINCT FROM NEW."id"
     OR OLD."organizationId"       IS DISTINCT FROM NEW."organizationId"
     OR OLD."claimItemId"          IS DISTINCT FROM NEW."claimItemId"
     OR OLD."caseId"               IS DISTINCT FROM NEW."caseId"
     OR OLD."expectedRecoveryAmount" IS DISTINCT FROM NEW."expectedRecoveryAmount"
     OR OLD."currency"             IS DISTINCT FROM NEW."currency"
     OR OLD."basisKind"            IS DISTINCT FROM NEW."basisKind"
     OR OLD."basisVersion"         IS DISTINCT FROM NEW."basisVersion"
     OR OLD."basisSource"          IS DISTINCT FROM NEW."basisSource"
     OR OLD."effectiveAt"          IS DISTINCT FROM NEW."effectiveAt"
     OR OLD."createdByUserId"      IS DISTINCT FROM NEW."createdByUserId"
     OR OLD."createdAt"            IS DISTINCT FROM NEW."createdAt"
  THEN
    RAISE EXCEPTION 'EXPECTED_RECOVERY_BASIS_CORE_IMMUTABLE: %', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;

  -- supersede 一次、单向：NULL -> 非空；且必须同时给出 supersededByBasisId
  IF OLD."supersededAt" IS NOT NULL THEN
    RAISE EXCEPTION 'EXPECTED_RECOVERY_BASIS_ALREADY_SUPERSEDED'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."supersededAt" IS NULL THEN
    RAISE EXCEPTION 'EXPECTED_RECOVERY_BASIS_SUPERSEDE_REQUIRES_TIMESTAMP'
      USING ERRCODE = '23514';
  END IF;
  IF OLD."supersededByBasisId" IS NOT NULL
     OR NEW."supersededByBasisId" IS NULL
     OR NEW."supersededByBasisId" = NEW."id"
  THEN
    RAISE EXCEPTION 'EXPECTED_RECOVERY_BASIS_SUPERSEDE_REQUIRES_SUCCESSOR'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_expectedrecoverybasis_controlled_supersede ON "ExpectedRecoveryBasis";
CREATE TRIGGER cc_expectedrecoverybasis_controlled_supersede
  BEFORE UPDATE OR DELETE ON "ExpectedRecoveryBasis"
  FOR EACH ROW EXECUTE FUNCTION cc_expectedrecoverybasis_guard_supersede();

-- 回滚（人工）：
--   DROP TRIGGER IF EXISTS <name> ON <table>;  ×4
--   DROP FUNCTION IF EXISTS cc_reconciliation_append_only();
--   DROP FUNCTION IF EXISTS cc_expectedrecoverybasis_guard_supersede();
