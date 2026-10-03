-- ============================================================
-- CrossClaim — R45 S1 / M1
-- Outcome / Reimbursement Reconciliation：七表 + 七枚举（纯新增，零既有对象改动）
-- 依据：MSG-20261001-45（4 项裁决 + CHANGE A–D）+ MSG-20261001-46（七表 + CHANGE A–C 批准；
--       basis supersede 事务顺序修正；授权进入 R45 S1）
-- 生成方式：prisma migrate dev --create-only（schema → SQL），SQL 原样落库
-- 说明：租户 / append-only / 受控 supersede / partial unique / CHECK 在 M2–M5 单独迁移挂载。
-- 边界：NO Settlement · NO Billing · NO Fee · NO RecoveryLedger mutation · NO platform write。
-- ============================================================
-- CreateEnum
CREATE TYPE "ProviderOutcomeFactKind" AS ENUM ('ACCEPTED', 'ACCEPTANCE_REVOKED');

-- CreateEnum
CREATE TYPE "ProviderOutcomeSourceKind" AS ENUM ('OFFICIAL_API', 'PLATFORM_REPORT', 'MANUAL_WITH_EVIDENCE');

-- CreateEnum
CREATE TYPE "ReimbursementFactKind" AS ENUM ('OBSERVED', 'REIMBURSEMENT_REVERSED');

-- CreateEnum
CREATE TYPE "ReimbursementSourceKind" AS ENUM ('OFFICIAL_API', 'PLATFORM_REPORT', 'MANUAL_WITH_EVIDENCE');

-- CreateEnum
CREATE TYPE "ExpectedRecoveryBasisKind" AS ENUM ('CARRIER_CLAIM', 'PROVIDER_POLICY', 'CONTRACTUAL');

-- CreateEnum
CREATE TYPE "ReconciliationOverrideDecisionKind" AS ENUM ('MATCHED', 'UNMATCHED');

-- CreateEnum
CREATE TYPE "ReconciliationProjectionStatus" AS ENUM ('UNMATCHED', 'AMBIGUOUS', 'MATCHED', 'PARTIALLY_RECONCILED', 'FULLY_RECONCILED');

-- CreateTable
CREATE TABLE "ProviderOutcomeFact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "claimItemId" TEXT,
    "provider" TEXT NOT NULL,
    "kind" "ProviderOutcomeFactKind" NOT NULL,
    "providerCaseRefCanonical" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "providerEventId" TEXT,
    "providerEventFingerprint" TEXT NOT NULL,
    "fingerprintVersion" TEXT NOT NULL DEFAULT 'v1',
    "sourceKind" "ProviderOutcomeSourceKind" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "parserVersion" TEXT,
    "ingestedByUserId" TEXT NOT NULL,
    "evidenceArtifactIds" TEXT[],
    "reasonCode" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderOutcomeFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReimbursementFact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "claimItemId" TEXT,
    "caseId" TEXT,
    "provider" TEXT NOT NULL,
    "kind" "ReimbursementFactKind" NOT NULL,
    "reversesFactId" TEXT,
    "amount" DECIMAL(18,4),
    "currency" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "providerEventId" TEXT,
    "providerEventFingerprint" TEXT NOT NULL,
    "fingerprintVersion" TEXT NOT NULL DEFAULT 'v1',
    "providerCaseRefCanonical" TEXT,
    "orderRef" TEXT,
    "rawRefs" JSONB,
    "sourceKind" "ReimbursementSourceKind" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "parserVersion" TEXT,
    "ingestedByUserId" TEXT NOT NULL,
    "evidenceArtifactIds" TEXT[],
    "reasonCode" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReimbursementFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpectedRecoveryBasis" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "claimItemId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "expectedRecoveryAmount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "basisKind" "ExpectedRecoveryBasisKind" NOT NULL,
    "basisVersion" TEXT NOT NULL,
    "basisSource" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "supersededByBasisId" TEXT,

    CONSTRAINT "ExpectedRecoveryBasis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationOverrideDecision" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "claimItemId" TEXT NOT NULL,
    "reimbursementFactId" TEXT NOT NULL,
    "decisionKind" "ReconciliationOverrideDecisionKind" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonText" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "decidedByUserId" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationOverrideDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimReconciliationProjection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "claimItemId" TEXT NOT NULL,
    "status" "ReconciliationProjectionStatus" NOT NULL,
    "basisId" TEXT,
    "expectedAmount" DECIMAL(18,4),
    "currency" TEXT,
    "netMatchedObservedAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "matchedFactIds" TEXT[],
    "tolerancePolicyId" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "inputDigest" TEXT NOT NULL,
    "projectionVersion" INTEGER NOT NULL DEFAULT 1,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClaimReconciliationProjection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimReconciliationProjectionFact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectionId" TEXT NOT NULL,
    "projectionVersion" INTEGER NOT NULL,
    "reimbursementFactId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimReconciliationProjectionFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationTolerancePolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "provider" TEXT,
    "operation" TEXT,
    "policyVersion" TEXT NOT NULL,
    "absoluteTolerance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "relativeTolerance" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "ReconciliationTolerancePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderOutcomeFact_organizationId_claimItemId_occurredAt_idx" ON "ProviderOutcomeFact"("organizationId", "claimItemId", "occurredAt");

-- CreateIndex
CREATE INDEX "ProviderOutcomeFact_organizationId_providerCaseRefCanonical_idx" ON "ProviderOutcomeFact"("organizationId", "providerCaseRefCanonical");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderOutcomeFact_organizationId_providerEventFingerprint_key" ON "ProviderOutcomeFact"("organizationId", "providerEventFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderOutcomeFact_organizationId_id_key" ON "ProviderOutcomeFact"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ReimbursementFact_organizationId_claimItemId_occurredAt_idx" ON "ReimbursementFact"("organizationId", "claimItemId", "occurredAt");

-- CreateIndex
CREATE INDEX "ReimbursementFact_organizationId_providerCaseRefCanonical_idx" ON "ReimbursementFact"("organizationId", "providerCaseRefCanonical");

-- CreateIndex
CREATE UNIQUE INDEX "ReimbursementFact_organizationId_providerEventFingerprint_key" ON "ReimbursementFact"("organizationId", "providerEventFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "ReimbursementFact_organizationId_id_key" ON "ReimbursementFact"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ExpectedRecoveryBasis_organizationId_claimItemId_superseded_idx" ON "ExpectedRecoveryBasis"("organizationId", "claimItemId", "supersededAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExpectedRecoveryBasis_organizationId_id_key" ON "ExpectedRecoveryBasis"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ReconciliationOverrideDecision_organizationId_claimItemId_idx" ON "ReconciliationOverrideDecision"("organizationId", "claimItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationOverrideDecision_organizationId_reimbursement_key" ON "ReconciliationOverrideDecision"("organizationId", "reimbursementFactId");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationOverrideDecision_organizationId_approvalId_key" ON "ReconciliationOverrideDecision"("organizationId", "approvalId");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationOverrideDecision_organizationId_id_key" ON "ReconciliationOverrideDecision"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ClaimReconciliationProjection_organizationId_status_idx" ON "ClaimReconciliationProjection"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimReconciliationProjection_organizationId_claimItemId_key" ON "ClaimReconciliationProjection"("organizationId", "claimItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimReconciliationProjection_organizationId_id_key" ON "ClaimReconciliationProjection"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ClaimReconciliationProjectionFact_organizationId_projection_idx" ON "ClaimReconciliationProjectionFact"("organizationId", "projectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimReconciliationProjectionFact_organizationId_projection_key" ON "ClaimReconciliationProjectionFact"("organizationId", "projectionId", "projectionVersion", "reimbursementFactId");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimReconciliationProjectionFact_organizationId_id_key" ON "ClaimReconciliationProjectionFact"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ReconciliationTolerancePolicy_organizationId_provider_opera_idx" ON "ReconciliationTolerancePolicy"("organizationId", "provider", "operation");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationTolerancePolicy_organizationId_id_key" ON "ReconciliationTolerancePolicy"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "ProviderOutcomeFact" ADD CONSTRAINT "ProviderOutcomeFact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementFact" ADD CONSTRAINT "ReimbursementFact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementFact" ADD CONSTRAINT "ReimbursementFact_reversesFactId_fkey" FOREIGN KEY ("reversesFactId") REFERENCES "ReimbursementFact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpectedRecoveryBasis" ADD CONSTRAINT "ExpectedRecoveryBasis_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpectedRecoveryBasis" ADD CONSTRAINT "ExpectedRecoveryBasis_claimItemId_fkey" FOREIGN KEY ("claimItemId") REFERENCES "ClaimItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationOverrideDecision" ADD CONSTRAINT "ReconciliationOverrideDecision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationOverrideDecision" ADD CONSTRAINT "ReconciliationOverrideDecision_claimItemId_fkey" FOREIGN KEY ("claimItemId") REFERENCES "ClaimItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationOverrideDecision" ADD CONSTRAINT "ReconciliationOverrideDecision_reimbursementFactId_fkey" FOREIGN KEY ("reimbursementFactId") REFERENCES "ReimbursementFact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimReconciliationProjection" ADD CONSTRAINT "ClaimReconciliationProjection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimReconciliationProjection" ADD CONSTRAINT "ClaimReconciliationProjection_claimItemId_fkey" FOREIGN KEY ("claimItemId") REFERENCES "ClaimItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimReconciliationProjectionFact" ADD CONSTRAINT "ClaimReconciliationProjectionFact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimReconciliationProjectionFact" ADD CONSTRAINT "ClaimReconciliationProjectionFact_projectionId_fkey" FOREIGN KEY ("projectionId") REFERENCES "ClaimReconciliationProjection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimReconciliationProjectionFact" ADD CONSTRAINT "ClaimReconciliationProjectionFact_reimbursementFactId_fkey" FOREIGN KEY ("reimbursementFactId") REFERENCES "ReimbursementFact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationTolerancePolicy" ADD CONSTRAINT "ReconciliationTolerancePolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
