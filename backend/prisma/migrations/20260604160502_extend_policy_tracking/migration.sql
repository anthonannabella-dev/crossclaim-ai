-- ExtendPolicyTracking
-- Adds: Tenant.preferredPorts, Tenant.hsCodeRanges
-- Adds: PolicyAlert.portCode, PolicyAlert.sourceType, PolicyAlert indexes

-- Tenant table: add business config fields
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "preferredPorts" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "hsCodeRanges" TEXT;

-- PolicyAlert table: add port/source tracking fields
ALTER TABLE "PolicyAlert" ADD COLUMN IF NOT EXISTS "portCode" TEXT;
ALTER TABLE "PolicyAlert" ADD COLUMN IF NOT EXISTS "sourceType" TEXT NOT NULL DEFAULT 'NATIONAL';

-- Set existing records: assume they're national if no port override
UPDATE "PolicyAlert" SET "sourceType" = 'NATIONAL' WHERE "sourceType" IS NULL;

-- Add indexes for faster queries
CREATE INDEX IF NOT EXISTS "PolicyAlert_portCode_idx" ON "PolicyAlert" ("portCode");
CREATE INDEX IF NOT EXISTS "PolicyAlert_sourceType_idx" ON "PolicyAlert" ("sourceType");
CREATE INDEX IF NOT EXISTS "PolicyAlert_category_idx" ON "PolicyAlert" ("category");
