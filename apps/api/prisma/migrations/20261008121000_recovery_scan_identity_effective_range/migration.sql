-- ============================================================
-- CrossClaim — HISTORICAL_RECOVERY_SCAN_V1 / PHASE 2（修正）
-- RecoveryScanRun 身份不可改写触发器：补上 effectiveFrom / effectiveTo / shardGrain。
-- 原因：首个迁移的触发器函数遗漏了 effective 区间列 —— 而 effective 区间正是
--   「requested vs 数据源覆盖 vs remedy 政策窗口」解析后的**权威扫描范围**，
--   必须与 requested 区间同样不可就地改写（否则 Runtime 读取的 scope 可被悄悄放大）。
-- ============================================================

CREATE OR REPLACE FUNCTION "cc_recovery_scan_identity_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."organizationId"    IS DISTINCT FROM OLD."organizationId"
     OR NEW."goalId"            IS DISTINCT FROM OLD."goalId"
     OR NEW."goalDigest"        IS DISTINCT FROM OLD."goalDigest"
     OR NEW."domain"            IS DISTINCT FROM OLD."domain"
     OR NEW."provider"          IS DISTINCT FROM OLD."provider"
     OR NEW."platformAccountId" IS DISTINCT FROM OLD."platformAccountId"
     OR NEW."requestedFrom"     IS DISTINCT FROM OLD."requestedFrom"
     OR NEW."requestedTo"       IS DISTINCT FROM OLD."requestedTo"
     OR NEW."effectiveFrom"     IS DISTINCT FROM OLD."effectiveFrom"
     OR NEW."effectiveTo"       IS DISTINCT FROM OLD."effectiveTo"
     OR NEW."requestedMonths"   IS DISTINCT FROM OLD."requestedMonths"
     OR NEW."shardGrain"        IS DISTINCT FROM OLD."shardGrain"
     OR NEW."scanPolicyVersion" IS DISTINCT FROM OLD."scanPolicyVersion"
     OR NEW."scanDigest"        IS DISTINCT FROM OLD."scanDigest"
     OR NEW."dedupeKey"         IS DISTINCT FROM OLD."dedupeKey"
     OR NEW."createdAt"         IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'RECOVERY_SCAN_IDENTITY_IMMUTABLE: scan identity must not be rewritten';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_recovery_scan_identity__RecoveryScanRun" ON "RecoveryScanRun";
CREATE TRIGGER "cc_recovery_scan_identity__RecoveryScanRun"
  BEFORE UPDATE ON "RecoveryScanRun"
  FOR EACH ROW EXECUTE FUNCTION "cc_recovery_scan_identity_immutable"();
