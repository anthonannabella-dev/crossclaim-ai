-- ============================================================
-- CrossClaim — TRACK C2 / MSG-20261002-67 CHANGE
-- ------------------------------------------------------------
-- PlatformAccount 的业务身份必须在创建后不可修改：
--   platform / externalAccountId / identityVersion
-- （既有 cc_tenant_immutable__PlatformAccount 只阻止 organizationId 被改。）
-- displayName / status / marketplace / region 仍允许按生命周期合法更新。
--
-- 为什么需要 DB 层：M4 已把 platformAccountId 下推到 SourceTransaction /
-- CanonicalFact / RecoveryOpportunity / ClaimItem / EvidenceArtifact。
-- 允许原地改写 identity 三元组，等于在不修改历史事实的前提下改变这些事实
-- 所代表的外部账户身份，破坏 reconnect 与 Claim/Evidence/Settlement provenance。
-- 边界：不改 Payment；不启用 autopay；R13 HOLD；TRANSPORT=false。
-- ============================================================

CREATE OR REPLACE FUNCTION cc_forbid_platform_account_identity_change() RETURNS trigger AS $$
BEGIN
  IF NEW."platform" IS DISTINCT FROM OLD."platform"
     OR NEW."externalAccountId" IS DISTINCT FROM OLD."externalAccountId"
     OR NEW."identityVersion" IS DISTINCT FROM OLD."identityVersion" THEN
    RAISE EXCEPTION 'PLATFORM_ACCOUNT_IDENTITY_IMMUTABLE: %.platform/externalAccountId/identityVersion', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_platformaccount_identity_immutable ON "PlatformAccount";
CREATE TRIGGER cc_platformaccount_identity_immutable
  BEFORE UPDATE ON "PlatformAccount"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_platform_account_identity_change();

-- 迁移不使用任何 DISABLE TRIGGER。
