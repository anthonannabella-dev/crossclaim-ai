-- B2 修复（MSG-20260930-04 / C-0002 RE-REVIEW = REVISE）
-- 目标：禁止 tenant-owned 对象变更 organizationId；禁止已有 RuleSet 变更所有权身份。
-- 纪律：新增迁移、不改历史迁移；只加约束与触发器，不改数据、不改列。

-- 1) 通用归属不可变：任何含 organizationId 的表，UPDATE 时该列必须保持不变
CREATE OR REPLACE FUNCTION cc_forbid_tenant_reassignment() RETURNS trigger AS $$
BEGIN
  IF OLD."organizationId" IS DISTINCT FROM NEW."organizationId" THEN
    RAISE EXCEPTION 'TENANT_REASSIGNMENT_FORBIDDEN: %', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 动态为当前库中所有含 organizationId 的表挂触发器（幂等：先 DROP IF EXISTS 再建）
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name = c.table_name
     AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = current_schema()
      AND c.column_name = 'organizationId'
      AND c.table_name <> '_prisma_migrations'
    ORDER BY c.table_name
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON %I',
      'cc_tenant_immutable__' || r.table_name,
      r.table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment()',
      'cc_tenant_immutable__' || r.table_name,
      r.table_name
    );
  END LOOP;
END;
$$;

-- 2) RuleSet 所有权身份不可变（禁止 SYSTEM↔TENANT 静默转换）
CREATE OR REPLACE FUNCTION cc_forbid_ruleset_ownership_change() RETURNS trigger AS $$
BEGIN
  IF OLD."ownerType" IS DISTINCT FROM NEW."ownerType"
     OR OLD."ownerKey" IS DISTINCT FROM NEW."ownerKey"
     OR OLD."organizationId" IS DISTINCT FROM NEW."organizationId" THEN
    RAISE EXCEPTION 'RULESET_OWNERSHIP_IMMUTABLE'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_ruleset_ownership_immutable ON "RuleSet";
CREATE TRIGGER cc_ruleset_ownership_immutable
  BEFORE UPDATE ON "RuleSet"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_ruleset_ownership_change();
