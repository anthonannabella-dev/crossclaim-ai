CREATE TABLE "Declaration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "declarationNo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "customsMode" TEXT NOT NULL DEFAULT 'normal',
    "supervisionCode" TEXT,
    "taxMethod" TEXT,
    "declarationJson" TEXT NOT NULL,
    "itemsJson" TEXT NOT NULL,
    "totalValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT DEFAULT 'USD',
    "score" INTEGER,
    "preCheckPassed" BOOLEAN,
    "rejectionCode" TEXT,
    "rejectionReason" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "resubmittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "subAccountId" TEXT,

    CONSTRAINT "Declaration_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Declaration_tenantId_status_idx" ON "Declaration"("tenantId", "status");
CREATE INDEX "Declaration_tenantId_customsMode_idx" ON "Declaration"("tenantId", "customsMode");
CREATE INDEX "Declaration_tenantId_createdAt_idx" ON "Declaration"("tenantId", "createdAt");

ALTER TABLE "Declaration" ADD CONSTRAINT "Declaration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Declaration" ADD CONSTRAINT "Declaration_subAccountId_fkey" FOREIGN KEY ("subAccountId") REFERENCES "SubAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
