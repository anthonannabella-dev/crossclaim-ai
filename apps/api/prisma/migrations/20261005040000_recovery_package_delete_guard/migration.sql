-- Recovery SI P2-E v1 —— 必修 4：RecoveryPackage 的 DB 层 DELETE guard
-- 依据：MSG-20261005-22（P2-E 设计 = PASS WITH REVISE；Option A 授权），要求
-- "补 RecoveryPackage 的 DB DELETE guard"。既有 tenant 触发器、append-only artifact 触发器
-- 与 RecoveryPackage controlled-mutation 触发器语义保持不变；本迁移只新增 DELETE 拒绝。
-- 说明：删除一律拒绝；修正必须以生命周期表达（SUPERSEDED / WITHDRAWN）。

CREATE OR REPLACE FUNCTION "cc_recovery_package_no_delete"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'RECOVERY_PACKAGE_DELETE_FORBIDDEN: RecoveryPackage rows must not be deleted; use SUPERSEDED/WITHDRAWN lifecycle';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_no_delete__RecoveryPackage" ON "RecoveryPackage";
CREATE TRIGGER "cc_no_delete__RecoveryPackage"
  BEFORE DELETE ON "RecoveryPackage"
  FOR EACH ROW EXECUTE FUNCTION "cc_recovery_package_no_delete"();

CREATE OR REPLACE FUNCTION "cc_recovery_package_artifact_no_delete"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'RECOVERY_PACKAGE_ARTIFACT_DELETE_FORBIDDEN: RecoveryPackageArtifact rows must not be deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_no_delete__RecoveryPackageArtifact" ON "RecoveryPackageArtifact";
CREATE TRIGGER "cc_no_delete__RecoveryPackageArtifact"
  BEFORE DELETE ON "RecoveryPackageArtifact"
  FOR EACH ROW EXECUTE FUNCTION "cc_recovery_package_artifact_no_delete"();
