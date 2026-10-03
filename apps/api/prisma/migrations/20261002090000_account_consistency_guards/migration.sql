-- ============================================================
-- CrossClaim — TRACK C2 slice 2b（MSG-20261002-66 M4 / MSG-20261002-67）
-- ------------------------------------------------------------
-- 跨账户一致性 DB 不变量（account scope 下推之后的正确性边界）：
--   1) ClaimItem.accountId 必须与其 RecoveryOpportunity.accountId 一致；
--   2) ClaimItemEvidence 两端的 accountId 必须一致（cross-account evidence binding → reject）；
--   3) Settlement 的 claimItem 与 evidence 必须属于同一 account（cross-account settlement linkage → reject）。
-- 任一 accountId 为 NULL（legacy 迁移窗口）时跳过判定 —— 不伪造 provenance，也不阻断历史行。
-- 边界：不改 Payment；不启用 autopay；R13 HOLD；TRANSPORT=false；不使用 DISABLE TRIGGER。
-- ============================================================

CREATE OR REPLACE FUNCTION cc_claimitem_account_consistency() RETURNS trigger AS $$
DECLARE
  opp_account text;
BEGIN
  IF NEW."accountId" IS NOT NULL AND NEW."opportunityId" IS NOT NULL THEN
    SELECT "accountId" INTO opp_account FROM "RecoveryOpportunity" WHERE id = NEW."opportunityId";
    IF opp_account IS NOT NULL AND opp_account <> NEW."accountId" THEN
      RAISE EXCEPTION 'CROSS_ACCOUNT_CLAIM_ITEM: claim item account % <> opportunity account %',
        NEW."accountId", opp_account USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_claimitem_account_consistency ON "ClaimItem";
CREATE TRIGGER cc_claimitem_account_consistency
  BEFORE INSERT OR UPDATE ON "ClaimItem"
  FOR EACH ROW EXECUTE FUNCTION cc_claimitem_account_consistency();

CREATE OR REPLACE FUNCTION cc_claimitemevidence_account_consistency() RETURNS trigger AS $$
DECLARE
  claim_account    text;
  evidence_account text;
BEGIN
  SELECT "accountId" INTO claim_account FROM "ClaimItem" WHERE id = NEW."claimItemId";
  SELECT "accountId" INTO evidence_account FROM "EvidenceArtifact" WHERE id = NEW."evidenceId";
  IF claim_account IS NOT NULL AND evidence_account IS NOT NULL AND claim_account <> evidence_account THEN
    RAISE EXCEPTION 'CROSS_ACCOUNT_EVIDENCE_BINDING: claim % <> evidence %',
      claim_account, evidence_account USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_claimitemevidence_account_consistency ON "ClaimItemEvidence";
CREATE TRIGGER cc_claimitemevidence_account_consistency
  BEFORE INSERT OR UPDATE ON "ClaimItemEvidence"
  FOR EACH ROW EXECUTE FUNCTION cc_claimitemevidence_account_consistency();

CREATE OR REPLACE FUNCTION cc_settlement_account_consistency() RETURNS trigger AS $$
DECLARE
  claim_account    text;
  evidence_account text;
BEGIN
  IF NEW."claimItemId" IS NOT NULL AND NEW."evidenceId" IS NOT NULL THEN
    SELECT "accountId" INTO claim_account FROM "ClaimItem" WHERE id = NEW."claimItemId";
    SELECT "accountId" INTO evidence_account FROM "EvidenceArtifact" WHERE id = NEW."evidenceId";
    IF claim_account IS NOT NULL AND evidence_account IS NOT NULL AND claim_account <> evidence_account THEN
      RAISE EXCEPTION 'CROSS_ACCOUNT_SETTLEMENT_LINKAGE: claim % <> evidence %',
        claim_account, evidence_account USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cc_settlement_account_consistency ON "Settlement";
CREATE TRIGGER cc_settlement_account_consistency
  BEFORE INSERT OR UPDATE ON "Settlement"
  FOR EACH ROW EXECUTE FUNCTION cc_settlement_account_consistency();
