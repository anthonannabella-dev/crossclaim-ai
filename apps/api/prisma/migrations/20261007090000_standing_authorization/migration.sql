-- ============================================================
-- CrossClaim — AGENT EXPERIENCE LAYER / P0（HOST 2026-10-07 授权）
-- Standing Authorization 最小持久化（追加式版本 + 撤销留痕 + tenant/account scoped）
--   * 1 表，无新增枚举；不建第二套 approval / authorization
--   * scope 字段写后不可改（修正以新 authorizationVersion 行表达）
--   * 撤销必须留痕（状态词表 + CHECK 约束）
-- tenant 保护：cc_tenant_standingauthorization 基线 + cc_tenant_immutable__StandingAuthorization
-- 清单同步：tools/tenant-triggers/required-triggers.json / append-only-triggers.json
-- 依据：docs/releases/STANDING-AUTHORIZATION-PERSISTENCE-DELTA-REQUEST.md
-- ============================================================

CREATE TABLE "StandingAuthorization" (
  "id"                   TEXT          NOT NULL,
  "organizationId"       TEXT          NOT NULL,
  "platformAccountId"    TEXT          NOT NULL,
  "provider"             TEXT          NOT NULL,
  "allowedActionTypes"   JSONB         NOT NULL,
  "monetaryLimitUsd"     DECIMAL(18,4) NOT NULL,
  "currency"             TEXT          NOT NULL,
  "domain"               TEXT          NOT NULL,
  "jurisdiction"         TEXT          NOT NULL,
  "effectiveAt"          TIMESTAMP(3)  NOT NULL,
  "expiresAt"            TIMESTAMP(3)  NOT NULL,
  "authorizationVersion" INTEGER       NOT NULL,
  "termsPolicyVersion"   TEXT          NOT NULL,
  "consentEvidenceRef"   TEXT          NOT NULL,
  "revocationState"      TEXT          NOT NULL DEFAULT 'ACTIVE',
  "revokedAt"            TIMESTAMP(3),
  "revokedBy"            TEXT,
  "revocationReason"     TEXT,
  "scopeDigest"          TEXT          NOT NULL,
  "createdAt"            TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "StandingAuthorization_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StandingAuthorization_limit_chk" CHECK ("monetaryLimitUsd" >= 0),
  CONSTRAINT "StandingAuthorization_version_chk" CHECK ("authorizationVersion" >= 1),
  CONSTRAINT "StandingAuthorization_state_chk" CHECK (
    "revocationState" IN ('ACTIVE','REVOKED','SUSPENDED')
  ),
  CONSTRAINT "StandingAuthorization_digest_chk" CHECK (length("scopeDigest") = 64),
  CONSTRAINT "StandingAuthorization_window_chk" CHECK ("expiresAt" > "effectiveAt"),
  CONSTRAINT "StandingAuthorization_actions_chk" CHECK (
    jsonb_typeof("allowedActionTypes") = 'array' AND jsonb_array_length("allowedActionTypes") > 0
  ),
  CONSTRAINT "StandingAuthorization_revocation_chk" CHECK (
    ("revocationState" = 'ACTIVE'
       AND "revokedAt" IS NULL AND "revokedBy" IS NULL AND "revocationReason" IS NULL)
    OR ("revocationState" <> 'ACTIVE'
       AND "revokedAt" IS NOT NULL AND "revokedBy" IS NOT NULL AND length("revokedBy") > 0)
  )
);

CREATE UNIQUE INDEX "StandingAuthorization_scope_version_key"
  ON "StandingAuthorization"("organizationId", "platformAccountId", "provider", "authorizationVersion");
CREATE UNIQUE INDEX "StandingAuthorization_organizationId_id_key"
  ON "StandingAuthorization"("organizationId", "id");
CREATE INDEX "StandingAuthorization_scope_state_idx"
  ON "StandingAuthorization"("organizationId", "platformAccountId", "provider", "revocationState", "expiresAt");

-- ---------- scope 写后不可改：修正必须追加新的 authorizationVersion 行 ----------
CREATE OR REPLACE FUNCTION "cc_standing_authorization_scope_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."organizationId"        IS DISTINCT FROM OLD."organizationId"
     OR NEW."platformAccountId"  IS DISTINCT FROM OLD."platformAccountId"
     OR NEW."provider"           IS DISTINCT FROM OLD."provider"
     OR NEW."allowedActionTypes" IS DISTINCT FROM OLD."allowedActionTypes"
     OR NEW."monetaryLimitUsd"   IS DISTINCT FROM OLD."monetaryLimitUsd"
     OR NEW."currency"           IS DISTINCT FROM OLD."currency"
     OR NEW."domain"             IS DISTINCT FROM OLD."domain"
     OR NEW."jurisdiction"       IS DISTINCT FROM OLD."jurisdiction"
     OR NEW."effectiveAt"        IS DISTINCT FROM OLD."effectiveAt"
     OR NEW."expiresAt"          IS DISTINCT FROM OLD."expiresAt"
     OR NEW."authorizationVersion" IS DISTINCT FROM OLD."authorizationVersion"
     OR NEW."termsPolicyVersion"   IS DISTINCT FROM OLD."termsPolicyVersion"
     OR NEW."consentEvidenceRef"   IS DISTINCT FROM OLD."consentEvidenceRef"
     OR NEW."scopeDigest"          IS DISTINCT FROM OLD."scopeDigest"
     OR NEW."createdAt"            IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'STANDING_AUTHORIZATION_SCOPE_IMMUTABLE: scope must not be rewritten in place; append a new authorizationVersion';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_standing_auth_scope_immutable__StandingAuthorization" ON "StandingAuthorization";
CREATE TRIGGER "cc_standing_auth_scope_immutable__StandingAuthorization"
  BEFORE UPDATE ON "StandingAuthorization"
  FOR EACH ROW EXECUTE FUNCTION "cc_standing_authorization_scope_immutable"();

-- ---------- tenant 保护（基线 + 归属不可变） ----------
DROP TRIGGER IF EXISTS "cc_tenant_standingauthorization" ON "StandingAuthorization";
CREATE TRIGGER "cc_tenant_standingauthorization"
  BEFORE INSERT OR UPDATE ON "StandingAuthorization"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__StandingAuthorization" ON "StandingAuthorization";
CREATE TRIGGER "cc_tenant_immutable__StandingAuthorization"
  BEFORE UPDATE ON "StandingAuthorization"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- 回滚（人工）：DROP TRIGGER / DROP TABLE（见上）
