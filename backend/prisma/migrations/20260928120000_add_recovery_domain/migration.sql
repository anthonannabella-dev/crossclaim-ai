-- CreateEnum
CREATE TYPE "RecoveryChannel" AS ENUM ('AMAZON', 'UPS', 'FEDEX', 'FREIGHT', 'INSURANCE', 'CUSTOMS', 'OTHER');

-- CreateEnum
CREATE TYPE "SignalStatus" AS ENUM ('NEW', 'TRIAGED', 'PROMOTED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('OPEN', 'COLLECTING', 'EVIDENCE_READY', 'SUBMITTED', 'WAITING', 'APPEALED', 'APPROVED', 'RECOVERED', 'REJECTED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "ClaimRound" AS ENUM ('FIRST', 'APPEAL', 'ESCALATION');

-- CreateEnum
CREATE TYPE "ClaimResponseType" AS ENUM ('APPROVED', 'PARTIAL', 'REJECTED', 'NO_RESPONSE');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('CONTRACT', 'RATE_CARD', 'INVOICE', 'POD', 'TRACKING', 'EMAIL', 'BILL', 'CUSTOMS_DOC', 'OTHER');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('DISCOVERED', 'RECOVERED', 'COMMISSION', 'ADJUSTED', 'WRITTEN_OFF', 'REVERSAL');

-- CreateEnum
CREATE TYPE "ConfirmationSource" AS ENUM ('MANUAL', 'BANK_STATEMENT', 'CHANNEL_RECEIPT');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PENDING', 'PARSING', 'IMPORTED', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "LossSignal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" "RecoveryChannel" NOT NULL,
    "signalType" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceRef" TEXT,
    "sourceFileId" TEXT,
    "amountExpected" DECIMAL(18,4),
    "amountActual" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "confidence" DOUBLE PRECISION,
    "status" "SignalStatus" NOT NULL DEFAULT 'NEW',
    "dismissNote" TEXT,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LossSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseNo" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "primaryChannel" "RecoveryChannel" NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'OPEN',
    "claimedAmount" DECIMAL(18,4),
    "recoveredAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "slaDueAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "temporalWorkflowId" TEXT,
    "temporalRunId" TEXT,
    "nextActionAt" TIMESTAMP(3),
    "aiAssessment" JSONB,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseSignal" (
    "caseId" TEXT NOT NULL,
    "signalId" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "CaseSignal_pkey" PRIMARY KEY ("caseId","signalId")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "channel" "RecoveryChannel" NOT NULL,
    "round" "ClaimRound" NOT NULL DEFAULT 'FIRST',
    "parentClaimId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedBy" TEXT,
    "externalRef" TEXT,
    "expectedAmount" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "dueAt" TIMESTAMP(3),
    "responseAt" TIMESTAMP(3),
    "responseType" "ClaimResponseType",
    "responseAmount" DECIMAL(18,4),
    "responseNote" TEXT,
    "attachmentKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "fileKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "size" INTEGER,
    "sha256" TEXT,
    "source" TEXT,
    "note" TEXT,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryLedgerEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT,
    "entryType" "LedgerEntryType" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "counterparty" TEXT,
    "reference" TEXT,
    "confirmationSource" "ConfirmationSource",
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "voidsEntryId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" "RecoveryChannel" NOT NULL,
    "label" TEXT NOT NULL,
    "credentialsRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" "RecoveryChannel" NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING',
    "rowsTotal" INTEGER NOT NULL DEFAULT 0,
    "rowsOk" INTEGER NOT NULL DEFAULT 0,
    "rowsFailed" INTEGER NOT NULL DEFAULT 0,
    "errorReport" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdBy" TEXT,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LossSignal_tenantId_status_idx" ON "LossSignal"("tenantId", "status");

-- CreateIndex
CREATE INDEX "LossSignal_tenantId_channel_detectedAt_idx" ON "LossSignal"("tenantId", "channel", "detectedAt");

-- CreateIndex
CREATE INDEX "RecoveryCase_tenantId_status_idx" ON "RecoveryCase"("tenantId", "status");

-- CreateIndex
CREATE INDEX "RecoveryCase_tenantId_nextActionAt_idx" ON "RecoveryCase"("tenantId", "nextActionAt");

-- CreateIndex
CREATE INDEX "RecoveryCase_temporalWorkflowId_idx" ON "RecoveryCase"("temporalWorkflowId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryCase_tenantId_caseNo_key" ON "RecoveryCase"("tenantId", "caseNo");

-- CreateIndex
CREATE INDEX "Claim_caseId_round_idx" ON "Claim"("caseId", "round");

-- CreateIndex
CREATE INDEX "Claim_dueAt_responseAt_idx" ON "Claim"("dueAt", "responseAt");

-- CreateIndex
CREATE INDEX "Evidence_caseId_kind_idx" ON "Evidence"("caseId", "kind");

-- CreateIndex
CREATE INDEX "Evidence_sha256_idx" ON "Evidence"("sha256");

-- CreateIndex
CREATE INDEX "RecoveryLedgerEntry_tenantId_occurredAt_idx" ON "RecoveryLedgerEntry"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "RecoveryLedgerEntry_tenantId_entryType_idx" ON "RecoveryLedgerEntry"("tenantId", "entryType");

-- CreateIndex
CREATE INDEX "RecoveryLedgerEntry_caseId_idx" ON "RecoveryLedgerEntry"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelAccount_tenantId_channel_label_key" ON "ChannelAccount"("tenantId", "channel", "label");

-- CreateIndex
CREATE INDEX "ImportBatch_tenantId_channel_startedAt_idx" ON "ImportBatch"("tenantId", "channel", "startedAt");

-- AddForeignKey
ALTER TABLE "LossSignal" ADD CONSTRAINT "LossSignal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCase" ADD CONSTRAINT "RecoveryCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCase" ADD CONSTRAINT "RecoveryCase_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "SubAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseSignal" ADD CONSTRAINT "CaseSignal_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "RecoveryCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseSignal" ADD CONSTRAINT "CaseSignal_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "LossSignal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "RecoveryCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_parentClaimId_fkey" FOREIGN KEY ("parentClaimId") REFERENCES "Claim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "RecoveryCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryLedgerEntry" ADD CONSTRAINT "RecoveryLedgerEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryLedgerEntry" ADD CONSTRAINT "RecoveryLedgerEntry_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "RecoveryCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryLedgerEntry" ADD CONSTRAINT "RecoveryLedgerEntry_voidsEntryId_fkey" FOREIGN KEY ("voidsEntryId") REFERENCES "RecoveryLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelAccount" ADD CONSTRAINT "ChannelAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
