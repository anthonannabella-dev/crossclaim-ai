-- Add projectTag and contractNo to Document table
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "projectTag" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "contractNo" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "auditPassed" BOOLEAN;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "auditScore" INTEGER;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "auditSummary" TEXT;
