-- ============================================================
-- CrossClaim — R43 Implementation S1 / M2
-- 人工追回提交 5 张新表的**租户保护触发器**（纯新增；零数据改动）
-- ------------------------------------------------------------
-- 规则来源：tools/tenant-triggers/emit-check-sql.mjs
--   a) 每张含 organizationId 的表必须有 cc_tenant_<table>（BEFORE INSERT OR UPDATE）
--   b) 每个指向 tenant-owned 表的外键必须成对登记 (fk_column, ref_table) 触发器
--   c) 每张含 organizationId 的表必须有 cc_tenant_immutable__<Table>（BEFORE UPDATE，tgtype 19）
-- 清单（tools/tenant-triggers/required-triggers.json）必须与本迁移同批更新，否则 CI 反向校验失败。
-- ============================================================

-- ---------- a) 基线触发器（无 FK 参数） ----------
DROP TRIGGER IF EXISTS cc_tenant_recoverypackage ON "RecoveryPackage";
CREATE TRIGGER cc_tenant_recoverypackage
  BEFORE INSERT OR UPDATE ON "RecoveryPackage"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS cc_tenant_recoverypackageartifact ON "RecoveryPackageArtifact";
CREATE TRIGGER cc_tenant_recoverypackageartifact
  BEFORE INSERT OR UPDATE ON "RecoveryPackageArtifact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS cc_tenant_recoverymanualsubmission ON "RecoveryManualSubmission";
CREATE TRIGGER cc_tenant_recoverymanualsubmission
  BEFORE INSERT OR UPDATE ON "RecoveryManualSubmission"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS cc_tenant_recoverymanualsubmissionreference ON "RecoveryManualSubmissionReference";
CREATE TRIGGER cc_tenant_recoverymanualsubmissionreference
  BEFORE INSERT OR UPDATE ON "RecoveryManualSubmissionReference"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS cc_tenant_recoverymanualsubmissionevidence ON "RecoveryManualSubmissionEvidence";
CREATE TRIGGER cc_tenant_recoverymanualsubmissionevidence
  BEFORE INSERT OR UPDATE ON "RecoveryManualSubmissionEvidence"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

-- ---------- b) FK 级触发器（跨租户引用拒绝） ----------
DROP TRIGGER IF EXISTS cc_tenant_recoverypackage_claimitemid ON "RecoveryPackage";
CREATE TRIGGER cc_tenant_recoverypackage_claimitemid
  BEFORE INSERT OR UPDATE ON "RecoveryPackage"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('claimItemId', 'ClaimItem');

DROP TRIGGER IF EXISTS cc_tenant_recoverypackageartifact_packageid ON "RecoveryPackageArtifact";
CREATE TRIGGER cc_tenant_recoverypackageartifact_packageid
  BEFORE INSERT OR UPDATE ON "RecoveryPackageArtifact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('packageId', 'RecoveryPackage');

DROP TRIGGER IF EXISTS cc_tenant_recoverypackageartifact_fileassetid ON "RecoveryPackageArtifact";
CREATE TRIGGER cc_tenant_recoverypackageartifact_fileassetid
  BEFORE INSERT OR UPDATE ON "RecoveryPackageArtifact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('fileAssetId', 'FileAsset');

DROP TRIGGER IF EXISTS cc_tenant_recoverymanualsubmission_claimitemid ON "RecoveryManualSubmission";
CREATE TRIGGER cc_tenant_recoverymanualsubmission_claimitemid
  BEFORE INSERT OR UPDATE ON "RecoveryManualSubmission"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('claimItemId', 'ClaimItem');

DROP TRIGGER IF EXISTS cc_tenant_recoverymanualsubmission_packageid ON "RecoveryManualSubmission";
CREATE TRIGGER cc_tenant_recoverymanualsubmission_packageid
  BEFORE INSERT OR UPDATE ON "RecoveryManualSubmission"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('packageId', 'RecoveryPackage');

DROP TRIGGER IF EXISTS cc_tenant_recoverymanualsubmissionreference_submissionid ON "RecoveryManualSubmissionReference";
CREATE TRIGGER cc_tenant_recoverymanualsubmissionreference_submissionid
  BEFORE INSERT OR UPDATE ON "RecoveryManualSubmissionReference"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('submissionId', 'RecoveryManualSubmission');

DROP TRIGGER IF EXISTS cc_tenant_recoverymanualsubmissionevidence_submissionid ON "RecoveryManualSubmissionEvidence";
CREATE TRIGGER cc_tenant_recoverymanualsubmissionevidence_submissionid
  BEFORE INSERT OR UPDATE ON "RecoveryManualSubmissionEvidence"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('submissionId', 'RecoveryManualSubmission');

DROP TRIGGER IF EXISTS cc_tenant_recoverymanualsubmissionevidence_evidenceid ON "RecoveryManualSubmissionEvidence";
CREATE TRIGGER cc_tenant_recoverymanualsubmissionevidence_evidenceid
  BEFORE INSERT OR UPDATE ON "RecoveryManualSubmissionEvidence"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('evidenceId', 'EvidenceArtifact');

-- ---------- c) 归属不可变（organizationId 不允许 UPDATE 时变更） ----------
-- 与 B2 / PlatformWriteAttempt 同 body 的幂等定义：保证单独 deploy 也能自洽。
CREATE OR REPLACE FUNCTION cc_forbid_tenant_reassignment() RETURNS trigger AS $$
BEGIN
  IF OLD."organizationId" IS DISTINCT FROM NEW."organizationId" THEN
    RAISE EXCEPTION 'TENANT_REASSIGNMENT_FORBIDDEN: %', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_tenant_immutable__RecoveryPackage" ON "RecoveryPackage";
DROP TRIGGER IF EXISTS cc_tenant_immutable__recoverypackage ON "RecoveryPackage";
CREATE TRIGGER "cc_tenant_immutable__RecoveryPackage"
  BEFORE UPDATE ON "RecoveryPackage"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__RecoveryPackageArtifact" ON "RecoveryPackageArtifact";
DROP TRIGGER IF EXISTS cc_tenant_immutable__recoverypackageartifact ON "RecoveryPackageArtifact";
CREATE TRIGGER "cc_tenant_immutable__RecoveryPackageArtifact"
  BEFORE UPDATE ON "RecoveryPackageArtifact"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__RecoveryManualSubmission" ON "RecoveryManualSubmission";
DROP TRIGGER IF EXISTS cc_tenant_immutable__recoverymanualsubmission ON "RecoveryManualSubmission";
CREATE TRIGGER "cc_tenant_immutable__RecoveryManualSubmission"
  BEFORE UPDATE ON "RecoveryManualSubmission"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__RecoveryManualSubmissionReference" ON "RecoveryManualSubmissionReference";
DROP TRIGGER IF EXISTS cc_tenant_immutable__recoverymanualsubmissionreference ON "RecoveryManualSubmissionReference";
CREATE TRIGGER "cc_tenant_immutable__RecoveryManualSubmissionReference"
  BEFORE UPDATE ON "RecoveryManualSubmissionReference"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__RecoveryManualSubmissionEvidence" ON "RecoveryManualSubmissionEvidence";
DROP TRIGGER IF EXISTS cc_tenant_immutable__recoverymanualsubmissionevidence ON "RecoveryManualSubmissionEvidence";
CREATE TRIGGER "cc_tenant_immutable__RecoveryManualSubmissionEvidence"
  BEFORE UPDATE ON "RecoveryManualSubmissionEvidence"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- 回滚（人工）：
--   DROP TRIGGER IF EXISTS <上述触发器名> ON <表名>;
