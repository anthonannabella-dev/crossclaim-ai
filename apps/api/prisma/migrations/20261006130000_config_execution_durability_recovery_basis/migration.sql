-- ============================================================
-- CrossClaim — P6-PROD-U1 FINAL2（MSG-20261005-94 DURABLE_RECOVERY_BASIS）
-- 目的：把 recovery 的判定依据完整冻结进 durable reservation —— 进程 crash / 重启后，
--   仅凭 DB reservation + server-owned observation 即可重建执行依据，不再依赖 caller 传入的 expectedFor()。
--   * 新增 preConfigVersion 列（来源 = U2 authorization ticket 绑定的 liveConfigVersion）
--   * preConfigVersion 纳入身份不可改写触发器（NEW.preConfigVersion <> OLD.preConfigVersion → 拒绝）
-- 结构安全：不删表 / 不建类型 / 不删数据；只做 ADD COLUMN + 回填 + SET NOT NULL + CHECK。
-- ============================================================

ALTER TABLE "ControlledConfigExecutionReservation" ADD COLUMN "preConfigVersion" TEXT;

-- 既有行（本单元之前创建、且无法再证明 liveConfigVersion）统一标为 UNKNOWN，绝不猜测。
UPDATE "ControlledConfigExecutionReservation"
   SET "preConfigVersion" = 'UNKNOWN'
 WHERE "preConfigVersion" IS NULL;

ALTER TABLE "ControlledConfigExecutionReservation" ALTER COLUMN "preConfigVersion" SET NOT NULL;

ALTER TABLE "ControlledConfigExecutionReservation"
  ADD CONSTRAINT "ControlledConfigExecutionReservation_pre_version_chk"
  CHECK ("preConfigVersion" <> '');

-- 把 preConfigVersion 纳入不可变执行依据（identity 原地改写一律 fail-closed）。
CREATE OR REPLACE FUNCTION cc_config_execution_transition_guard() RETURNS trigger AS $$
DECLARE
  terminal_old boolean;
  allowed boolean;
BEGIN
  IF NEW."reservationKey" <> OLD."reservationKey"
     OR NEW."immutableBasisDigest" <> OLD."immutableBasisDigest"
     OR NEW."authorizationVerdictDigest" <> OLD."authorizationVerdictDigest"
     OR NEW."authorizationTicketDigest" <> OLD."authorizationTicketDigest"
     OR NEW."planDigest" <> OLD."planDigest"
     OR NEW."candidateDigest" <> OLD."candidateDigest"
     OR NEW."proposalDigest" <> OLD."proposalDigest"
     OR NEW."controlledAdoptionDigest" <> OLD."controlledAdoptionDigest"
     OR NEW."rollbackPlanDigest" <> OLD."rollbackPlanDigest"
     OR NEW."baselineSnapshotDigest" <> OLD."baselineSnapshotDigest"
     OR NEW."baselineConfigFingerprint" <> OLD."baselineConfigFingerprint"
     OR NEW."preConfigVersion" <> OLD."preConfigVersion"
     OR NEW."environment" <> OLD."environment"
     OR NEW."executionMode" <> OLD."executionMode"
     OR NEW."target" <> OLD."target"
     OR NEW."configPath" <> OLD."configPath"
     OR NEW."fromValue" <> OLD."fromValue"
     OR NEW."toValue" <> OLD."toValue"
     OR NEW."idempotencyKey" <> OLD."idempotencyKey"
     OR NEW."idempotencyPayloadDigest" <> OLD."idempotencyPayloadDigest"
     OR NEW."reservationExpiresAt" <> OLD."reservationExpiresAt"
     OR NEW."reservedAt" <> OLD."reservedAt"
  THEN
    RAISE EXCEPTION 'CONFIG_EXECUTION_IDENTITY_IMMUTABLE: reservation identity / immutable basis 不可原地改写'
      USING ERRCODE = '23514';
  END IF;

  terminal_old := OLD."status" NOT IN ('RESERVED','EXECUTING');
  IF terminal_old THEN
    RAISE EXCEPTION 'CONFIG_EXECUTION_TERMINAL_IMMUTABLE: terminal(%) 不得再变更', OLD."status"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."status" <> OLD."status" THEN
    allowed := (OLD."status" = 'RESERVED' AND NEW."status" IN ('EXECUTING','CANCELLED','SUPERSEDED'))
      OR (OLD."status" = 'EXECUTING' AND NEW."status" IN (
            'SUCCEEDED','CONFLICT','STALE_BASELINE','NEEDS_RECONCILIATION',
            'FAILED_CONFIRMED','MANUAL_REVIEW','SUPERSEDED','CANCELLED'));
    IF NOT allowed THEN
      RAISE EXCEPTION 'CONFIG_EXECUTION_ILLEGAL_TRANSITION: % -> %', OLD."status", NEW."status"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."executionAttempt" < OLD."executionAttempt" THEN
    RAISE EXCEPTION 'CONFIG_EXECUTION_ATTEMPT_REGRESSION: executionAttempt 不得回退'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 回滚（人工）：
--   ALTER TABLE "ControlledConfigExecutionReservation" DROP COLUMN "preConfigVersion"; 并还原旧 guard 函数
