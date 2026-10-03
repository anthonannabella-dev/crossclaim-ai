-- ============================================================
-- CrossClaim — R46 S1 / M1 —— Settlement / Billing Linkage 表结构
-- ------------------------------------------------------------
-- 4 新表 + Settlement / FeeCalculation 纯增列 + CHECK + partial unique
-- 依据：MSG-20261002-54 = PASS WITH REVISE（R46-B §11 S1 实施口径）。
-- 边界：零资金业务行为 —— 不创建 Settlement / receipt / reversal / Fee / Invoice，不改 RecoveryLedger。
-- ============================================================

-- CreateEnum
CREATE TYPE "SettlementExternalIdentityKind" AS ENUM ('BANK_TRANSACTION', 'PSP_SETTLEMENT', 'PLATFORM_SETTLEMENT_REPORT', 'CARRIER_SETTLEMENT', 'INSURER_PAYOUT', 'CHECK_REFERENCE', 'MANUAL_DOCUMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "SettlementLinkageBasisKind" AS ENUM ('CLAIM_ITEM_DIRECT', 'CASE_LEVEL_ALLOCATION', 'MANUAL_BASIS');

-- CreateEnum
CREATE TYPE "SettlementReceiptSourceKind" AS ENUM ('OFFICIAL_API', 'PLATFORM_REPORT', 'BANK_STATEMENT', 'PSP_SETTLEMENT_REPORT', 'MANUAL_DOCUMENT');

-- CreateEnum
CREATE TYPE "SettlementAdjustmentKind" AS ENUM ('REVERSAL', 'CORRECTION');

-- CreateEnum
CREATE TYPE "FeeMembershipBasisRole" AS ENUM ('POSITIVE', 'NEGATIVE');

-- CreateEnum
CREATE TYPE "FeeCalculationAdjustmentKind" AS ENUM ('VOID', 'REVERSAL', 'CORRECTION');

-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN     "claimItemId" TEXT,
ADD COLUMN     "externalIdentityKind" "SettlementExternalIdentityKind",
ADD COLUMN     "externalIdentityValue" TEXT,
ADD COLUMN     "externalIdentityValueHash" TEXT,
ADD COLUMN     "externalIdentityVersion" TEXT,
ADD COLUMN     "financialEventFingerprint" TEXT,
ADD COLUMN     "financialEventFingerprintVersion" TEXT,
ADD COLUMN     "linkageBasisKind" "SettlementLinkageBasisKind",
ADD COLUMN     "linkageBasisRef" TEXT,
ADD COLUMN     "receiptSnapshotId" TEXT;

-- AlterTable
ALTER TABLE "FeeCalculation" ADD COLUMN     "claimItemId" TEXT,
ADD COLUMN     "feeBasisVersion" TEXT,
ADD COLUMN     "feeChainId" TEXT,
ADD COLUMN     "feeChainRootFeeCalculationId" TEXT,
ADD COLUMN     "membershipDigest" TEXT,
ADD COLUMN     "policyRef" TEXT,
ADD COLUMN     "supersededByFeeCalculationId" TEXT;

-- CreateTable
CREATE TABLE "SettlementReceiptSnapshot" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "claimItemId" TEXT,
    "caseId" TEXT,
    "externalIdentityKind" "SettlementExternalIdentityKind" NOT NULL,
    "externalIdentityValueHash" TEXT,
    "externalIdentityVersion" TEXT,
    "financialEventFingerprint" TEXT,
    "financialEventFingerprintVersion" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "sourceKind" "SettlementReceiptSourceKind" NOT NULL,
    "evidenceReferences" JSONB NOT NULL,
    "snapshotVersion" TEXT NOT NULL DEFAULT 'v1',
    "snapshotDigest" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementReceiptSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementAdjustment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "originalSettlementId" TEXT NOT NULL,
    "adjustmentKind" "SettlementAdjustmentKind" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "externalIdentityKind" "SettlementExternalIdentityKind" NOT NULL,
    "externalIdentityValue" TEXT,
    "externalIdentityValueHash" TEXT,
    "externalIdentityVersion" TEXT,
    "financialEventFingerprint" TEXT,
    "financialEventFingerprintVersion" TEXT,
    "evidenceReferences" JSONB NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonText" TEXT,
    "approvalId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeCalculationSettlement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "feeCalculationId" TEXT NOT NULL,
    "settlementId" TEXT,
    "adjustmentId" TEXT,
    "basisRole" "FeeMembershipBasisRole" NOT NULL,
    "amountContribution" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeCalculationSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeCalculationAdjustment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "targetFeeCalculationId" TEXT NOT NULL,
    "adjustmentKind" "FeeCalculationAdjustmentKind" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "triggerSettlementAdjustmentIds" JSONB,
    "evidenceReferences" JSONB NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonText" TEXT,
    "approvalId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeCalculationAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SettlementReceiptSnapshot_organizationId_createdAt_idx" ON "SettlementReceiptSnapshot"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "SettlementReceiptSnapshot_organizationId_claimItemId_idx" ON "SettlementReceiptSnapshot"("organizationId", "claimItemId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementReceiptSnapshot_organizationId_id_key" ON "SettlementReceiptSnapshot"("organizationId", "id");

-- CreateIndex
CREATE INDEX "SettlementAdjustment_organizationId_originalSettlementId_idx" ON "SettlementAdjustment"("organizationId", "originalSettlementId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementAdjustment_organizationId_id_key" ON "SettlementAdjustment"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementAdjustment_organizationId_approvalId_key" ON "SettlementAdjustment"("organizationId", "approvalId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementAdjustment_organizationId_originalSettlementId_key" ON "SettlementAdjustment"("organizationId", "originalSettlementId");

-- CreateIndex
CREATE INDEX "FeeCalculationSettlement_organizationId_feeCalculationId_idx" ON "FeeCalculationSettlement"("organizationId", "feeCalculationId");

-- CreateIndex
CREATE INDEX "FeeCalculationSettlement_organizationId_settlementId_idx" ON "FeeCalculationSettlement"("organizationId", "settlementId");

-- CreateIndex
CREATE INDEX "FeeCalculationSettlement_organizationId_adjustmentId_idx" ON "FeeCalculationSettlement"("organizationId", "adjustmentId");

-- CreateIndex
CREATE UNIQUE INDEX "FeeCalculationSettlement_organizationId_id_key" ON "FeeCalculationSettlement"("organizationId", "id");

-- CreateIndex
CREATE INDEX "FeeCalculationAdjustment_organizationId_targetFeeCalculatio_idx" ON "FeeCalculationAdjustment"("organizationId", "targetFeeCalculationId");

-- CreateIndex
CREATE UNIQUE INDEX "FeeCalculationAdjustment_organizationId_id_key" ON "FeeCalculationAdjustment"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FeeCalculationAdjustment_organizationId_approvalId_key" ON "FeeCalculationAdjustment"("organizationId", "approvalId");

-- CreateIndex
CREATE INDEX "Settlement_organizationId_claimItemId_receivedAt_idx" ON "Settlement"("organizationId", "claimItemId", "receivedAt");

-- CreateIndex
CREATE INDEX "Settlement_organizationId_receiptSnapshotId_idx" ON "Settlement"("organizationId", "receiptSnapshotId");

-- CreateIndex
CREATE INDEX "FeeCalculation_organizationId_feeChainId_idx" ON "FeeCalculation"("organizationId", "feeChainId");

-- CreateIndex
CREATE INDEX "FeeCalculation_organizationId_claimItemId_idx" ON "FeeCalculation"("organizationId", "claimItemId");

-- CreateIndex
CREATE INDEX "FeeCalculation_caseId_idx" ON "FeeCalculation"("caseId");

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_claimItemId_fkey" FOREIGN KEY ("claimItemId") REFERENCES "ClaimItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_receiptSnapshotId_fkey" FOREIGN KEY ("receiptSnapshotId") REFERENCES "SettlementReceiptSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCalculation" ADD CONSTRAINT "FeeCalculation_claimItemId_fkey" FOREIGN KEY ("claimItemId") REFERENCES "ClaimItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCalculation" ADD CONSTRAINT "FeeCalculation_feeChainRootFeeCalculationId_fkey" FOREIGN KEY ("feeChainRootFeeCalculationId") REFERENCES "FeeCalculation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCalculation" ADD CONSTRAINT "FeeCalculation_supersededByFeeCalculationId_fkey" FOREIGN KEY ("supersededByFeeCalculationId") REFERENCES "FeeCalculation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementReceiptSnapshot" ADD CONSTRAINT "SettlementReceiptSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementReceiptSnapshot" ADD CONSTRAINT "SettlementReceiptSnapshot_claimItemId_fkey" FOREIGN KEY ("claimItemId") REFERENCES "ClaimItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementReceiptSnapshot" ADD CONSTRAINT "SettlementReceiptSnapshot_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementAdjustment" ADD CONSTRAINT "SettlementAdjustment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementAdjustment" ADD CONSTRAINT "SettlementAdjustment_originalSettlementId_fkey" FOREIGN KEY ("originalSettlementId") REFERENCES "Settlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCalculationSettlement" ADD CONSTRAINT "FeeCalculationSettlement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCalculationSettlement" ADD CONSTRAINT "FeeCalculationSettlement_feeCalculationId_fkey" FOREIGN KEY ("feeCalculationId") REFERENCES "FeeCalculation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCalculationSettlement" ADD CONSTRAINT "FeeCalculationSettlement_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCalculationSettlement" ADD CONSTRAINT "FeeCalculationSettlement_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "SettlementAdjustment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCalculationAdjustment" ADD CONSTRAINT "FeeCalculationAdjustment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCalculationAdjustment" ADD CONSTRAINT "FeeCalculationAdjustment_targetFeeCalculationId_fkey" FOREIGN KEY ("targetFeeCalculationId") REFERENCES "FeeCalculation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------- R46 S1 附加 CHECK（MSG-20261002-54：F1/F2/F4 + v1 fail-closed） ----------
ALTER TABLE "Settlement"
  ADD CONSTRAINT "Settlement_new_identity_hash_shape" CHECK ("externalIdentityValueHash" IS NULL OR "externalIdentityValueHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "Settlement_new_fingerprint_shape"   CHECK ("financialEventFingerprint" IS NULL OR "financialEventFingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "Settlement_identity_version_check"  CHECK ("externalIdentityVersion" IS NULL OR "externalIdentityVersion" = 'v1'),
  ADD CONSTRAINT "Settlement_fingerprint_version_check" CHECK ("financialEventFingerprintVersion" IS NULL OR "financialEventFingerprintVersion" = 'sfp-v1');

ALTER TABLE "FeeCalculation"
  ADD CONSTRAINT "FeeCalculation_claimitem_chain_check" CHECK ("feeChainId" IS NULL OR "claimItemId" IS NOT NULL);

ALTER TABLE "SettlementReceiptSnapshot"
  ADD CONSTRAINT "SettlementReceiptSnapshot_digest_shape" CHECK ("snapshotDigest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "SettlementReceiptSnapshot_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "SettlementReceiptSnapshot_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "SettlementReceiptSnapshot_evidence_min" CHECK (jsonb_typeof("evidenceReferences") = 'array' AND jsonb_array_length("evidenceReferences") >= 1),
  ADD CONSTRAINT "SettlementReceiptSnapshot_identity_present" CHECK ("externalIdentityValueHash" IS NOT NULL OR "financialEventFingerprint" IS NOT NULL),
  ADD CONSTRAINT "SettlementReceiptSnapshot_hash_shape" CHECK ("externalIdentityValueHash" IS NULL OR "externalIdentityValueHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "SettlementReceiptSnapshot_fingerprint_shape" CHECK ("financialEventFingerprint" IS NULL OR "financialEventFingerprint" ~ '^[0-9a-f]{64}$');

ALTER TABLE "SettlementAdjustment"
  ADD CONSTRAINT "SettlementAdjustment_v1_kind_only" CHECK ("adjustmentKind" = 'REVERSAL'),
  ADD CONSTRAINT "SettlementAdjustment_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "SettlementAdjustment_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "SettlementAdjustment_identity_present" CHECK ("externalIdentityValueHash" IS NOT NULL OR "financialEventFingerprint" IS NOT NULL),
  ADD CONSTRAINT "SettlementAdjustment_hash_shape" CHECK ("externalIdentityValueHash" IS NULL OR "externalIdentityValueHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "SettlementAdjustment_fingerprint_shape" CHECK ("financialEventFingerprint" IS NULL OR "financialEventFingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "SettlementAdjustment_evidence_min" CHECK (jsonb_typeof("evidenceReferences") = 'array' AND jsonb_array_length("evidenceReferences") >= 1);

ALTER TABLE "FeeCalculationSettlement"
  ADD CONSTRAINT "FeeCalculationSettlement_scope_exclusive" CHECK (("settlementId" IS NOT NULL) <> ("adjustmentId" IS NOT NULL)),
  ADD CONSTRAINT "FeeCalculationSettlement_sign_by_role" CHECK (
    ("basisRole" = 'POSITIVE' AND "amountContribution" > 0)
    OR ("basisRole" = 'NEGATIVE' AND "amountContribution" < 0)
  ),
  ADD CONSTRAINT "FeeCalculationSettlement_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "FeeCalculationAdjustment"
  ADD CONSTRAINT "FeeCalculationAdjustment_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "FeeCalculationAdjustment_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "FeeCalculationAdjustment_evidence_min" CHECK (jsonb_typeof("evidenceReferences") = 'array' AND jsonb_array_length("evidenceReferences") >= 1),
  ADD CONSTRAINT "FeeCalculationAdjustment_reversal_triggers" CHECK (
    "adjustmentKind" <> 'REVERSAL'
    OR ("triggerSettlementAdjustmentIds" IS NOT NULL
        AND jsonb_typeof("triggerSettlementAdjustmentIds") = 'array'
        AND jsonb_array_length("triggerSettlementAdjustmentIds") >= 1)
  );

-- ---------- R46 S1 partial unique（外部身份 / fingerprint / membership / fee chain） ----------
CREATE UNIQUE INDEX "Settlement_org_identity_unique"
  ON "Settlement"("organizationId", "externalIdentityKind", "externalIdentityValueHash", "externalIdentityVersion")
  WHERE "externalIdentityValueHash" IS NOT NULL;
CREATE UNIQUE INDEX "Settlement_org_fingerprint_unique"
  ON "Settlement"("organizationId", "financialEventFingerprint", "financialEventFingerprintVersion")
  WHERE "financialEventFingerprint" IS NOT NULL;

CREATE UNIQUE INDEX "SettlementAdjustment_org_identity_unique"
  ON "SettlementAdjustment"("organizationId", "externalIdentityKind", "externalIdentityValueHash", "externalIdentityVersion")
  WHERE "externalIdentityValueHash" IS NOT NULL;
CREATE UNIQUE INDEX "SettlementAdjustment_org_fingerprint_unique"
  ON "SettlementAdjustment"("organizationId", "financialEventFingerprint", "financialEventFingerprintVersion")
  WHERE "financialEventFingerprint" IS NOT NULL;

CREATE UNIQUE INDEX "FeeCalculationSettlement_calc_settlement_unique"
  ON "FeeCalculationSettlement"("feeCalculationId", "settlementId")
  WHERE "settlementId" IS NOT NULL;
CREATE UNIQUE INDEX "FeeCalculationSettlement_calc_adjustment_unique"
  ON "FeeCalculationSettlement"("feeCalculationId", "adjustmentId")
  WHERE "adjustmentId" IS NOT NULL;

CREATE UNIQUE INDEX "FeeCalculation_org_claimitem_active_unique"
  ON "FeeCalculation"("organizationId", "claimItemId")
  WHERE "supersededByFeeCalculationId" IS NULL AND "claimItemId" IS NOT NULL;
