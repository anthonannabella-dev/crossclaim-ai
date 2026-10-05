-- ============================================================
-- SI-COST-OPTIMIZATION C2（授权：MSG-20261005-33；设计：MSG-20261005-30）
-- 1) AiCostLedgerEntry —— durable append-only 成本事实（usage 的唯一事实源；costMicros INTEGER）
-- 2) AiBudgetPolicy     —— durable 分级预算配置（PLATFORM → ORGANIZATION → ACCOUNT → INCIDENT/TASK）
--                          注意：**不建 usage 表**（AiBudgetUsage = FORBIDDEN；用量永远由账本聚合）
-- 3) AiModelCacheEntry  —— 确定性缓存（可丢弃派生数据；受控 TTL/GC；identity 不可原地改写）
-- 触发器：tenant 基线 + organizationId 不可变 + 账本 append-only + 缓存 identity 不可变
-- 清单同步：tools/tenant-triggers/required-triggers.json 与 append-only-triggers.json
-- ============================================================

-- ---------- 1) 成本账本（append-only 事实） ----------
CREATE TABLE "AiCostLedgerEntry" (
  "id"             TEXT           NOT NULL,
  "callId"         TEXT           NOT NULL,
  "incidentId"     TEXT,
  "taskId"         TEXT,
  "organizationId" TEXT,
  "accountId"      TEXT,
  "provider"       TEXT           NOT NULL,
  "model"          TEXT           NOT NULL,
  "executionLevel" TEXT           NOT NULL,
  "taskType"       TEXT           NOT NULL,
  "inputTokens"    INTEGER        NOT NULL DEFAULT 0,
  "outputTokens"   INTEGER        NOT NULL DEFAULT 0,
  "costMicros"     INTEGER        NOT NULL DEFAULT 0,
  "latencyMs"      INTEGER        NOT NULL DEFAULT 0,
  "result"         TEXT           NOT NULL,
  "attemptNo"      INTEGER        NOT NULL DEFAULT 1,
  "createdAt"      TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiCostLedgerEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiCostLedgerEntry_callId_key" ON "AiCostLedgerEntry"("callId");
CREATE INDEX "AiCostLedgerEntry_organizationId_createdAt_idx" ON "AiCostLedgerEntry"("organizationId", "createdAt");
CREATE INDEX "AiCostLedgerEntry_incidentId_createdAt_idx" ON "AiCostLedgerEntry"("incidentId", "createdAt");
CREATE INDEX "AiCostLedgerEntry_taskId_createdAt_idx" ON "AiCostLedgerEntry"("taskId", "createdAt");

-- append-only：UPDATE / DELETE 一律拒绝（成本事实不可改写）
CREATE OR REPLACE FUNCTION "cc_ai_cost_ledger_append_only"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'AI_COST_LEDGER_APPEND_ONLY: AiCostLedgerEntry rows must not be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_append_only__AiCostLedgerEntry" ON "AiCostLedgerEntry";
CREATE TRIGGER "cc_append_only__AiCostLedgerEntry"
  BEFORE UPDATE OR DELETE ON "AiCostLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "cc_ai_cost_ledger_append_only"();

-- ---------- 2) 分级预算配置 ----------
CREATE TYPE "AiBudgetScope" AS ENUM ('PLATFORM', 'ORGANIZATION', 'ACCOUNT', 'INCIDENT', 'TASK');

CREATE TABLE "AiBudgetPolicy" (
  "id"                     TEXT           NOT NULL,
  "scope"                  "AiBudgetScope" NOT NULL,
  "scopeRef"               TEXT           NOT NULL,
  "organizationId"         TEXT,
  "dailyLimitMicros"       INTEGER,
  "monthlyLimitMicros"     INTEGER,
  "perIncidentLimitMicros" INTEGER,
  "strongCallLimit"        INTEGER,
  "tokenLimit"             INTEGER,
  "concurrencyLimit"       INTEGER,
  "createdAt"              TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiBudgetPolicy_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiBudgetPolicy_scope_scopeRef_key" ON "AiBudgetPolicy"("scope", "scopeRef");
CREATE INDEX "AiBudgetPolicy_organizationId_idx" ON "AiBudgetPolicy"("organizationId");

-- ---------- 3) 确定性模型缓存 ----------
CREATE TABLE "AiModelCacheEntry" (
  "id"             TEXT         NOT NULL,
  "taskType"       TEXT         NOT NULL,
  "promptDigest"   TEXT         NOT NULL,
  "inputDigest"    TEXT         NOT NULL,
  "ruleVersion"    TEXT         NOT NULL,
  "schemaVersion"  TEXT         NOT NULL,
  "capabilityTier" TEXT         NOT NULL,
  "organizationId" TEXT         NOT NULL DEFAULT '',
  "resultDigest"   TEXT         NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  "lastServedAt"   TIMESTAMP(3),
  CONSTRAINT "AiModelCacheEntry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiModelCacheEntry_identity_key" ON "AiModelCacheEntry"(
  "taskType", "promptDigest", "inputDigest", "ruleVersion", "schemaVersion", "capabilityTier", "organizationId"
);
CREATE INDEX "AiModelCacheEntry_organizationId_expiresAt_idx" ON "AiModelCacheEntry"("organizationId", "expiresAt");
CREATE INDEX "AiModelCacheEntry_expiresAt_idx" ON "AiModelCacheEntry"("expiresAt");

-- identity 不可原地改写（只允许 expiresAt / lastServedAt 变化；DELETE 允许受控 TTL/GC）
CREATE OR REPLACE FUNCTION "cc_ai_model_cache_identity_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."taskType"       IS DISTINCT FROM OLD."taskType"
     OR NEW."promptDigest"   IS DISTINCT FROM OLD."promptDigest"
     OR NEW."inputDigest"    IS DISTINCT FROM OLD."inputDigest"
     OR NEW."ruleVersion"    IS DISTINCT FROM OLD."ruleVersion"
     OR NEW."schemaVersion"  IS DISTINCT FROM OLD."schemaVersion"
     OR NEW."capabilityTier" IS DISTINCT FROM OLD."capabilityTier"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."resultDigest"   IS DISTINCT FROM OLD."resultDigest"
  THEN
    RAISE EXCEPTION 'AI_MODEL_CACHE_IDENTITY_IMMUTABLE: identity/content must not be rewritten in place';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "cc_cache_identity_immutable__AiModelCacheEntry" ON "AiModelCacheEntry";
CREATE TRIGGER "cc_cache_identity_immutable__AiModelCacheEntry"
  BEFORE UPDATE ON "AiModelCacheEntry"
  FOR EACH ROW EXECUTE FUNCTION "cc_ai_model_cache_identity_immutable"();

-- ---------- 4) tenant 保护（基线 + organizationId 不可变） ----------
DROP TRIGGER IF EXISTS "cc_tenant_aicostledgerentry" ON "AiCostLedgerEntry";
CREATE TRIGGER "cc_tenant_aicostledgerentry"
  BEFORE INSERT OR UPDATE ON "AiCostLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_aibudgetpolicy" ON "AiBudgetPolicy";
CREATE TRIGGER "cc_tenant_aibudgetpolicy"
  BEFORE INSERT OR UPDATE ON "AiBudgetPolicy"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_aimodelcacheentry" ON "AiModelCacheEntry";
CREATE TRIGGER "cc_tenant_aimodelcacheentry"
  BEFORE INSERT OR UPDATE ON "AiModelCacheEntry"
  FOR EACH ROW EXECUTE FUNCTION crossclaim_assert_tenant_integrity();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__AiCostLedgerEntry" ON "AiCostLedgerEntry";
CREATE TRIGGER "cc_tenant_immutable__AiCostLedgerEntry"
  BEFORE UPDATE ON "AiCostLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__AiBudgetPolicy" ON "AiBudgetPolicy";
CREATE TRIGGER "cc_tenant_immutable__AiBudgetPolicy"
  BEFORE UPDATE ON "AiBudgetPolicy"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

DROP TRIGGER IF EXISTS "cc_tenant_immutable__AiModelCacheEntry" ON "AiModelCacheEntry";
CREATE TRIGGER "cc_tenant_immutable__AiModelCacheEntry"
  BEFORE UPDATE ON "AiModelCacheEntry"
  FOR EACH ROW EXECUTE FUNCTION cc_forbid_tenant_reassignment();

-- 回滚（人工）：DROP TRIGGER / DROP TABLE / DROP TYPE（见上）
