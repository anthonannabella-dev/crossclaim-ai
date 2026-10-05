-- ============================================================
-- SI-COST-OPTIMIZATION C2 FINAL-3（MSG-20261005-35 CHANGE B）
-- 预算 policy 的 tenant 绑定：非 PLATFORM scope 必须有 organizationId（fail-closed at DB）
-- ============================================================
ALTER TABLE "AiBudgetPolicy"
  ADD CONSTRAINT "AiBudgetPolicy_tenant_binding_required"
  CHECK ("scope" = 'PLATFORM' OR "organizationId" IS NOT NULL);

-- 回滚（人工）：ALTER TABLE "AiBudgetPolicy" DROP CONSTRAINT "AiBudgetPolicy_tenant_binding_required";
