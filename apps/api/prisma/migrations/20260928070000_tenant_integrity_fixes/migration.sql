-- ============================================================
-- CrossClaim · 租户完整性修复（C-0002 第二次复审 CHANGE #13 / #14）
-- ------------------------------------------------------------
-- 本迁移补齐两处数据库级漏洞：
--   #13 BillingInvoice 未挂租户校验触发器 → 允许跨租户 caseId 引用
--   #14 RuleSet / RuleVersion 的所有权组合未被数据库约束 →
--       可构造 organizationId 为空的“伪全局 RuleVersion”去引用租户 RuleSet
--
-- 本段属于架构契约 §5.2（数据库级租户强制）的一部分，**不要删除**。
-- 新增 tenant 相关外键时，必须同步在对应 trigger 的 TG_ARGV 中补一对参数。
-- ============================================================

-- ------------------------------------------------------------
-- CHANGE #13：BillingInvoice → Case 必须同租户
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'cc_tenant_BillingInvoice'
  ) THEN
    CREATE TRIGGER cc_tenant_BillingInvoice
      BEFORE INSERT OR UPDATE ON "BillingInvoice"
      FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
        'caseId', 'Case'
      );
  END IF;
END
$$;

-- ------------------------------------------------------------
-- CHANGE #14-a：RuleSet 的所有权组合必须自洽
--   SYSTEM ⇒ organizationId IS NULL 且 ownerKey = 'GLOBAL'
--   TENANT ⇒ organizationId IS NOT NULL 且 ownerKey = organizationId
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cc_ruleset_ownership_check'
  ) THEN
    ALTER TABLE "RuleSet"
      ADD CONSTRAINT cc_ruleset_ownership_check CHECK (
        ("ownerType" = 'SYSTEM' AND "organizationId" IS NULL AND "ownerKey" = 'GLOBAL')
        OR
        ("ownerType" = 'TENANT' AND "organizationId" IS NOT NULL AND "ownerKey" = "organizationId"::text)
      );
  END IF;
END
$$;

-- ------------------------------------------------------------
-- CHANGE #14-b：RuleVersion 必须与所属 RuleSet 的租户归属一致
--   RuleSet = SYSTEM ⇒ RuleVersion.organizationId IS NULL
--   RuleSet = TENANT ⇒ RuleVersion.organizationId = RuleSet.organizationId
--
--   允许 tenant → SYSTEM RuleVersion（RuleEvaluation / RecoveryRoute 需要引用全局规则）
--   禁止 global RuleVersion → TENANT RuleSet
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION crossclaim_assert_ruleversion_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rs_owner_type text;
  rs_org        text;
BEGIN
  SELECT "ownerType"::text, "organizationId"::text
    INTO rs_owner_type, rs_org
    FROM "RuleSet"
   WHERE id = NEW."ruleSetId";

  IF NOT FOUND THEN
    RETURN NEW;  -- 悬空引用由外键负责
  END IF;

  IF rs_owner_type = 'SYSTEM' THEN
    IF NEW."organizationId" IS NOT NULL THEN
      RAISE EXCEPTION
        'rule ownership violation: global RuleSet % cannot be referenced by tenant-owned RuleVersion (organizationId=%)',
        NEW."ruleSetId", NEW."organizationId"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."organizationId" IS DISTINCT FROM rs_org THEN
      RAISE EXCEPTION
        'rule ownership violation: RuleVersion.organizationId (%) must equal RuleSet.organizationId (%)',
        NEW."organizationId", rs_org
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'cc_ruleversion_ownership'
  ) THEN
    CREATE TRIGGER cc_ruleversion_ownership
      BEFORE INSERT OR UPDATE ON "RuleVersion"
      FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_ruleversion_ownership();
  END IF;
END
$$;
