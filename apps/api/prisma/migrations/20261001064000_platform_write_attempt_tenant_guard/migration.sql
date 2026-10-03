-- ============================================================
-- CrossClaim — PlatformWriteAttempt 租户保护触发器（S1/M1 补正）
-- ------------------------------------------------------------
-- 背景：M1（20261001062736）只建了枚举 + 表；CI 的 tenant-trigger 清单校验
--       要求每张含 organizationId 的表都必须有：
--         a) cc_tenant_<table>（BEFORE INSERT OR UPDATE，crossclaim_assert_tenant_integrity）
--         b) cc_tenant_immutable__<Table>（BEFORE UPDATE，cc_forbid_tenant_reassignment）
--       「动态挂载」块（20260930100000）早于本表存在，因此必须显式补挂。
-- 性质：纯新增触发器；零数据改动、零既有对象改动。
-- ============================================================

-- a) 租户完整性：唯一外键指向租户根 Organization，无跨表 tenant 引用
DROP TRIGGER IF EXISTS cc_tenant_platform_write_attempt ON "PlatformWriteAttempt";
CREATE TRIGGER cc_tenant_platform_write_attempt
  BEFORE INSERT OR UPDATE ON "PlatformWriteAttempt"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

-- a2) 归属不可变函数：B2 迁移（20260930100000）在「pre-B2 → B2」两阶段升级场景下可能尚未应用，
--     因此本迁移自带同 body 的幂等定义（CREATE OR REPLACE），保证单独 deploy 也能自洽。
CREATE OR REPLACE FUNCTION cc_forbid_tenant_reassignment() RETURNS trigger AS $$
BEGIN
  IF OLD."organizationId" IS DISTINCT FROM NEW."organizationId" THEN
    RAISE EXCEPTION 'TENANT_REASSIGNMENT_FORBIDDEN: %', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- b) 归属不可变：organizationId 不允许在 UPDATE 时变更
--    注意：触发器名必须与清单规则 3 完全一致（cc_tenant_immutable__<表名>，混合大小写），
--    因此标识符必须加双引号，否则 Postgres 会折叠为小写。
DROP TRIGGER IF EXISTS "cc_tenant_immutable__PlatformWriteAttempt" ON "PlatformWriteAttempt";
DROP TRIGGER IF EXISTS cc_tenant_immutable__platformwriteattempt ON "PlatformWriteAttempt";
CREATE TRIGGER "cc_tenant_immutable__PlatformWriteAttempt"
  BEFORE UPDATE ON "PlatformWriteAttempt"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- 回滚（人工）：
--   DROP TRIGGER IF EXISTS cc_tenant_platform_write_attempt ON "PlatformWriteAttempt";
--   DROP TRIGGER IF EXISTS "cc_tenant_immutable__PlatformWriteAttempt" ON "PlatformWriteAttempt";
