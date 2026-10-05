-- ============================================================
-- SI-COST-OPTIMIZATION C2 FINAL-2（MSG-20261005-34 CHANGE C）
-- 追加 DB 不变量（防止绕过 service 写坏 append-only 成本事实 / 预算配置）
-- ============================================================
ALTER TABLE "AiCostLedgerEntry"
  ADD CONSTRAINT "AiCostLedgerEntry_costMicros_nonneg" CHECK ("costMicros" >= 0),
  ADD CONSTRAINT "AiCostLedgerEntry_inputTokens_nonneg" CHECK ("inputTokens" >= 0),
  ADD CONSTRAINT "AiCostLedgerEntry_outputTokens_nonneg" CHECK ("outputTokens" >= 0),
  ADD CONSTRAINT "AiCostLedgerEntry_latencyMs_nonneg" CHECK ("latencyMs" >= 0),
  ADD CONSTRAINT "AiCostLedgerEntry_attemptNo_positive" CHECK ("attemptNo" > 0);

ALTER TABLE "AiBudgetPolicy"
  ADD CONSTRAINT "AiBudgetPolicy_daily_nonneg" CHECK ("dailyLimitMicros" IS NULL OR "dailyLimitMicros" >= 0),
  ADD CONSTRAINT "AiBudgetPolicy_monthly_nonneg" CHECK ("monthlyLimitMicros" IS NULL OR "monthlyLimitMicros" >= 0),
  ADD CONSTRAINT "AiBudgetPolicy_incident_nonneg" CHECK ("perIncidentLimitMicros" IS NULL OR "perIncidentLimitMicros" >= 0),
  ADD CONSTRAINT "AiBudgetPolicy_strong_nonneg" CHECK ("strongCallLimit" IS NULL OR "strongCallLimit" >= 0),
  ADD CONSTRAINT "AiBudgetPolicy_token_nonneg" CHECK ("tokenLimit" IS NULL OR "tokenLimit" >= 0),
  ADD CONSTRAINT "AiBudgetPolicy_concurrency_nonneg" CHECK ("concurrencyLimit" IS NULL OR "concurrencyLimit" >= 0);

-- 回滚（人工）：ALTER TABLE ... DROP CONSTRAINT ...（见上）
