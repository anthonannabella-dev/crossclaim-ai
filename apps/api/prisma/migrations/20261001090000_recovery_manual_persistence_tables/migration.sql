-- ============================================================
-- CrossClaim — R43 Implementation S1 / M1
-- 人工追回提交持久化：5 张新表 + 2 枚举（纯新增，零既有对象改动）
-- 依据：MSG-20261001-31（CHANGE A/B/C）+ MSG-20261001-32（CHANGE A/B/C）
-- 生成方式：prisma migrate diff（schema → schema），SQL 原样落库
-- 说明：租户 / append-only / 受控变更触发器在 M2–M6 单独迁移中挂载。
-- ============================================================
-- CreateEnum
CREATE TYPE "RecoveryPackageStatus" AS ENUM ('GENERATED', 'EXPORTED', 'SUPERSEDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RecoveryPackageArtifactKind" AS ENUM ('PDF', 'JSON_MANIFEST');

-- CreateTable
CREATE TABLE "RecoveryPackage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "claimItemId" TEXT NOT NULL,
    "caseId" TEXT,
    "packageVersion" TEXT NOT NULL,
    "digestVersion" TEXT NOT NULL,
    "packageDigest" TEXT NOT NULL,
    "status" "RecoveryPackageStatus" NOT NULL DEFAULT 'GENERATED',
    "completenessSnapshot" JSONB,
    "generatedByUserId" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededByPackageId" TEXT,
    "transitionReason" TEXT,
    "transitionActorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryPackageArtifact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "artifactKind" "RecoveryPackageArtifactKind" NOT NULL,
    "fileAssetId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "exportedByUserId" TEXT,
    "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryPackageArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryManualSubmission" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "claimItemId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "packageDigest" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "approvalBasisReference" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryManualSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryManualSubmissionReference" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "providerCaseRefRaw" TEXT NOT NULL,
    "providerCaseRefCanonical" TEXT NOT NULL,
    "approvalId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByUserId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryManualSubmissionReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryManualSubmissionEvidence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryManualSubmissionEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecoveryPackage_organizationId_claimItemId_status_idx" ON "RecoveryPackage"("organizationId", "claimItemId", "status");

-- CreateIndex
CREATE INDEX "RecoveryPackage_organizationId_createdAt_idx" ON "RecoveryPackage"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryPackage_organizationId_claimItemId_packageVersion_p_key" ON "RecoveryPackage"("organizationId", "claimItemId", "packageVersion", "packageDigest");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryPackage_organizationId_id_key" ON "RecoveryPackage"("organizationId", "id");

-- CreateIndex
CREATE INDEX "RecoveryPackageArtifact_organizationId_packageId_exportedAt_idx" ON "RecoveryPackageArtifact"("organizationId", "packageId", "exportedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryPackageArtifact_organizationId_packageId_artifactKi_key" ON "RecoveryPackageArtifact"("organizationId", "packageId", "artifactKind", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryPackageArtifact_organizationId_id_key" ON "RecoveryPackageArtifact"("organizationId", "id");

-- CreateIndex
CREATE INDEX "RecoveryManualSubmission_organizationId_submittedAt_idx" ON "RecoveryManualSubmission"("organizationId", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryManualSubmission_organizationId_claimItemId_key" ON "RecoveryManualSubmission"("organizationId", "claimItemId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryManualSubmission_organizationId_approvalId_key" ON "RecoveryManualSubmission"("organizationId", "approvalId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryManualSubmission_organizationId_idempotencyKey_key" ON "RecoveryManualSubmission"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryManualSubmission_organizationId_id_key" ON "RecoveryManualSubmission"("organizationId", "id");

-- CreateIndex
CREATE INDEX "RecoveryManualSubmissionReference_organizationId_submission_idx" ON "RecoveryManualSubmissionReference"("organizationId", "submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryManualSubmissionReference_organizationId_providerCa_key" ON "RecoveryManualSubmissionReference"("organizationId", "providerCaseRefCanonical");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryManualSubmissionReference_organizationId_id_key" ON "RecoveryManualSubmissionReference"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryManualSubmissionEvidence_organizationId_submissionI_key" ON "RecoveryManualSubmissionEvidence"("organizationId", "submissionId", "evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryManualSubmissionEvidence_organizationId_id_key" ON "RecoveryManualSubmissionEvidence"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "RecoveryPackage" ADD CONSTRAINT "RecoveryPackage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryPackage" ADD CONSTRAINT "RecoveryPackage_claimItemId_fkey" FOREIGN KEY ("claimItemId") REFERENCES "ClaimItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryPackageArtifact" ADD CONSTRAINT "RecoveryPackageArtifact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryPackageArtifact" ADD CONSTRAINT "RecoveryPackageArtifact_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "RecoveryPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryPackageArtifact" ADD CONSTRAINT "RecoveryPackageArtifact_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES "FileAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryManualSubmission" ADD CONSTRAINT "RecoveryManualSubmission_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryManualSubmission" ADD CONSTRAINT "RecoveryManualSubmission_claimItemId_fkey" FOREIGN KEY ("claimItemId") REFERENCES "ClaimItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryManualSubmission" ADD CONSTRAINT "RecoveryManualSubmission_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "RecoveryPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryManualSubmissionReference" ADD CONSTRAINT "RecoveryManualSubmissionReference_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryManualSubmissionReference" ADD CONSTRAINT "RecoveryManualSubmissionReference_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "RecoveryManualSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryManualSubmissionEvidence" ADD CONSTRAINT "RecoveryManualSubmissionEvidence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryManualSubmissionEvidence" ADD CONSTRAINT "RecoveryManualSubmissionEvidence_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "RecoveryManualSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryManualSubmissionEvidence" ADD CONSTRAINT "RecoveryManualSubmissionEvidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "EvidenceArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

