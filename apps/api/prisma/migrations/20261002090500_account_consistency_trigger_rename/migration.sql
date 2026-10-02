-- ============================================================
-- CrossClaim — TRACK C2 slice 2b（CI 修复：触发器命名避开保留前缀）
-- ------------------------------------------------------------
-- 背景：tools/tenant-triggers/append-only-triggers.json 的 unexpectedPrefixes 保留
--   cc_settlement_%  前缀给 Settlement 域的 append-only / 受控变更触发器。
-- 本次一致性守卫原命名为 cc_settlement_account_consistency → 门禁判为“清单外 append-only 触发器”。
-- 处理：不改历史 migration；本迁移把三条一致性守卫统一改名为 cc_account_consistency__<Table>。
-- 语义与函数体完全不变；仍不使用 DISABLE TRIGGER。
-- ============================================================

DROP TRIGGER IF EXISTS cc_claimitem_account_consistency ON "ClaimItem";
DROP TRIGGER IF EXISTS cc_claimitemevidence_account_consistency ON "ClaimItemEvidence";
DROP TRIGGER IF EXISTS cc_settlement_account_consistency ON "Settlement";

DROP TRIGGER IF EXISTS "cc_account_consistency__ClaimItem" ON "ClaimItem";
CREATE TRIGGER "cc_account_consistency__ClaimItem"
  BEFORE INSERT OR UPDATE ON "ClaimItem"
  FOR EACH ROW EXECUTE FUNCTION cc_claimitem_account_consistency();

DROP TRIGGER IF EXISTS "cc_account_consistency__ClaimItemEvidence" ON "ClaimItemEvidence";
CREATE TRIGGER "cc_account_consistency__ClaimItemEvidence"
  BEFORE INSERT OR UPDATE ON "ClaimItemEvidence"
  FOR EACH ROW EXECUTE FUNCTION cc_claimitemevidence_account_consistency();

DROP TRIGGER IF EXISTS "cc_account_consistency__Settlement" ON "Settlement";
CREATE TRIGGER "cc_account_consistency__Settlement"
  BEFORE INSERT OR UPDATE ON "Settlement"
  FOR EACH ROW EXECUTE FUNCTION cc_settlement_account_consistency();
