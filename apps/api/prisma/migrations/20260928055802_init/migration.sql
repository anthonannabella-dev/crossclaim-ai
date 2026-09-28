-- CreateEnum
CREATE TYPE "RecoveryDomain" AS ENUM ('PLATFORM', 'LOGISTICS', 'CUSTOMS');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('AMAZON_FBA', 'AMAZON_OTHER', 'UPS', 'FEDEX', 'DHL', 'FREIGHT_FORWARDER', 'INSURANCE', 'CUSTOMS_BROKER', 'OTHER');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'OPS', 'FINANCE', 'VIEWER');

-- CreateEnum
CREATE TYPE "SourceConnectionKind" AS ENUM ('FILE_UPLOAD', 'API', 'SFTP', 'EMAIL', 'MANUAL');

-- CreateEnum
CREATE TYPE "SourceConnectionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'NEEDS_AUTH', 'ERROR', 'REVOKED');

-- CreateEnum
CREATE TYPE "FileKind" AS ENUM ('PDF', 'XLSX', 'CSV', 'DOCX', 'IMAGE', 'XML', 'OTHER');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PENDING', 'PARSING', 'IMPORTED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('DETECTED', 'QUALIFIED', 'REJECTED', 'CONVERTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('OPEN', 'COLLECTING_EVIDENCE', 'READY_TO_CLAIM', 'CLAIMED', 'APPEALING', 'WON', 'PARTIALLY_WON', 'LOST', 'SETTLED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'ACKNOWLEDGED', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'NO_RESPONSE', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'UPHELD', 'OVERTURNED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('CONTRACT', 'RATE_CARD', 'INVOICE', 'CREDIT_NOTE', 'TRACKING', 'POD', 'EMAIL', 'CUSTOMS_DOC', 'BROKER_CORRESPONDENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "GraphNodeType" AS ENUM ('ORGANIZATION', 'CHANNEL', 'ACCOUNT', 'SHIPMENT', 'INVOICE', 'OPPORTUNITY', 'CASE', 'CLAIM', 'SETTLEMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "GraphEdgeType" AS ENUM ('CAUSES', 'RELATED_TO', 'DUPLICATES', 'DERIVED_FROM', 'RESPONSIBLE_FOR', 'SAME_SHIPMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "EvidenceEdgeType" AS ENUM ('SUPPORTS', 'REFUTES', 'CONTEXT_FOR', 'DUPLICATES', 'OTHER');

-- CreateEnum
CREATE TYPE "RouteTarget" AS ENUM ('PLATFORM', 'CARRIER', 'FREIGHT_FORWARDER', 'INSURER', 'CUSTOMS_AUTHORITY', 'CUSTOMS_BROKER', 'CUSTOMER_SELF', 'NONE');

-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'EXECUTED', 'FAILED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "RuleScope" AS ENUM ('PLATFORM_FEE', 'FREIGHT_RATE', 'SLA', 'DIM_WEIGHT', 'FUEL_SURCHARGE', 'ACCESSORIAL', 'DUPLICATE_CHARGE', 'INSURANCE', 'CUSTOMS_DUTY', 'OTHER');

-- CreateEnum
CREATE TYPE "RuleTier" AS ENUM ('CUSTOMER_CONTRACT', 'CUSTOMER_RATE_CARD', 'CARRIER_TARIFF', 'DATED_POLICY', 'DEFAULT');

-- CreateEnum
CREATE TYPE "RuleOwnerType" AS ENUM ('SYSTEM', 'TENANT');

-- CreateEnum
CREATE TYPE "RuleEvaluationResult" AS ENUM ('PASS', 'OPPORTUNITY', 'NEEDS_MORE_DATA', 'ERROR');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('EXPECTED', 'RECEIVED', 'PARTIAL', 'DISPUTED', 'VOID');

-- CreateEnum
CREATE TYPE "SettlementSource" AS ENUM ('PLATFORM_CREDIT', 'CARRIER_CREDIT', 'INSURER_PAYOUT', 'BANK_TRANSFER', 'CHECK', 'OFFSET', 'OTHER');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('DISCOVERED', 'RECOVERED', 'ADJUSTMENT', 'REVERSAL', 'WRITE_OFF');

-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'PARTIALLY_PAID', 'VOID', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "FeeBasis" AS ENUM ('RECOVERED_AMOUNT_PCT', 'FIXED', 'TIERED', 'NONE');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SYSTEM', 'AI', 'EXTERNAL');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "plan" TEXT NOT NULL DEFAULT 'TRIAL',
    "locale" TEXT NOT NULL DEFAULT 'zh-CN',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL DEFAULT 'VIEWER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "invitedBy" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domain" "RecoveryDomain" NOT NULL,
    "channel" "Channel" NOT NULL,
    "kind" "SourceConnectionKind" NOT NULL,
    "status" "SourceConnectionStatus" NOT NULL DEFAULT 'NEEDS_AUTH',
    "label" TEXT NOT NULL,
    "credentialRef" TEXT,
    "config" JSONB,
    "lastSyncAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileAsset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT,
    "kind" "FileKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "uploadedBy" TEXT,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT,
    "fileAssetId" TEXT,
    "domain" "RecoveryDomain" NOT NULL,
    "channel" "Channel" NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING',
    "rowsTotal" INTEGER NOT NULL DEFAULT 0,
    "rowsOk" INTEGER NOT NULL DEFAULT 0,
    "rowsFailed" INTEGER NOT NULL DEFAULT 0,
    "columnMapping" JSONB,
    "errorReport" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdBy" TEXT,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceTransaction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT,
    "importBatchId" TEXT,
    "domain" "RecoveryDomain" NOT NULL,
    "channel" "Channel" NOT NULL,
    "externalId" TEXT,
    "referenceType" TEXT,
    "occurredAt" TIMESTAMP(3),
    "amount" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "dedupeKey" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryOpportunity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domain" "RecoveryDomain" NOT NULL,
    "channel" "Channel" NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'DETECTED',
    "opportunityType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "amountExpected" DECIMAL(18,4),
    "amountActual" DECIMAL(18,4),
    "recoverableAmount" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "confidence" DOUBLE PRECISION,
    "claimDeadline" TIMESTAMP(3),
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qualifiedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryGraphNode" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "nodeType" "GraphNodeType" NOT NULL,
    "refId" TEXT,
    "label" TEXT NOT NULL,
    "properties" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryGraphNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryGraphEdge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    "edgeType" "GraphEdgeType" NOT NULL,
    "weight" DOUBLE PRECISION,
    "properties" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryGraphEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceArtifact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "fileAssetId" TEXT,
    "connectionId" TEXT,
    "externalUrl" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "reliability" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceEdge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "edgeType" "EvidenceEdgeType" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseEvidence" (
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "role" TEXT,
    "addedBy" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseEvidence_pkey" PRIMARY KEY ("caseId","evidenceId")
);

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseNo" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "domain" "RecoveryDomain" NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'OPEN',
    "claimedAmount" DECIMAL(18,4),
    "recoveredAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "ownerUserId" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "workflowId" TEXT,
    "workflowRunId" TEXT,
    "nextActionAt" TIMESTAMP(3),
    "aiSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseOpportunity" (
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "CaseOpportunity_pkey" PRIMARY KEY ("caseId","opportunityId")
);

-- CreateTable
CREATE TABLE "RecoveryRoute" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT,
    "opportunityId" TEXT,
    "target" "RouteTarget" NOT NULL,
    "status" "RouteStatus" NOT NULL DEFAULT 'PROPOSED',
    "rationale" TEXT,
    "ruleVersionId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "status" "ClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "target" "RouteTarget" NOT NULL,
    "externalRef" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedBy" TEXT,
    "dueAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "responseAmount" DECIMAL(18,4),
    "responseNote" TEXT,
    "aiDraftText" TEXT,
    "finalText" TEXT,
    "attachmentKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appeal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 2,
    "status" "AppealStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "externalRef" TEXT,
    "dueAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "outcomeAmount" DECIMAL(18,4),
    "responseNote" TEXT,
    "aiDraftText" TEXT,
    "finalText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleSet" (
    "id" TEXT NOT NULL,
    "ownerType" "RuleOwnerType" NOT NULL,
    "ownerKey" TEXT NOT NULL,
    "organizationId" TEXT,
    "domain" "RecoveryDomain" NOT NULL,
    "channel" "Channel" NOT NULL,
    "scope" "RuleScope" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuleSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleVersion" (
    "id" TEXT NOT NULL,
    "ruleSetId" TEXT NOT NULL,
    "organizationId" TEXT,
    "tier" "RuleTier" NOT NULL,
    "source" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "lastVerified" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "definition" JSONB NOT NULL,
    "legalBasis" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleEvaluation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ruleVersionId" TEXT NOT NULL,
    "sourceTransactionId" TEXT,
    "opportunityId" TEXT,
    "result" "RuleEvaluationResult" NOT NULL,
    "computed" JSONB NOT NULL,
    "message" TEXT,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupeKey" TEXT,

    CONSTRAINT "RuleEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT,
    "status" "SettlementStatus" NOT NULL DEFAULT 'EXPECTED',
    "source" "SettlementSource" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "receivedAt" TIMESTAMP(3),
    "externalRef" TEXT,
    "evidenceId" TEXT,
    "confirmedBy" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryLedgerEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT,
    "opportunityId" TEXT,
    "settlementId" TEXT,
    "entryType" "LedgerEntryType" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "counterparty" TEXT,
    "reference" TEXT,
    "voidsEntryId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingInvoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "caseId" TEXT,
    "invoiceNo" TEXT NOT NULL,
    "status" "BillingStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(18,4) NOT NULL,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paidAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeCalculation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "billingInvoiceId" TEXT,
    "settlementId" TEXT,
    "caseId" TEXT,
    "basis" "FeeBasis" NOT NULL,
    "rate" DECIMAL(9,6),
    "baseAmount" DECIMAL(18,4) NOT NULL,
    "feeAmount" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "computation" JSONB NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeCalculation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "changes" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Organization_status_idx" ON "Organization"("status");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE INDEX "Membership_organizationId_role_idx" ON "Membership"("organizationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_organizationId_userId_key" ON "Membership"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_organizationId_id_key" ON "Membership"("organizationId", "id");

-- CreateIndex
CREATE INDEX "SourceConnection_organizationId_status_idx" ON "SourceConnection"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SourceConnection_organizationId_channel_label_key" ON "SourceConnection"("organizationId", "channel", "label");

-- CreateIndex
CREATE UNIQUE INDEX "SourceConnection_organizationId_id_key" ON "SourceConnection"("organizationId", "id");

-- CreateIndex
CREATE INDEX "FileAsset_organizationId_sha256_idx" ON "FileAsset"("organizationId", "sha256");

-- CreateIndex
CREATE INDEX "FileAsset_organizationId_createdAt_idx" ON "FileAsset"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FileAsset_organizationId_id_key" ON "FileAsset"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ImportBatch_organizationId_channel_startedAt_idx" ON "ImportBatch"("organizationId", "channel", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_organizationId_id_key" ON "ImportBatch"("organizationId", "id");

-- CreateIndex
CREATE INDEX "SourceTransaction_organizationId_channel_occurredAt_idx" ON "SourceTransaction"("organizationId", "channel", "occurredAt");

-- CreateIndex
CREATE INDEX "SourceTransaction_organizationId_externalId_idx" ON "SourceTransaction"("organizationId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceTransaction_organizationId_dedupeKey_key" ON "SourceTransaction"("organizationId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "SourceTransaction_organizationId_id_key" ON "SourceTransaction"("organizationId", "id");

-- CreateIndex
CREATE INDEX "RecoveryOpportunity_organizationId_status_idx" ON "RecoveryOpportunity"("organizationId", "status");

-- CreateIndex
CREATE INDEX "RecoveryOpportunity_organizationId_channel_detectedAt_idx" ON "RecoveryOpportunity"("organizationId", "channel", "detectedAt");

-- CreateIndex
CREATE INDEX "RecoveryOpportunity_organizationId_claimDeadline_idx" ON "RecoveryOpportunity"("organizationId", "claimDeadline");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryOpportunity_organizationId_id_key" ON "RecoveryOpportunity"("organizationId", "id");

-- CreateIndex
CREATE INDEX "RecoveryGraphNode_organizationId_refId_idx" ON "RecoveryGraphNode"("organizationId", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryGraphNode_organizationId_nodeType_refId_key" ON "RecoveryGraphNode"("organizationId", "nodeType", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryGraphNode_organizationId_id_key" ON "RecoveryGraphNode"("organizationId", "id");

-- CreateIndex
CREATE INDEX "RecoveryGraphEdge_organizationId_edgeType_idx" ON "RecoveryGraphEdge"("organizationId", "edgeType");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryGraphEdge_fromNodeId_toNodeId_edgeType_key" ON "RecoveryGraphEdge"("fromNodeId", "toNodeId", "edgeType");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryGraphEdge_organizationId_id_key" ON "RecoveryGraphEdge"("organizationId", "id");

-- CreateIndex
CREATE INDEX "EvidenceArtifact_organizationId_kind_idx" ON "EvidenceArtifact"("organizationId", "kind");

-- CreateIndex
CREATE INDEX "EvidenceArtifact_organizationId_fileAssetId_idx" ON "EvidenceArtifact"("organizationId", "fileAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceArtifact_organizationId_id_key" ON "EvidenceArtifact"("organizationId", "id");

-- CreateIndex
CREATE INDEX "EvidenceEdge_organizationId_edgeType_idx" ON "EvidenceEdge"("organizationId", "edgeType");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceEdge_fromId_toId_edgeType_key" ON "EvidenceEdge"("fromId", "toId", "edgeType");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceEdge_organizationId_id_key" ON "EvidenceEdge"("organizationId", "id");

-- CreateIndex
CREATE INDEX "CaseEvidence_organizationId_evidenceId_idx" ON "CaseEvidence"("organizationId", "evidenceId");

-- CreateIndex
CREATE INDEX "Case_organizationId_status_idx" ON "Case"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Case_organizationId_nextActionAt_idx" ON "Case"("organizationId", "nextActionAt");

-- CreateIndex
CREATE INDEX "Case_workflowId_idx" ON "Case"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "Case_organizationId_caseNo_key" ON "Case"("organizationId", "caseNo");

-- CreateIndex
CREATE UNIQUE INDEX "Case_organizationId_id_key" ON "Case"("organizationId", "id");

-- CreateIndex
CREATE INDEX "CaseOpportunity_organizationId_opportunityId_idx" ON "CaseOpportunity"("organizationId", "opportunityId");

-- CreateIndex
CREATE INDEX "RecoveryRoute_organizationId_status_idx" ON "RecoveryRoute"("organizationId", "status");

-- CreateIndex
CREATE INDEX "RecoveryRoute_caseId_idx" ON "RecoveryRoute"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryRoute_organizationId_id_key" ON "RecoveryRoute"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Claim_organizationId_caseId_round_idx" ON "Claim"("organizationId", "caseId", "round");

-- CreateIndex
CREATE INDEX "Claim_dueAt_respondedAt_idx" ON "Claim"("dueAt", "respondedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_organizationId_id_key" ON "Claim"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Appeal_organizationId_claimId_round_idx" ON "Appeal"("organizationId", "claimId", "round");

-- CreateIndex
CREATE UNIQUE INDEX "Appeal_organizationId_id_key" ON "Appeal"("organizationId", "id");

-- CreateIndex
CREATE INDEX "RuleSet_organizationId_isActive_idx" ON "RuleSet"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "RuleSet_ownerType_channel_scope_idx" ON "RuleSet"("ownerType", "channel", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "RuleSet_ownerKey_channel_scope_name_key" ON "RuleSet"("ownerKey", "channel", "scope", "name");

-- CreateIndex
CREATE INDEX "RuleVersion_effectiveFrom_effectiveTo_idx" ON "RuleVersion"("effectiveFrom", "effectiveTo");

-- CreateIndex
CREATE INDEX "RuleVersion_organizationId_isActive_idx" ON "RuleVersion"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RuleVersion_ruleSetId_version_tier_key" ON "RuleVersion"("ruleSetId", "version", "tier");

-- CreateIndex
CREATE UNIQUE INDEX "RuleVersion_organizationId_id_key" ON "RuleVersion"("organizationId", "id");

-- CreateIndex
CREATE INDEX "RuleEvaluation_organizationId_ruleVersionId_evaluatedAt_idx" ON "RuleEvaluation"("organizationId", "ruleVersionId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "RuleEvaluation_organizationId_opportunityId_idx" ON "RuleEvaluation"("organizationId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "RuleEvaluation_dedupeKey_key" ON "RuleEvaluation"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "RuleEvaluation_organizationId_id_key" ON "RuleEvaluation"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Settlement_organizationId_status_receivedAt_idx" ON "Settlement"("organizationId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "Settlement_caseId_idx" ON "Settlement"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_organizationId_id_key" ON "Settlement"("organizationId", "id");

-- CreateIndex
CREATE INDEX "RecoveryLedgerEntry_organizationId_occurredAt_idx" ON "RecoveryLedgerEntry"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "RecoveryLedgerEntry_organizationId_entryType_idx" ON "RecoveryLedgerEntry"("organizationId", "entryType");

-- CreateIndex
CREATE INDEX "RecoveryLedgerEntry_caseId_idx" ON "RecoveryLedgerEntry"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryLedgerEntry_organizationId_id_key" ON "RecoveryLedgerEntry"("organizationId", "id");

-- CreateIndex
CREATE INDEX "BillingInvoice_organizationId_status_dueAt_idx" ON "BillingInvoice"("organizationId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingInvoice_organizationId_invoiceNo_key" ON "BillingInvoice"("organizationId", "invoiceNo");

-- CreateIndex
CREATE UNIQUE INDEX "BillingInvoice_organizationId_id_key" ON "BillingInvoice"("organizationId", "id");

-- CreateIndex
CREATE INDEX "FeeCalculation_organizationId_billingInvoiceId_idx" ON "FeeCalculation"("organizationId", "billingInvoiceId");

-- CreateIndex
CREATE INDEX "FeeCalculation_organizationId_settlementId_idx" ON "FeeCalculation"("organizationId", "settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "FeeCalculation_organizationId_id_key" ON "FeeCalculation"("organizationId", "id");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceConnection" ADD CONSTRAINT "SourceConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAsset" ADD CONSTRAINT "FileAsset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileAsset" ADD CONSTRAINT "FileAsset_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SourceConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SourceConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceTransaction" ADD CONSTRAINT "SourceTransaction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceTransaction" ADD CONSTRAINT "SourceTransaction_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SourceConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceTransaction" ADD CONSTRAINT "SourceTransaction_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryOpportunity" ADD CONSTRAINT "RecoveryOpportunity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryGraphNode" ADD CONSTRAINT "RecoveryGraphNode_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryGraphEdge" ADD CONSTRAINT "RecoveryGraphEdge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryGraphEdge" ADD CONSTRAINT "RecoveryGraphEdge_fromNodeId_fkey" FOREIGN KEY ("fromNodeId") REFERENCES "RecoveryGraphNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryGraphEdge" ADD CONSTRAINT "RecoveryGraphEdge_toNodeId_fkey" FOREIGN KEY ("toNodeId") REFERENCES "RecoveryGraphNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceArtifact" ADD CONSTRAINT "EvidenceArtifact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceArtifact" ADD CONSTRAINT "EvidenceArtifact_fileAssetId_fkey" FOREIGN KEY ("fileAssetId") REFERENCES "FileAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceArtifact" ADD CONSTRAINT "EvidenceArtifact_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SourceConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceEdge" ADD CONSTRAINT "EvidenceEdge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceEdge" ADD CONSTRAINT "EvidenceEdge_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "EvidenceArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceEdge" ADD CONSTRAINT "EvidenceEdge_toId_fkey" FOREIGN KEY ("toId") REFERENCES "EvidenceArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseEvidence" ADD CONSTRAINT "CaseEvidence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseEvidence" ADD CONSTRAINT "CaseEvidence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseEvidence" ADD CONSTRAINT "CaseEvidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "EvidenceArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseOpportunity" ADD CONSTRAINT "CaseOpportunity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseOpportunity" ADD CONSTRAINT "CaseOpportunity_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseOpportunity" ADD CONSTRAINT "CaseOpportunity_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "RecoveryOpportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryRoute" ADD CONSTRAINT "RecoveryRoute_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryRoute" ADD CONSTRAINT "RecoveryRoute_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryRoute" ADD CONSTRAINT "RecoveryRoute_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "RecoveryOpportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryRoute" ADD CONSTRAINT "RecoveryRoute_ruleVersionId_fkey" FOREIGN KEY ("ruleVersionId") REFERENCES "RuleVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleSet" ADD CONSTRAINT "RuleSet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleVersion" ADD CONSTRAINT "RuleVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleVersion" ADD CONSTRAINT "RuleVersion_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "RuleSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleEvaluation" ADD CONSTRAINT "RuleEvaluation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleEvaluation" ADD CONSTRAINT "RuleEvaluation_ruleVersionId_fkey" FOREIGN KEY ("ruleVersionId") REFERENCES "RuleVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleEvaluation" ADD CONSTRAINT "RuleEvaluation_sourceTransactionId_fkey" FOREIGN KEY ("sourceTransactionId") REFERENCES "SourceTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleEvaluation" ADD CONSTRAINT "RuleEvaluation_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "RecoveryOpportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "EvidenceArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryLedgerEntry" ADD CONSTRAINT "RecoveryLedgerEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryLedgerEntry" ADD CONSTRAINT "RecoveryLedgerEntry_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryLedgerEntry" ADD CONSTRAINT "RecoveryLedgerEntry_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "RecoveryOpportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryLedgerEntry" ADD CONSTRAINT "RecoveryLedgerEntry_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryLedgerEntry" ADD CONSTRAINT "RecoveryLedgerEntry_voidsEntryId_fkey" FOREIGN KEY ("voidsEntryId") REFERENCES "RecoveryLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCalculation" ADD CONSTRAINT "FeeCalculation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCalculation" ADD CONSTRAINT "FeeCalculation_billingInvoiceId_fkey" FOREIGN KEY ("billingInvoiceId") REFERENCES "BillingInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCalculation" ADD CONSTRAINT "FeeCalculation_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCalculation" ADD CONSTRAINT "FeeCalculation_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
