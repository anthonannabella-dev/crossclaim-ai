-- ============================================================
-- CrossClaim — R43 Implementation S1 / M3
-- RecoveryPackage：区分「不可变事实」与「受控生命周期状态」
-- ------------------------------------------------------------
-- 依据：MSG-20261001-31 CHANGE A + MSG-20261001-32 CHANGE B
--   * 核心字段（identity / binding / digest / version）UPDATE 一律拒绝；
--   * status 只能通过受控 CAS 修改（服务层保证），且终态不可回退；
--   * EXPORTED **非终态**：重复导出 / 后续审批 / 人工提交均不受阻；
--   * SUPERSEDED / WITHDRAWN 必须带 reason + actor。
-- 允许变更的字段白名单：status / supersededByPackageId / transitionReason /
--   transitionActorUserId / updatedAt。
-- ============================================================

CREATE OR REPLACE FUNCTION cc_recoverypackage_guard_mutation() RETURNS trigger AS $$
BEGIN
  -- 1) 核心字段不可变
  IF OLD."organizationId"        IS DISTINCT FROM NEW."organizationId"
     OR OLD."claimItemId"        IS DISTINCT FROM NEW."claimItemId"
     OR OLD."caseId"             IS DISTINCT FROM NEW."caseId"
     OR OLD."packageVersion"     IS DISTINCT FROM NEW."packageVersion"
     OR OLD."digestVersion"      IS DISTINCT FROM NEW."digestVersion"
     OR OLD."packageDigest"      IS DISTINCT FROM NEW."packageDigest"
     OR OLD."generatedAt"        IS DISTINCT FROM NEW."generatedAt"
     OR OLD."generatedByUserId"  IS DISTINCT FROM NEW."generatedByUserId"
     OR OLD."completenessSnapshot" IS DISTINCT FROM NEW."completenessSnapshot"
     OR OLD."createdAt"          IS DISTINCT FROM NEW."createdAt"
  THEN
    RAISE EXCEPTION 'RECOVERY_PACKAGE_CORE_IMMUTABLE: %', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;

  -- 2) 终态不可回退（SUPERSEDED / WITHDRAWN 之后状态不得再变）
  IF OLD."status" IN ('SUPERSEDED', 'WITHDRAWN')
     AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'RECOVERY_PACKAGE_TERMINAL_STATE: % -> %', OLD."status", NEW."status"
      USING ERRCODE = '23514';
  END IF;

  -- 3) 进入终态必须带 reason + actor（EXPORTED 非终态，不要求）
  IF NEW."status" IN ('SUPERSEDED', 'WITHDRAWN')
     AND (NEW."transitionReason" IS NULL OR NEW."transitionActorUserId" IS NULL) THEN
    RAISE EXCEPTION 'RECOVERY_PACKAGE_TRANSITION_EVIDENCE_REQUIRED'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_recoverypackage_controlled_mutation ON "RecoveryPackage";
CREATE TRIGGER cc_recoverypackage_controlled_mutation
  BEFORE UPDATE ON "RecoveryPackage"
  FOR EACH ROW EXECUTE FUNCTION cc_recoverypackage_guard_mutation();

-- 回滚（人工）：
--   DROP TRIGGER IF EXISTS cc_recoverypackage_controlled_mutation ON "RecoveryPackage";
--   DROP FUNCTION IF EXISTS cc_recoverypackage_guard_mutation();
