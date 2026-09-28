-- ============================================================
-- C-0006-B2 Step 1: RuleEvaluation identity prepare (schema only)
-- ------------------------------------------------------------
-- Approved conditionally: additive column + nullable unique
-- constraints + index. NO backfill, NO dedupeKey change,
-- NO detection switch, NO destructive statement.
-- ============================================================

-- AlterTable (additive, nullable)
ALTER TABLE "RuleEvaluation" ADD COLUMN "canonicalDedupeKey" TEXT;

-- CreateIndex (业务事实身份；NULL 不受约束)
CREATE UNIQUE INDEX "RuleEvaluation_organizationId_ruleVersionId_canonicalFactId_key" ON "RuleEvaluation"("organizationId", "ruleVersionId", "canonicalFactId");

-- CreateIndex (secondary integrity constraint)
CREATE UNIQUE INDEX "RuleEvaluation_canonicalDedupeKey_key" ON "RuleEvaluation"("canonicalDedupeKey");

-- CreateIndex
CREATE INDEX "RuleEvaluation_organizationId_canonicalDedupeKey_idx" ON "RuleEvaluation"("organizationId", "canonicalDedupeKey");
