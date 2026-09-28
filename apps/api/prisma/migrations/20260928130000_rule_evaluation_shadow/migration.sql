-- ============================================================
-- C-0006-B1 RuleEvaluationShadow (schema delta APPROVED WITH REVISIONS)
-- ------------------------------------------------------------
-- Additive only: one new table + indexes + FKs + tenant trigger.
-- RuleEvaluation / dedupeKey / Opportunity are NOT touched.
-- ============================================================

-- CreateTable
CREATE TABLE "RuleEvaluationShadow" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "ruleVersionId" TEXT NOT NULL,
    "canonicalFactId" TEXT NOT NULL,
    "representativeTransactionId" TEXT,
    "result" "RuleEvaluationResult" NOT NULL,
    "computed" JSONB NOT NULL,
    "message" TEXT,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupeKeyShadow" TEXT NOT NULL,

    CONSTRAINT "RuleEvaluationShadow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RuleEvaluationShadow_dedupeKeyShadow_key" ON "RuleEvaluationShadow"("dedupeKeyShadow");

-- CreateIndex
CREATE UNIQUE INDEX "RuleEvaluationShadow_organizationId_id_key" ON "RuleEvaluationShadow"("organizationId", "id");

-- CreateIndex
CREATE INDEX "RuleEvaluationShadow_organizationId_runId_idx" ON "RuleEvaluationShadow"("organizationId", "runId");

-- CreateIndex
CREATE INDEX "RuleEvaluationShadow_organizationId_ruleVersionId_evaluatedAt_idx" ON "RuleEvaluationShadow"("organizationId", "ruleVersionId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "RuleEvaluationShadow_organizationId_canonicalFactId_idx" ON "RuleEvaluationShadow"("organizationId", "canonicalFactId");

-- AddForeignKey
ALTER TABLE "RuleEvaluationShadow" ADD CONSTRAINT "RuleEvaluationShadow_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleEvaluationShadow" ADD CONSTRAINT "RuleEvaluationShadow_ruleVersionId_fkey" FOREIGN KEY ("ruleVersionId") REFERENCES "RuleVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleEvaluationShadow" ADD CONSTRAINT "RuleEvaluationShadow_canonicalFactId_fkey" FOREIGN KEY ("canonicalFactId") REFERENCES "CanonicalFact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleEvaluationShadow" ADD CONSTRAINT "RuleEvaluationShadow_representativeTransactionId_fkey" FOREIGN KEY ("representativeTransactionId") REFERENCES "SourceTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 租户完整性：影子表同样受 cc_tenant_* 保护
CREATE TRIGGER cc_tenant_RuleEvaluationShadow
  BEFORE INSERT OR UPDATE ON "RuleEvaluationShadow"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity(
    'ruleVersionId', 'RuleVersion',
    'canonicalFactId', 'CanonicalFact',
    'representativeTransactionId', 'SourceTransaction'
  );
