-- ============================================================
-- CrossClaim · 租户完整性约束（数据库级）
-- ------------------------------------------------------------
-- 为什么需要它：
--   架构契约要求"引用对象必须属于同一租户"，但 Prisma 无法表达这一点 ——
--   Prisma 的复合外键要求 FK 字段全部可空，而 organizationId 不可空；
--   因此本约束由触发器提供（属架构契约允许的"等价数据库级约束"）。
--
-- 本段是架构契约的一部分，**不要删除**。
-- 新增 tenant 相关外键时，必须在下方对应 trigger 的 TG_ARGV 中补一对参数。
--
-- 行为：
--   行所属租户 = NEW.organizationId；对每个 (fk_column, ref_table) 参数，
--   若该外键非空，则被引用行的 organizationId 必须与行相同，
--   否则抛 check_violation。
--   NEW.organizationId 为空（如全局规则）时跳过检查。
-- ============================================================

CREATE OR REPLACE FUNCTION crossclaim_assert_tenant_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  i       int;
  fk_col  text;
  ref_tbl text;
  ref_val text;
  ref_org text;
  own_org text;
BEGIN
  own_org := to_jsonb(NEW) ->> 'organizationId';

  -- 无租户归属（全局规则等）跳过
  IF own_org IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_NARGS % 2 <> 0 THEN
    RAISE EXCEPTION 'crossclaim_assert_tenant_integrity: 参数必须成对 (fk_column, ref_table)';
  END IF;

  FOR i IN 0 .. (TG_NARGS / 2 - 1) LOOP
    fk_col  := TG_ARGV[i * 2];
    ref_tbl := TG_ARGV[i * 2 + 1];
    ref_val := to_jsonb(NEW) ->> fk_col;

    IF ref_val IS NOT NULL THEN
      EXECUTE format('SELECT "organizationId" FROM %I WHERE id = $1', ref_tbl)
        INTO ref_org USING ref_val;

      IF ref_org IS NOT NULL AND ref_org <> own_org THEN
        RAISE EXCEPTION
          'cross-tenant reference blocked: %.% -> % (id=%)',
          TG_TABLE_NAME, fk_col, ref_tbl, ref_val
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 按表挂触发器。参数成对：(外键列, 被引用表)
-- ------------------------------------------------------------

CREATE TRIGGER cc_tenant_FileAsset
  BEFORE INSERT OR UPDATE ON "FileAsset"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'connectionId', 'SourceConnection'
  );

CREATE TRIGGER cc_tenant_ImportBatch
  BEFORE INSERT OR UPDATE ON "ImportBatch"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'connectionId', 'SourceConnection',
    'fileAssetId', 'FileAsset'
  );

CREATE TRIGGER cc_tenant_SourceTransaction
  BEFORE INSERT OR UPDATE ON "SourceTransaction"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'connectionId', 'SourceConnection',
    'importBatchId', 'ImportBatch'
  );

CREATE TRIGGER cc_tenant_RecoveryGraphEdge
  BEFORE INSERT OR UPDATE ON "RecoveryGraphEdge"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'fromNodeId', 'RecoveryGraphNode',
    'toNodeId', 'RecoveryGraphNode'
  );

CREATE TRIGGER cc_tenant_EvidenceArtifact
  BEFORE INSERT OR UPDATE ON "EvidenceArtifact"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'fileAssetId', 'FileAsset',
    'connectionId', 'SourceConnection'
  );

CREATE TRIGGER cc_tenant_EvidenceEdge
  BEFORE INSERT OR UPDATE ON "EvidenceEdge"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'fromId', 'EvidenceArtifact',
    'toId', 'EvidenceArtifact'
  );

CREATE TRIGGER cc_tenant_CaseEvidence
  BEFORE INSERT OR UPDATE ON "CaseEvidence"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'caseId', 'Case',
    'evidenceId', 'EvidenceArtifact'
  );

CREATE TRIGGER cc_tenant_CaseOpportunity
  BEFORE INSERT OR UPDATE ON "CaseOpportunity"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'caseId', 'Case',
    'opportunityId', 'RecoveryOpportunity'
  );

CREATE TRIGGER cc_tenant_RecoveryRoute
  BEFORE INSERT OR UPDATE ON "RecoveryRoute"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'caseId', 'Case',
    'opportunityId', 'RecoveryOpportunity',
    'ruleVersionId', 'RuleVersion'
  );

CREATE TRIGGER cc_tenant_Claim
  BEFORE INSERT OR UPDATE ON "Claim"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'caseId', 'Case'
  );

CREATE TRIGGER cc_tenant_Appeal
  BEFORE INSERT OR UPDATE ON "Appeal"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'claimId', 'Claim',
    'caseId', 'Case'
  );

CREATE TRIGGER cc_tenant_RuleVersion
  BEFORE INSERT OR UPDATE ON "RuleVersion"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'ruleSetId', 'RuleSet'
  );

CREATE TRIGGER cc_tenant_RuleEvaluation
  BEFORE INSERT OR UPDATE ON "RuleEvaluation"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'ruleVersionId', 'RuleVersion',
    'sourceTransactionId', 'SourceTransaction',
    'opportunityId', 'RecoveryOpportunity'
  );

CREATE TRIGGER cc_tenant_Settlement
  BEFORE INSERT OR UPDATE ON "Settlement"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'caseId', 'Case',
    'evidenceId', 'EvidenceArtifact'
  );

CREATE TRIGGER cc_tenant_RecoveryLedgerEntry
  BEFORE INSERT OR UPDATE ON "RecoveryLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'caseId', 'Case',
    'opportunityId', 'RecoveryOpportunity',
    'settlementId', 'Settlement',
    'voidsEntryId', 'RecoveryLedgerEntry'
  );

CREATE TRIGGER cc_tenant_FeeCalculation
  BEFORE INSERT OR UPDATE ON "FeeCalculation"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'billingInvoiceId', 'BillingInvoice',
    'settlementId', 'Settlement',
    'caseId', 'Case'
  );
