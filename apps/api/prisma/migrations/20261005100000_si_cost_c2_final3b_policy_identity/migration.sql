-- ============================================================
-- SI-COST-OPTIMIZATION C2 FINAL-3b：预算 policy 身份补 tenant 维度
-- 目的：同 scopeRef 在不同 tenant 下必须能各自存在（不得互相覆盖/串用）
-- organizationId 非空（PLATFORM 用 '' 哨兵）；唯一键 = (scope, scopeRef, organizationId)
-- ============================================================
UPDATE "AiBudgetPolicy" SET "organizationId" = '' WHERE "organizationId" IS NULL;
ALTER TABLE "AiBudgetPolicy" ALTER COLUMN "organizationId" SET DEFAULT '';
ALTER TABLE "AiBudgetPolicy" ALTER COLUMN "organizationId" SET NOT NULL;

DROP INDEX IF EXISTS "AiBudgetPolicy_scope_scopeRef_key";
CREATE UNIQUE INDEX "AiBudgetPolicy_scope_scopeRef_organizationId_key"
  ON "AiBudgetPolicy"("scope", "scopeRef", "organizationId");

ALTER TABLE "AiBudgetPolicy" DROP CONSTRAINT IF EXISTS "AiBudgetPolicy_tenant_binding_required";
ALTER TABLE "AiBudgetPolicy"
  ADD CONSTRAINT "AiBudgetPolicy_tenant_binding_required"
  CHECK (
    ("scope" = 'PLATFORM' AND "organizationId" = '')
    OR ("scope" <> 'PLATFORM' AND "organizationId" <> '')
  );

-- 回滚（人工）：恢复 NULL 语义与 (scope, scopeRef) 唯一键
