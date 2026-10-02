-- ============================================================
-- CrossClaim — TRACK C2 slice 2a / M4-M6（MSG-20261002-66 PASS WITH REVISE）
-- ------------------------------------------------------------
-- M4：account scope 下推（SourceTransaction / CanonicalFact / RecoveryOpportunity /
--     ClaimItem / EvidenceArtifact），全部可空、向后兼容；accountId 由服务端从连接上下文派生。
-- M5：fact identity 账户作用域 —— 唯一性使用结构化字段 (organizationId, accountId, factKey)，
--     不把 account 拼进 factKey；accountId 为 NULL 的 legacy 行继续走 (organizationId, factKey)。
-- M6：回填 fail-closed（唯一推断才回填；不唯一/缺失 → 保持 NULL 并输出 blocker report；重复 → 迁移失败）；
--     DB 不变量：account 绑定写一次 + 跨租户 account 引用守卫。
-- CHANGE B（MSG-20261002-66）：本迁移不依赖 DISABLE TRIGGER —— 先建列 → 回填 → 审计 → 建索引 → 挂触发器。
-- 边界：不改 Payment；不启用 autopay；R13 HOLD；TRANSPORT=false；无生产凭据。
-- ============================================================

-- ---------- 1) account 维度下推（全部可空） ----------
ALTER TABLE "SourceTransaction"   ADD COLUMN IF NOT EXISTS "accountId" TEXT;
ALTER TABLE "CanonicalFact"       ADD COLUMN IF NOT EXISTS "accountId" TEXT;
ALTER TABLE "RecoveryOpportunity" ADD COLUMN IF NOT EXISTS "accountId" TEXT;
ALTER TABLE "ClaimItem"           ADD COLUMN IF NOT EXISTS "accountId" TEXT;
ALTER TABLE "EvidenceArtifact"    ADD COLUMN IF NOT EXISTS "accountId" TEXT;

ALTER TABLE "SourceTransaction"   ADD CONSTRAINT "SourceTransaction_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CanonicalFact"       ADD CONSTRAINT "CanonicalFact_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RecoveryOpportunity" ADD CONSTRAINT "RecoveryOpportunity_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClaimItem"           ADD CONSTRAINT "ClaimItem_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EvidenceArtifact"    ADD CONSTRAINT "EvidenceArtifact_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "SourceTransaction_organizationId_accountId_idx"
  ON "SourceTransaction" ("organizationId","accountId");
CREATE INDEX IF NOT EXISTS "CanonicalFact_organizationId_accountId_idx"
  ON "CanonicalFact" ("organizationId","accountId");
CREATE INDEX IF NOT EXISTS "RecoveryOpportunity_organizationId_accountId_idx"
  ON "RecoveryOpportunity" ("organizationId","accountId");
CREATE INDEX IF NOT EXISTS "ClaimItem_organizationId_accountId_idx"
  ON "ClaimItem" ("organizationId","accountId");
CREATE INDEX IF NOT EXISTS "EvidenceArtifact_organizationId_accountId_idx"
  ON "EvidenceArtifact" ("organizationId","accountId");

-- ---------- 2) 回填：SourceTransaction ← SourceConnection.platformAccountId ----------
-- 服务端连接上下文是唯一可信来源；客户端无法提交 accountId（服务层拒绝）。
UPDATE "SourceTransaction" st
   SET "accountId" = sc."platformAccountId"
  FROM "SourceConnection" sc
 WHERE st."connectionId" = sc."id"
   AND st."accountId" IS NULL
   AND sc."platformAccountId" IS NOT NULL
   AND sc."organizationId" = st."organizationId";

-- ---------- 3) 回填：CanonicalFact ← 其来源行 accountId（唯一且完全一致才推断） ----------
WITH candidates AS (
  SELECT cfs."canonicalFactId"          AS fact_id,
         count(DISTINCT st."accountId") AS account_count,
         min(st."accountId")            AS account_id
    FROM "CanonicalFactSource" cfs
    JOIN "SourceTransaction" st ON st."id" = cfs."sourceTransactionId"
   WHERE st."accountId" IS NOT NULL
   GROUP BY cfs."canonicalFactId"
)
UPDATE "CanonicalFact" cf
   SET "accountId" = candidates.account_id
  FROM candidates
 WHERE cf."id" = candidates.fact_id
   AND cf."accountId" IS NULL
   AND candidates.account_count = 1
   AND NOT EXISTS (
     SELECT 1
       FROM "CanonicalFactSource" cfs
       JOIN "SourceTransaction" st ON st."id" = cfs."sourceTransactionId"
      WHERE cfs."canonicalFactId" = cf."id"
        AND st."accountId" IS NULL
   );

-- ---------- 4) blocker report（不猜测身份；ambiguous / 缺失 → 保持 NULL = legacy） ----------
DO $$
DECLARE
  blocker_count integer;
  blocker_ids   text;
BEGIN
  SELECT count(*), string_agg(x.id, ',')
    INTO blocker_count, blocker_ids
    FROM (
      SELECT cf."id"
        FROM "CanonicalFact" cf
       WHERE cf."accountId" IS NULL
         AND EXISTS (
           SELECT 1
             FROM "CanonicalFactSource" cfs
             JOIN "SourceTransaction" st ON st."id" = cfs."sourceTransactionId"
            WHERE cfs."canonicalFactId" = cf."id"
              AND st."accountId" IS NOT NULL
         )
    ) x;
  IF blocker_count > 0 THEN
    RAISE NOTICE 'ACCOUNT_SCOPE_BACKFILL_BLOCKER count=% ids=%', blocker_count, blocker_ids;
  END IF;
END
$$;

-- ---------- 5) fail-closed 重复审计（禁止静默合并 / 覆盖历史事实） ----------
DO $$
DECLARE
  dup integer;
BEGIN
  SELECT count(*) INTO dup FROM (
    SELECT 1 FROM "CanonicalFact"
     WHERE "accountId" IS NOT NULL
     GROUP BY "organizationId", "accountId", "factKey" HAVING count(*) > 1) x;
  IF dup > 0 THEN
    RAISE EXCEPTION 'ACCOUNT_SCOPE_DUPLICATE_FOUND count=%', dup USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO dup FROM (
    SELECT 1 FROM "CanonicalFact"
     WHERE "accountId" IS NULL
     GROUP BY "organizationId", "factKey" HAVING count(*) > 1) x;
  IF dup > 0 THEN
    RAISE EXCEPTION 'LEGACY_FACT_DUPLICATE_FOUND count=%', dup USING ERRCODE = '23514';
  END IF;
END
$$;

-- ---------- 6) fact identity 索引：结构化 (org, accountId, factKey) + legacy (org, factKey) ----------
DROP INDEX IF EXISTS "CanonicalFact_organizationId_factKey_key";

CREATE UNIQUE INDEX IF NOT EXISTS "CanonicalFact_organizationId_accountId_factKey_key"
  ON "CanonicalFact" ("organizationId","accountId","factKey");

-- legacy 行（accountId IS NULL）继续享受旧的 (org, factKey) 唯一性；
-- 新写入必须带 accountId（服务层），该索引只服务迁移窗口内的历史行。
CREATE UNIQUE INDEX IF NOT EXISTS "CanonicalFact_org_factkey_legacy_key"
  ON "CanonicalFact" ("organizationId","factKey")
  WHERE "accountId" IS NULL;

-- ---------- 7) account 绑定写一次（CHANGE A 的 DB 级不变量） ----------
CREATE OR REPLACE FUNCTION cc_forbid_account_binding_change() RETURNS trigger AS $$
DECLARE
  col     text := TG_ARGV[0];
  old_val text;
  new_val text;
BEGIN
  old_val := to_jsonb(OLD) ->> col;
  new_val := to_jsonb(NEW) ->> col;
  IF old_val IS NOT NULL AND new_val IS DISTINCT FROM old_val THEN
    RAISE EXCEPTION 'ACCOUNT_BINDING_IMMUTABLE: %.%', TG_TABLE_NAME, col
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_account_binding_immutable__SourceConnection" ON "SourceConnection";
DROP TRIGGER IF EXISTS "cc_account_binding_immutable__SourceTransaction" ON "SourceTransaction";
DROP TRIGGER IF EXISTS "cc_account_binding_immutable__CanonicalFact" ON "CanonicalFact";
DROP TRIGGER IF EXISTS "cc_account_binding_immutable__RecoveryOpportunity" ON "RecoveryOpportunity";
DROP TRIGGER IF EXISTS "cc_account_binding_immutable__ClaimItem" ON "ClaimItem";
DROP TRIGGER IF EXISTS "cc_account_binding_immutable__EvidenceArtifact" ON "EvidenceArtifact";

CREATE TRIGGER "cc_account_binding_immutable__SourceConnection"
  BEFORE UPDATE ON "SourceConnection"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_account_binding_change('platformAccountId');

CREATE TRIGGER "cc_account_binding_immutable__SourceTransaction"
  BEFORE UPDATE ON "SourceTransaction"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_account_binding_change('accountId');

CREATE TRIGGER "cc_account_binding_immutable__CanonicalFact"
  BEFORE UPDATE ON "CanonicalFact"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_account_binding_change('accountId');

CREATE TRIGGER "cc_account_binding_immutable__RecoveryOpportunity"
  BEFORE UPDATE ON "RecoveryOpportunity"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_account_binding_change('accountId');

CREATE TRIGGER "cc_account_binding_immutable__ClaimItem"
  BEFORE UPDATE ON "ClaimItem"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_account_binding_change('accountId');

CREATE TRIGGER "cc_account_binding_immutable__EvidenceArtifact"
  BEFORE UPDATE ON "EvidenceArtifact"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_account_binding_change('accountId');

-- ---------- 8) 跨租户 account 引用守卫（account 必须属于同一 organization） ----------
DROP TRIGGER IF EXISTS cc_tenant_sourcetransaction_accountid ON "SourceTransaction";
CREATE TRIGGER cc_tenant_sourcetransaction_accountid
  BEFORE INSERT OR UPDATE ON "SourceTransaction"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('accountId','PlatformAccount');

DROP TRIGGER IF EXISTS cc_tenant_canonicalfact_accountid ON "CanonicalFact";
CREATE TRIGGER cc_tenant_canonicalfact_accountid
  BEFORE INSERT OR UPDATE ON "CanonicalFact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('accountId','PlatformAccount');

DROP TRIGGER IF EXISTS cc_tenant_recoveryopportunity_accountid ON "RecoveryOpportunity";
CREATE TRIGGER cc_tenant_recoveryopportunity_accountid
  BEFORE INSERT OR UPDATE ON "RecoveryOpportunity"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('accountId','PlatformAccount');

DROP TRIGGER IF EXISTS cc_tenant_claimitem_accountid ON "ClaimItem";
CREATE TRIGGER cc_tenant_claimitem_accountid
  BEFORE INSERT OR UPDATE ON "ClaimItem"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('accountId','PlatformAccount');

DROP TRIGGER IF EXISTS cc_tenant_evidenceartifact_accountid ON "EvidenceArtifact";
CREATE TRIGGER cc_tenant_evidenceartifact_accountid
  BEFORE INSERT OR UPDATE ON "EvidenceArtifact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('accountId','PlatformAccount');

-- 迁移不使用任何 DISABLE TRIGGER（CHANGE B：migration ordering 优先）
