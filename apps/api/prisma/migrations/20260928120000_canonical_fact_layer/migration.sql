-- ============================================================
-- C-0006-A Canonical Fact Layer (schema delta APPROVED WITH CHANGES)
-- ------------------------------------------------------------
-- Additive only: two new tables, one nullable column, FKs and indexes.
-- NO destructive change, NO change to existing dedupeKey semantics.
-- ============================================================

-- CreateEnum
CREATE TYPE "CanonicalFactStatus" AS ENUM ('ACTIVE', 'CONFLICT');

-- CreateTable
CREATE TABLE "CanonicalFact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "domain" "RecoveryDomain" NOT NULL,
    "channel" "Channel" NOT NULL,
    "factKey" TEXT NOT NULL,
    "referenceType" TEXT,
    "externalId" TEXT,
    "occurredAt" TIMESTAMP(3),
    "amount" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "CanonicalFactStatus" NOT NULL DEFAULT 'ACTIVE',
    "sourceCount" INTEGER NOT NULL DEFAULT 0,
    "confirmedAcrossModes" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanonicalFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CanonicalFactSource" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "canonicalFactId" TEXT NOT NULL,
    "sourceTransactionId" TEXT NOT NULL,
    "connectionKind" "SourceConnectionKind",
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CanonicalFactSource_pkey" PRIMARY KEY ("id")
);

-- AlterTable (additive, nullable)
ALTER TABLE "RuleEvaluation" ADD COLUMN "canonicalFactId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CanonicalFact_organizationId_factKey_key" ON "CanonicalFact"("organizationId", "factKey");

-- CreateIndex
CREATE UNIQUE INDEX "CanonicalFact_organizationId_id_key" ON "CanonicalFact"("organizationId", "id");

-- CreateIndex
CREATE INDEX "CanonicalFact_organizationId_domain_channel_occurredAt_idx" ON "CanonicalFact"("organizationId", "domain", "channel", "occurredAt");

-- CreateIndex
CREATE INDEX "CanonicalFact_organizationId_status_idx" ON "CanonicalFact"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CanonicalFactSource_canonicalFactId_sourceTransactionId_key" ON "CanonicalFactSource"("canonicalFactId", "sourceTransactionId");

-- CreateIndex
CREATE INDEX "CanonicalFactSource_organizationId_sourceTransactionId_idx" ON "CanonicalFactSource"("organizationId", "sourceTransactionId");

-- CreateIndex
CREATE INDEX "RuleEvaluation_organizationId_canonicalFactId_idx" ON "RuleEvaluation"("organizationId", "canonicalFactId");

-- AddForeignKey
ALTER TABLE "CanonicalFact" ADD CONSTRAINT "CanonicalFact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanonicalFactSource" ADD CONSTRAINT "CanonicalFactSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanonicalFactSource" ADD CONSTRAINT "CanonicalFactSource_canonicalFactId_fkey" FOREIGN KEY ("canonicalFactId") REFERENCES "CanonicalFact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanonicalFactSource" ADD CONSTRAINT "CanonicalFactSource_sourceTransactionId_fkey" FOREIGN KEY ("sourceTransactionId") REFERENCES "SourceTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleEvaluation" ADD CONSTRAINT "RuleEvaluation_canonicalFactId_fkey" FOREIGN KEY ("canonicalFactId") REFERENCES "CanonicalFact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 租户完整性（与既有 cc_tenant_* 触发器共用同一函数）：
-- CanonicalFactSource 是本次唯一带跨表引用的新表。
CREATE TRIGGER cc_tenant_CanonicalFactSource
  BEFORE INSERT OR UPDATE ON "CanonicalFactSource"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'canonicalFactId', 'CanonicalFact',
    'sourceTransactionId', 'SourceTransaction'
  );
