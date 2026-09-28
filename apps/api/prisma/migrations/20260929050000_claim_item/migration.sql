-- ============================================================
-- CrossClaim — C-0011 ClaimItem / ClaimItemEvidence（纯增量）
-- ------------------------------------------------------------
-- MSG-20260928-116 / -118：一个 Case 聚合多条 ClaimItem；证据只建联结不复制；
-- Schema 内不出现任何平台写权限字段。租户触发器 22 → 27。
-- caseId 生命周期不变量（REVIEW_REQUIRED 起必须存在）刻意**不用**数据库 CHECK。
-- ============================================================

CREATE TYPE "ClaimItemStatus" AS ENUM ('DISCOVERED', 'VERIFIED', 'REVIEW_REQUIRED', 'READY_TO_APPEAL', 'SUBMITTED_MANUAL', 'RECOVERED', 'CLOSED');
CREATE TYPE "ClaimItemClosedReason" AS ENUM ('RECOVERED', 'REJECTED', 'NOT_WORTH_PURSUING', 'CUSTOMER_DECLINED');
CREATE TYPE "ClaimResponsibleParty" AS ENUM ('CARRIER', 'PLATFORM', 'PLATFORM_WAREHOUSE', 'SELLER', 'BUYER', 'THIRD_PARTY', 'UNKNOWN');
CREATE TYPE "ClaimEvidenceType" AS ENUM ('POD', 'INVOICE', 'LEDGER_EXPORT', 'ADJUSTMENT_REPORT', 'TRACKING', 'PLATFORM_DECISION', 'CLAIM_RESPONSE', 'CONTRACT_TERM', 'OTHER');

CREATE TABLE "ClaimItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT,
    "opportunityId" TEXT,
    "platformType" TEXT NOT NULL,
    "claimType" TEXT NOT NULL,
    "platformRef" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "amountExpected" DECIMAL(18,4),
    "amountActual" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "recoverableAmount" DECIMAL(18,4),
    "responsibleParty" "ClaimResponsibleParty" NOT NULL DEFAULT 'UNKNOWN',
    "status" "ClaimItemStatus" NOT NULL DEFAULT 'DISCOVERED',
    "closedReason" "ClaimItemClosedReason",
    "closedAt" TIMESTAMP(3),
    "normalizerVersion" TEXT NOT NULL,
    "ruleVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClaimItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClaimItemEvidence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "claimItemId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "evidenceType" "ClaimEvidenceType" NOT NULL DEFAULT 'OTHER',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimItemEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClaimItem_organizationId_platformType_platformRef_claimType_key" ON "ClaimItem"("organizationId", "platformType", "platformRef", "claimType");
CREATE UNIQUE INDEX "ClaimItem_organizationId_id_key" ON "ClaimItem"("organizationId", "id");
CREATE INDEX "ClaimItem_organizationId_status_occurredAt_idx" ON "ClaimItem"("organizationId", "status", "occurredAt");
CREATE INDEX "ClaimItem_caseId_idx" ON "ClaimItem"("caseId");
CREATE UNIQUE INDEX "ClaimItemEvidence_organizationId_claimItemId_evidenceId_key" ON "ClaimItemEvidence"("organizationId", "claimItemId", "evidenceId");
CREATE UNIQUE INDEX "ClaimItemEvidence_organizationId_id_key" ON "ClaimItemEvidence"("organizationId", "id");
CREATE INDEX "ClaimItemEvidence_claimItemId_idx" ON "ClaimItemEvidence"("claimItemId");

ALTER TABLE "ClaimItem" ADD CONSTRAINT "ClaimItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClaimItem" ADD CONSTRAINT "ClaimItem_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClaimItem" ADD CONSTRAINT "ClaimItem_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "RecoveryOpportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClaimItem" ADD CONSTRAINT "ClaimItem_ruleVersionId_fkey" FOREIGN KEY ("ruleVersionId") REFERENCES "RuleVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClaimItemEvidence" ADD CONSTRAINT "ClaimItemEvidence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClaimItemEvidence" ADD CONSTRAINT "ClaimItemEvidence_claimItemId_fkey" FOREIGN KEY ("claimItemId") REFERENCES "ClaimItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClaimItemEvidence" ADD CONSTRAINT "ClaimItemEvidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "EvidenceArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TRIGGER IF EXISTS cc_tenant_ClaimItem_caseId ON "ClaimItem";
CREATE TRIGGER cc_tenant_ClaimItem_caseId
  BEFORE INSERT OR UPDATE ON "ClaimItem"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('caseId', 'Case');
DROP TRIGGER IF EXISTS cc_tenant_ClaimItem_opportunityId ON "ClaimItem";
CREATE TRIGGER cc_tenant_ClaimItem_opportunityId
  BEFORE INSERT OR UPDATE ON "ClaimItem"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('opportunityId', 'RecoveryOpportunity');
DROP TRIGGER IF EXISTS cc_tenant_ClaimItem_ruleVersionId ON "ClaimItem";
CREATE TRIGGER cc_tenant_ClaimItem_ruleVersionId
  BEFORE INSERT OR UPDATE ON "ClaimItem"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('ruleVersionId', 'RuleVersion');
DROP TRIGGER IF EXISTS cc_tenant_ClaimItemEvidence_claimItemId ON "ClaimItemEvidence";
CREATE TRIGGER cc_tenant_ClaimItemEvidence_claimItemId
  BEFORE INSERT OR UPDATE ON "ClaimItemEvidence"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('claimItemId', 'ClaimItem');
DROP TRIGGER IF EXISTS cc_tenant_ClaimItemEvidence_evidenceId ON "ClaimItemEvidence";
CREATE TRIGGER cc_tenant_ClaimItemEvidence_evidenceId
  BEFORE INSERT OR UPDATE ON "ClaimItemEvidence"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity('evidenceId', 'EvidenceArtifact');
