-- ============================================================
-- CrossClaim — HISTORICAL_RECOVERY_SCAN_V1 / PHASE 2（HOST 2026-10-08 授权）
-- Durable 历史追回扫描范围：RecoveryScanRun
--   * 只承载 server-owned scan scope / coverage / progress / checkpoint；
--     业务事实仍走既有 CanonicalFact / Opportunity / Case / Evidence / Claim 链（**不是**第二事实源）。
--   * 身份确定性：dedupeKey / scanDigest 由 goal+domain+provider+account+区间+policy 决定，不含 transient timestamp；
--     UNIQUE(organizationId, dedupeKey) 保证同一范围不产生第二个 scan。
--   * 租户保护：cc_tenant_recoveryscanrun（基线 + goalId → AgentGoal 同租户）+ cc_tenant_immutable__*。
-- tenant 清单同步：tools/tenant-triggers/required-triggers.json
-- ============================================================

CREATE TABLE "RecoveryScanRun" (
  "id"                   TEXT         NOT NULL,
  "organizationId"       TEXT         NOT NULL,
  "goalId"               TEXT         NOT NULL,
  "goalDigest"           TEXT         NOT NULL,
  "domain"               TEXT         NOT NULL,
  "provider"             TEXT,
  "platformAccountId"    TEXT,
  "requestedFrom"        TIMESTAMP(3) NOT NULL,
  "requestedTo"          TIMESTAMP(3) NOT NULL,
  "effectiveFrom"        TIMESTAMP(3) NOT NULL,
  "effectiveTo"          TIMESTAMP(3) NOT NULL,
  "requestedMonths"      INTEGER      NOT NULL,
  "scanPolicyVersion"    TEXT         NOT NULL,
  "shardGrain"           TEXT         NOT NULL DEFAULT 'MONTHLY',
  "status"               TEXT         NOT NULL DEFAULT 'CREATED',
  "coverageStart"        TIMESTAMP(3),
  "coverageEnd"          TIMESTAMP(3),
  "sourceCoverageStatus" TEXT         NOT NULL DEFAULT 'UNKNOWN',
  "shardsTotal"          INTEGER      NOT NULL DEFAULT 0,
  "shardsCompleted"      INTEGER      NOT NULL DEFAULT 0,
  "nextShardIndex"       INTEGER      NOT NULL DEFAULT 0,
  "shardCursor"          TEXT,
  "recordsScanned"       INTEGER      NOT NULL DEFAULT 0,
  "recordsAccepted"      INTEGER      NOT NULL DEFAULT 0,
  "recordsRejected"      INTEGER      NOT NULL DEFAULT 0,
  "opportunitiesFound"   INTEGER      NOT NULL DEFAULT 0,
  "eligibleFound"        INTEGER      NOT NULL DEFAULT 0,
  "expiredFound"         INTEGER      NOT NULL DEFAULT 0,
  "needsEvidenceFound"   INTEGER      NOT NULL DEFAULT 0,
  "reasonCodes"          JSONB,
  "scanDigest"           TEXT         NOT NULL,
  "dedupeKey"            TEXT         NOT NULL,
  "leaseOwner"           TEXT,
  "leaseExpiresAt"       TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3) NOT NULL,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  "completedAt"          TIMESTAMP(3),
  CONSTRAINT "RecoveryScanRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RecoveryScanRun_status_chk" CHECK (
    "status" IN ('CREATED','RUNNING','PARTIAL','BLOCKED','COMPLETED','FAILED')
  ),
  CONSTRAINT "RecoveryScanRun_domain_chk" CHECK (
    "domain" IN ('PLATFORM','LOGISTICS','CUSTOMS','INDEPENDENT_SITE')
  ),
  CONSTRAINT "RecoveryScanRun_coverage_chk" CHECK (
    "sourceCoverageStatus" IN ('FULL','PARTIAL','SOURCE_LIMITED','UNKNOWN')
  ),
  CONSTRAINT "RecoveryScanRun_range_chk" CHECK ("effectiveFrom" <= "effectiveTo"),
  CONSTRAINT "RecoveryScanRun_requested_chk" CHECK ("requestedFrom" <= "requestedTo"),
  CONSTRAINT "RecoveryScanRun_months_chk" CHECK ("requestedMonths" >= 1 AND "requestedMonths" <= 60),
  CONSTRAINT "RecoveryScanRun_progress_chk" CHECK (
    "shardsCompleted" >= 0 AND "nextShardIndex" >= 0 AND "recordsScanned" >= 0
  ),
  CONSTRAINT "RecoveryScanRun_terminal_chk" CHECK (
    ("status" IN ('COMPLETED','FAILED','BLOCKED') AND "completedAt" IS NOT NULL)
    OR ("status" IN ('CREATED','RUNNING','PARTIAL') AND "completedAt" IS NULL)
  )
);

CREATE UNIQUE INDEX "RecoveryScanRun_organizationId_dedupeKey_key"
  ON "RecoveryScanRun"("organizationId", "dedupeKey");
CREATE UNIQUE INDEX "RecoveryScanRun_organizationId_id_key"
  ON "RecoveryScanRun"("organizationId", "id");
CREATE INDEX "RecoveryScanRun_goal_domain_idx"
  ON "RecoveryScanRun"("organizationId", "goalId", "domain");
CREATE INDEX "RecoveryScanRun_status_idx"
  ON "RecoveryScanRun"("organizationId", "status", "updatedAt");

-- ---------- 身份不可改写（范围 / 覆盖口径不得就地重写） ----------
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
     OR NEW."requestedMonths"   IS DISTINCT FROM OLD."requestedMonths"
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

-- ---------- tenant 保护（基线 + 归属不可变） ----------
DROP TRIGGER IF EXISTS "cc_tenant_recoveryscanrun" ON "RecoveryScanRun";
CREATE TRIGGER "cc_tenant_recoveryscanrun"
  BEFORE INSERT OR UPDATE ON "RecoveryScanRun"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('goalId', 'AgentGoal');

DROP TRIGGER IF EXISTS "cc_tenant_immutable__RecoveryScanRun" ON "RecoveryScanRun";
CREATE TRIGGER "cc_tenant_immutable__RecoveryScanRun"
  BEFORE UPDATE ON "RecoveryScanRun"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- 回滚（人工）：DROP TRIGGER / DROP FUNCTION / DROP TABLE（见上）
