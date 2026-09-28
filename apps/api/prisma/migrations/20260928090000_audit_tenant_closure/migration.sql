-- ============================================================
-- CrossClaim · 审计的租户闭合（C-0003 Checkpoint 1 · CHANGE #24）
-- ------------------------------------------------------------
-- 两处遗漏：
--   1. AuditLog.organizationId 仍可空 → 数据库层允许"无租户审计"，
--      与应用层"审计必须归属租户"的约定不一致。
--   2. USER actor 只校验了 User 存在，没校验该用户属于该租户 →
--      理论上可写入"Tenant A 的审计 + Tenant B 的用户"。
--
-- 处理：
--   - organizationId 收紧为 NOT NULL（平台级日志将来单开表，不共用本表）
--   - 新增触发器：USER actor 必须在该 organizationId 下存在 Membership
--     （沿用既有 tenant integrity 体系的触发器范式）
-- ============================================================

ALTER TABLE "AuditLog" ALTER COLUMN "organizationId" SET NOT NULL;

CREATE OR REPLACE FUNCTION crossclaim_assert_audit_actor_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."actorType" = 'USER' AND NEW."actorUserId" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
        FROM "Membership" m
       WHERE m."organizationId" = NEW."organizationId"
         AND m."userId" = NEW."actorUserId"
    ) THEN
      RAISE EXCEPTION
        'audit actor membership violation: user % is not a member of organization %',
        NEW."actorUserId", NEW."organizationId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'cc_audit_actor_membership') THEN
    CREATE TRIGGER cc_audit_actor_membership
      BEFORE INSERT OR UPDATE ON "AuditLog"
      FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_audit_actor_membership();
  END IF;
END
$$;
