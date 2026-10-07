-- ============================================================
-- CrossClaim — AEL FINAL2 / C2（审计裁决 MSG-20261007-01 CHANGE 2）
-- OAuthAuthorizationSession：数据库级状态迁移守卫
--   允许：PENDING → CONSUMED；PENDING → FAILED；CONSUMED → SUCCEEDED；CONSUMED → FAILED
--   禁止：PENDING → SUCCEEDED（必须先经一次性消费）、终态再迁移、终态绑定改写
-- ============================================================

CREATE OR REPLACE FUNCTION "cc_oauth_session_transition_guard"()
RETURNS TRIGGER AS $$
BEGIN
  -- 终态绑定不可改写（即使状态不变）
  IF OLD."status" = 'SUCCEEDED'
     AND (NEW."connectionId" IS DISTINCT FROM OLD."connectionId"
          OR NEW."credentialRef" IS DISTINCT FROM OLD."credentialRef")
  THEN
    RAISE EXCEPTION 'OAUTH_SESSION_BINDING_IMMUTABLE: terminal success binding must not be rewritten';
  END IF;

  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'PENDING' AND NEW."status" = 'CONSUMED' THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'PENDING' AND NEW."status" = 'FAILED' THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'CONSUMED' AND NEW."status" IN ('SUCCEEDED','FAILED') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'OAUTH_SESSION_INVALID_TRANSITION: % -> % is forbidden', OLD."status", NEW."status";
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_oauth_session_transition__OAuthAuthorizationSession" ON "OAuthAuthorizationSession";
CREATE TRIGGER "cc_oauth_session_transition__OAuthAuthorizationSession"
  BEFORE UPDATE ON "OAuthAuthorizationSession"
  FOR EACH ROW EXECUTE FUNCTION "cc_oauth_session_transition_guard"();

-- 回滚（人工）：DROP TRIGGER / DROP FUNCTION
