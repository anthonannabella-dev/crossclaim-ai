-- ============================================================
-- CrossClaim — TRACK B BATCH 3 / MSG-20261002-77（B3-1 + B3-4 / DB safety）
-- ------------------------------------------------------------
-- 不变量：SourceConnection 不得以 ACTIVE + platformAccountId = NULL 存在。
-- ACTIVE 表示连接可用于 ingest / sync；未绑定账户的连接没有 canonical provenance，
-- 因此 DB 层拒绝「创建或首次转为 ACTIVE 但未绑定 PlatformAccount」的行。
--
-- 范围刻意做窄：
--   · 只在 INSERT，或 UPDATE 使 status 从未 ACTIVE 变为 ACTIVE 时检查；
--   · 不追溯既有 legacy ACTIVE + NULL 行（它们由 TRACK B BATCH 1/2 的 runtime gate
--     与 legacy READ-ONLY FROZEN 策略治理，不由本次迁移批量改写）；
--   · 不引入新状态字段；连接状态语义仍由现有 SourceConnectionStatus + platformAccountId 表达。
--
-- 已绑定值不可再改由既有 cc_account_binding_immutable__SourceConnection 承担（B3-6）；
-- legacy NULL → account 的一次性追认由 service 层受控路径执行。
-- 边界：NO platform write · Payment = 0 · R13 HOLD · TRANSPORT=false · 无生产凭据。
-- ============================================================

CREATE OR REPLACE FUNCTION cc_sourceconnection_active_requires_account() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'ACTIVE' AND NEW."platformAccountId" IS NULL THEN
    IF TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'PLATFORM_ACCOUNT_REQUIRED: SourceConnection ACTIVE 需要绑定 PlatformAccount'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_sourceconnection_active_requires_account ON "SourceConnection";
CREATE TRIGGER cc_sourceconnection_active_requires_account
  BEFORE INSERT OR UPDATE ON "SourceConnection"
  FOR EACH ROW EXECUTE FUNCTION cc_sourceconnection_active_requires_account();

-- 迁移不使用任何 DISABLE TRIGGER。
