-- ============================================================
-- CrossClaim — R43 Implementation S1 / M4
-- append-only（整行不可修改/删除）触发器
-- ------------------------------------------------------------
-- 依据：MSG-20261001-31 CHANGE A + MSG-20261001-32 CHANGE A
--   * RecoveryPackageArtifact / RecoveryManualSubmission /
--     RecoveryManualSubmissionReference / RecoveryManualSubmissionEvidence
--     一律 append-only；
--   * provider case reference 补录**不得**在 append-only 的 Submission 上 UPDATE，
--     必须写入独立表 RecoveryManualSubmissionReference（附录事实）。
-- 命名纪律：cc_append_only__ 前缀**不**进入 required-triggers.json（租户清单），
--   由独立的 append-only checklist（tools/tenant-triggers/append-only-triggers.json）覆盖。
-- ============================================================

CREATE OR REPLACE FUNCTION cc_recovery_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_TABLE: % rejects %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_append_only__RecoveryPackageArtifact" ON "RecoveryPackageArtifact";
CREATE TRIGGER "cc_append_only__RecoveryPackageArtifact"
  BEFORE UPDATE OR DELETE ON "RecoveryPackageArtifact"
  FOR EACH ROW EXECUTE FUNCTION cc_recovery_append_only();

DROP TRIGGER IF EXISTS "cc_append_only__RecoveryManualSubmission" ON "RecoveryManualSubmission";
CREATE TRIGGER "cc_append_only__RecoveryManualSubmission"
  BEFORE UPDATE OR DELETE ON "RecoveryManualSubmission"
  FOR EACH ROW EXECUTE FUNCTION cc_recovery_append_only();

DROP TRIGGER IF EXISTS "cc_append_only__RecoveryManualSubmissionReference" ON "RecoveryManualSubmissionReference";
CREATE TRIGGER "cc_append_only__RecoveryManualSubmissionReference"
  BEFORE UPDATE OR DELETE ON "RecoveryManualSubmissionReference"
  FOR EACH ROW EXECUTE FUNCTION cc_recovery_append_only();

DROP TRIGGER IF EXISTS "cc_append_only__RecoveryManualSubmissionEvidence" ON "RecoveryManualSubmissionEvidence";
CREATE TRIGGER "cc_append_only__RecoveryManualSubmissionEvidence"
  BEFORE UPDATE OR DELETE ON "RecoveryManualSubmissionEvidence"
  FOR EACH ROW EXECUTE FUNCTION cc_recovery_append_only();

-- 回滚（人工）：
--   DROP TRIGGER IF EXISTS "cc_append_only__<Table>" ON "<Table>";  ×4
--   DROP FUNCTION IF EXISTS cc_recovery_append_only();
